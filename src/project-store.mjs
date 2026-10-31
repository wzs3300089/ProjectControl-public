import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { normalizePlan, revalidatePlan } from './console/shared/aiplan.js';
import { todayISO } from './console/shared/analysis.js';
import { MAX_STATE_BYTES, StateError } from './console/server/upstream-store.js';
import { emptyHierarchy, migrateLegacy, sanitizeHierarchy, HIERARCHY_VERSION } from './console/server/hierarchy.js';
import { requirementRoute, normalizeCodexThread } from './console/shared/codex-thread.js';
import { clearChangedWorkspaceThreads, codexProjectKey } from './console/shared/hierarchy.js';

export { StateError };
export const DEFAULT_PROJECT_DATABASE = fileURLToPath(new URL('../data/projects.sqlite', import.meta.url));

const jsonObject = z.record(z.string(), z.unknown());
const requestId = z.string().trim().min(1).max(120);
const validDate = (value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export const projectWriteSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  state: jsonObject,
});
export const projectRequestSchema = z.strictObject({
  instruction: z.string().trim().min(1).max(100000),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate, '日期无效').optional(),
  workspaceId: z.string().trim().min(1).max(120).optional(),
});
export const projectRequestIdSchema = z.strictObject({ requestId });
export const projectProposalSchema = z.strictObject({ requestId, plan: jsonObject });

function parseInput(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new StateError(`项目输入无效：${result.error.issues[0]?.message ?? '格式不正确'}。`);
  return result.data;
}

function serialize(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { throw new StateError(`${label}必须是可序列化的 JSON 对象。`); }
  if (typeof encoded !== 'string') throw new StateError(`${label}必须是可序列化的 JSON 对象。`);
  if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new StateError(`${label}过大，未保存。`, 413);
  return encoded;
}

function parseStored(encoded, label) {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_STATE_BYTES) {
    throw new StateError(`${label}格式不正确或超过大小限制。`, 500);
  }
  let value;
  try { value = JSON.parse(encoded); }
  catch { throw new StateError(`${label}无法解析，请修复数据库后重试。`, 500); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StateError(`${label}格式不正确。`, 500);
  }
  return value;
}

/** 独立项目文档与 AI 请求存储；所有读取均直接查询 SQLite，不缓存项目状态。 */
export function openProjectStore(filename = DEFAULT_PROJECT_DATABASE) {
  if (typeof filename !== 'string' || !filename.trim()) throw new StateError('项目数据库路径未配置。');
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS project_document (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_request (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'cancelled')),
        document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requirement_send_lock (
        requirement_id TEXT PRIMARY KEY, token TEXT NOT NULL, acquired_at INTEGER NOT NULL
      );`);
    db.prepare('INSERT OR IGNORE INTO project_document (id, revision, state) VALUES (1, 0, ?)')
      .run(JSON.stringify(emptyHierarchy()));
    // Migrate once under a write lock and advance the revision. An old panel's
    // pending write then conflicts instead of stripping the new hierarchy.
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT revision, state FROM project_document WHERE id = 1').get();
      const state = parseStored(row?.state, '项目数据');
      if ([1, 2, 3, 4].includes(state.version)) {
        const migrated = state.version === 1 ? migrateLegacy(state) : sanitizeHierarchy({ ...state, version: HIERARCHY_VERSION });
        db.prepare('UPDATE project_document SET revision = revision + 1, state = ? WHERE id = 1').run(serialize(migrated, '项目数据'));
      } else if (state.version !== HIERARCHY_VERSION) throw new StateError('项目数据版本不受支持。', 500);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) {
    db.close();
    throw error;
  }

  const selectDocument = db.prepare('SELECT revision, state FROM project_document WHERE id = 1');
  const updateDocument = db.prepare(`UPDATE project_document SET revision = revision + 1, state = ?
    WHERE id = 1 AND revision = ? RETURNING revision`);
  const selectRequest = db.prepare('SELECT status, document FROM project_request WHERE id = ?');
  const insertRequest = db.prepare('INSERT INTO project_request (id, status, document) VALUES (?, ?, ?)');
  const updateRequest = db.prepare('UPDATE project_request SET status = ?, document = ? WHERE id = ?');
  let closed = false;

  const read = () => {
    const row = selectDocument.get();
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) {
      throw new StateError('项目数据库版本格式不正确。', 500);
    }
    const state = parseStored(row.state, '项目数据');
    if (state.version !== HIERARCHY_VERSION || !Array.isArray(state.projects) || !Array.isArray(state.workspaces) || typeof state.seededAt !== 'string') {
      throw new StateError('项目数据格式不正确。', 500);
    }
    return { revision: row.revision, state };
  };

  const readRequest = (id) => {
    const key = parseInput(projectRequestIdSchema, { requestId: id }).requestId;
    const row = selectRequest.get(key);
    if (!row) throw new StateError('AI 请求不存在，请重新发起。', 404);
    const request = parseStored(row.document, 'AI 请求');
    if (request.id !== key || request.status !== row.status || request.source !== 'codex') {
      throw new StateError('AI 请求格式不正确。', 500);
    }
    return request;
  };

  // 请求与其引用的项目版本在同一事务内读取，避免多进程更新时关联到不同快照。
  const transaction = (run) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    read,
    write(input) {
      const payload = parseInput(projectWriteSchema, input);
      serialize(payload, '项目数据');
      const sanitized = sanitizeHierarchy(payload.state);
      return transaction(() => {
        const current = read();
        if (current.revision !== payload.revision) throw new StateError('项目数据已在其他窗口更新，请重新加载后再保存。', 409);
        const state = clearChangedWorkspaceThreads(current.state, sanitized);
        const encoded = serialize(state, '项目数据');
        const nextWorkspaces = new Map(state.workspaces.map(item => [item.id, item]));
        const remainingIds = new Set(state.projects.map(item => item.id));
        for (const requirement of current.state.projects) {
          const lock = db.prepare('SELECT acquired_at FROM requirement_send_lock WHERE requirement_id = ?').get(requirement.id);
          if (lock && Date.now() - lock.acquired_at < 120000) {
            const next = state.projects.find(item => item.id === requirement.id);
            const previousWorkspace = current.state.workspaces.find(item => item.id === requirement.workspaceId);
            if (!next || requirementRoute(requirement, previousWorkspace) !== requirementRoute(next, nextWorkspaces.get(next.workspaceId))) {
              throw new StateError('需求正在发送，请等待发送结束后再移动、删除或修改对话及项目绑定。', 409);
            }
          }
          const nextWorkspace = nextWorkspaces.get(requirement.workspaceId);
          const removedContainer = !nextWorkspace || !nextWorkspace.modules.includes(requirement.module);
          if (removedContainer && !remainingIds.has(requirement.id)) {
            throw new StateError('项目或模块中还有需求，请先移动或删除这些需求，再删除项目或模块。', 409);
          }
        }
        const row = updateDocument.get(encoded, payload.revision);
        if (!row) throw new StateError('项目数据已在其他窗口更新，请重新加载后再保存。', 409);
        return { revision: row.revision, projectCount: state.projects.length, state };
      });
    },
    acquireRequirementSend(requirementId) {
      return transaction(() => {
        const lock = db.prepare('SELECT acquired_at FROM requirement_send_lock WHERE requirement_id = ?').get(requirementId);
        if (lock && Date.now() - lock.acquired_at < 120000) throw new StateError('这个需求已有消息正在发送，请等待结果后再试。', 409);
        const token = randomUUID();
        db.prepare('INSERT OR REPLACE INTO requirement_send_lock VALUES (?, ?, ?)').run(requirementId, token, Date.now());
        return token;
      });
    },
    releaseRequirementSend(requirementId, token) {
      db.prepare('DELETE FROM requirement_send_lock WHERE requirement_id = ? AND token = ?').run(requirementId, token);
    },
    clearUnavailableThreadBindings(expected, sendToken) {
      if (!expected.length) return [];
      return transaction(() => {
        const current = read(), cleared = [];
        for (const item of expected) {
          const requirement = current.state.projects.find(value => value.id === item.requirementId);
          const workspace = current.state.workspaces.find(value => value.id === requirement?.workspaceId);
          if (!requirement?.codexThread || requirementRoute(requirement, workspace) !== item.route) continue;
          const lock = db.prepare('SELECT token, acquired_at FROM requirement_send_lock WHERE requirement_id = ?').get(requirement.id);
          // Only the sender that owns the lock may clean up during its preflight.
          if (lock && Date.now() - lock.acquired_at < 120000 && lock.token !== sendToken) continue;
          cleared.push({ requirementId: requirement.id, threadId: requirement.codexThread.threadId });
          delete requirement.codexThread;
          requirement.updatedAt = new Date().toISOString();
        }
        if (cleared.length) {
          const row = updateDocument.get(serialize(current.state, '项目数据'), current.revision);
          if (!row) throw new StateError('清理对话绑定冲突，请刷新后重试。', 409);
        }
        return cleared;
      });
    },
    clearMissingCodexProjects(expected, sendToken) {
      if (!expected.length) return [];
      return transaction(() => {
        const current = read(), cleared = [];
        const workspaces = current.state.workspaces.map(workspace => {
          if (!expected.some(item => item.workspaceId === workspace.id && item.key === codexProjectKey(workspace.codexProject))) return workspace;
          if (workspace.codexProject?.hostId !== 'local') return workspace;
          const locked = current.state.projects.some(requirement => {
            if (requirement.workspaceId !== workspace.id) return false;
            const lock = db.prepare('SELECT token, acquired_at FROM requirement_send_lock WHERE requirement_id = ?').get(requirement.id);
            return lock && Date.now() - lock.acquired_at < 120000 && lock.token !== sendToken;
          });
          if (locked) return workspace;
          cleared.push({ workspaceId: workspace.id, key: codexProjectKey(workspace.codexProject) });
          const { codexProject, ...rest } = workspace;
          return rest;
        });
        if (cleared.length) {
          const state = clearChangedWorkspaceThreads(current.state, { ...current.state, workspaces });
          const row = updateDocument.get(serialize(state, '项目数据'), current.revision);
          if (!row) throw new StateError('清理项目绑定冲突，请刷新后重试。', 409);
        }
        return cleared;
      });
    },
    bindCreatedThread(requirementId, token, expectedRoute, binding) {
      return transaction(() => {
        const lock = db.prepare('SELECT token FROM requirement_send_lock WHERE requirement_id = ?').get(requirementId);
        if (lock?.token !== token) throw new StateError('发送锁已失效，请手动绑定已创建的对话。', 409);
        const current = read();
        const requirement = current.state.projects.find(item => item.id === requirementId);
        const workspace = current.state.workspaces.find(item => item.id === requirement?.workspaceId);
        if (!requirement || requirementRoute(requirement, workspace) !== expectedRoute) {
          throw new StateError('需求归属或绑定已变化，请手动绑定已创建的对话。', 409);
        }
        requirement.codexThread = normalizeCodexThread(binding);
        requirement.updatedAt = new Date().toISOString();
        const row = updateDocument.get(serialize(sanitizeHierarchy(current.state), '项目数据'), current.revision);
        if (!row) throw new StateError('保存绑定冲突，请手动绑定已创建的对话。', 409);
        return { revision: row.revision, codexThread: requirement.codexThread };
      });
    },
    createRequest(input) {
      const { instruction, today = todayISO(), workspaceId } = parseInput(projectRequestSchema, input);
      return transaction(() => {
        const { revision, state } = read();
        const selected = workspaceId || (state.workspaces.length === 1 ? state.workspaces[0].id : '');
        if (!state.workspaces.some(item => item.id === selected)) throw new StateError('请指定当前项目。');
        const request = {
          id: randomUUID(), source: 'codex', status: 'pending', revision, workspaceId: selected,
          createdAt: new Date().toISOString(), instruction, today, plan: null, planRevision: null,
        };
        insertRequest.run(request.id, request.status, serialize(request, 'AI 请求'));
        return request;
      });
    },
    readRequest,
    propose(input) {
      const { requestId: id, plan: rawPlan } = parseInput(projectProposalSchema, input);
      serialize(rawPlan, 'AI 计划');
      return transaction(() => {
        const request = readRequest(id);
        if (request.status === 'cancelled') throw new StateError('AI 请求已取消，不能再提交计划。', 409);
        const { revision, state } = read();
        const workspace = state.workspaces.find(item => item.id === request.workspaceId);
        if (!workspace) throw new StateError('请求所属项目已不存在。', 409);
        const requirements = state.projects.filter(item => item.workspaceId === request.workspaceId);
        const plan = revalidatePlan(normalizePlan(rawPlan, requirements, request.today), requirements);
        plan.actions = plan.actions.filter(action => {
          const module = action.op === 'add' ? action.project.module : action.op === 'update' ? action.changes.module : undefined;
          if (module === undefined || workspace.modules.includes(module)) return true;
          plan.issues.push(`模块「${module}」不属于当前项目，相关需求变更已跳过。`);
          return false;
        });
        const ready = { ...request, status: 'ready', plan, planRevision: revision, updatedAt: new Date().toISOString() };
        updateRequest.run(ready.status, serialize(ready, 'AI 请求'), id);
        return ready;
      });
    },
    cancelRequest(id) {
      return transaction(() => {
        const request = readRequest(id);
        if (request.status === 'cancelled') return request;
        const cancelled = { ...request, status: 'cancelled', updatedAt: new Date().toISOString() };
        updateRequest.run(cancelled.status, serialize(cancelled, 'AI 请求'), request.id);
        return cancelled;
      });
    },
    close() {
      if (!closed) { db.close(); closed = true; }
    },
  };
}
