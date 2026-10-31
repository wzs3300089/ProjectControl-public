import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readCodexMetadata } from './codex-projects.mjs';
import { StateError } from './project-store.mjs';
import { normalizeCodexThread } from './console/shared/codex-thread.js';

export function workspaceScope(state, workspaceId) {
  const workspace = state.workspaces.find(item => item.id === workspaceId);
  if (!workspace) throw new StateError('需求所属项目已不存在，请刷新后重试。', 409);
  if (workspace.codexProject && workspace.codexProject.hostId !== 'local') throw new StateError('暂不支持远程 Codex 项目的对话绑定。', 409);
  return { projectId: workspace.codexProject?.projectId ?? null, hostId: 'local', name: workspace.codexProject?.name || '无项目' };
}

/** Only titles and membership metadata; never fetch messages, previews or rollouts. */
export async function readCodexThreads(state, workspaceId, { codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), threadIds = [], metadata: suppliedMetadata } = {}) {
  const scope = workspaceScope(state, workspaceId);
  const metadata = suppliedMetadata || await readCodexMetadata(codexHome);
  if (scope.projectId && !metadata['local-projects'][scope.projectId]) throw new StateError('绑定的 Codex 项目已不存在，请先修改项目绑定。', 409);
  let db, rows;
  try {
    db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
    // Desktop chats can have has_user_event=0 despite completed turns. It is not
    // a readiness flag; ephemeral/subagent sources are filtered separately.
    rows = db.prepare("SELECT id, COALESCE(NULLIF(name, ''), title) AS title, updated_at, source, project_id, archived FROM threads ORDER BY updated_at DESC, id").all();
  } catch { throw new StateError('读取 Codex 对话列表失败，请重新打开总控台后重试。', 503); }
  finally { db?.close(); }
  // Absence from the filtered candidate list is NOT proof of deletion. Only a
  // successful full database query can confirm a missing row or archived flag.
  const rowById = new Map(rows.map(row => [row.id, row]));
  const checkedIds = new Set([...state.projects.filter(item => item.workspaceId === workspaceId && item.codexThread)
    .map(item => item.codexThread.threadId), ...threadIds]);
  const unavailableThreadIds = [...checkedIds].filter(id => !rowById.has(id) || rowById.get(id).archived === 1);
  const projectless = new Set(metadata['projectless-thread-ids'] || []);
  const maps = metadata['app-server-project-id-by-legacy-project-id-by-host'] || {};
  const localMap = maps[`local:${codexHome}`] || maps[`local:${codexHome.replaceAll('/', '\\')}`] || {};
  const threads = rows.flatMap(row => {
    if (row.archived !== 0) return [];
    // Subagents/guardians and ephemeral hosts are not user-selectable chats.
    if (!['vscode', 'cli'].includes(row.source)) return [];
    const host = metadata['thread-project-membership-host-ids']?.[row.id] || 'local';
    if (host !== 'local') return [];
    const assignment = metadata['thread-project-assignments']?.[row.id];
    let projectId;
    if (row.project_id) {
      projectId = Object.keys(localMap).find(id => localMap[id] === row.project_id)
        || (metadata['local-projects'][row.project_id] ? row.project_id : undefined);
      // Conflicting/migrating metadata is not evidence of a valid destination.
      if (projectless.has(row.id) || (assignment && (assignment.projectKind !== 'local' || assignment.projectId !== projectId))) return [];
    } else if (assignment) {
      if (assignment.projectKind !== 'local' || projectless.has(row.id)) return [];
      projectId = assignment.projectId;
    } else if (projectless.has(row.id)) projectId = null;
    // Missing membership must not be confused with an explicit projectless chat.
    if (projectId === undefined || projectId !== scope.projectId) return [];
    try {
      return [{ ...normalizeCodexThread({ threadId: row.id, hostId: 'local', projectId,
        title: String(row.title || '未命名对话').trim().slice(0, 200) || '未命名对话' }),
        updatedAt: new Date(row.updated_at * 1000).toISOString() }];
    } catch { return []; }
  });
  return { threads, scope, unavailableThreadIds };
}

export async function validateThreadBinding(state, requirement, options) {
  const binding = normalizeCodexThread(requirement.codexThread);
  if (!binding) return;
  const { threads, unavailableThreadIds } = options?.threadResult
    || await readCodexThreads(state, requirement.workspaceId, { ...options, threadIds: [binding.threadId] });
  if (unavailableThreadIds.includes(binding.threadId)) {
    const error = new StateError('绑定对话已删除或归档，请刷新后重试。', 409);
    error.unavailableThreadId = binding.threadId;
    throw error;
  }
  if (!threads.some(item => item.threadId === binding.threadId && item.projectId === binding.projectId)) {
    throw new StateError('绑定对话已删除、归档或不属于当前项目，请刷新并重新选择；未绑定项目只能选择无项目对话。', 409);
  }
}
