import { sendCodexAi } from './codex-ai.mjs';
import { readCodexThreads, validateThreadBinding, workspaceScope } from './codex-threads.mjs';
import { StateError } from './project-store.mjs';
import { sanitizeHierarchy } from './console/server/hierarchy.js';
import { requirementRoute } from './console/shared/codex-thread.js';
import { clearChangedWorkspaceThreads } from './console/shared/hierarchy.js';
import { readCodexMetadata, readCodexProjects } from './codex-projects.mjs';

export async function readRequirementThreads(store, input, options = {}) {
  const metadata = await readCodexMetadata(options.codexHome);
  const { missingWorkspaces, clearedWorkspaces } = await readCodexProjects({ ...options, metadata, store, workspaceId: input.workspaceId });
  const { state } = store.read();
  const scope = workspaceScope(state, input.workspaceId);
  if (scope.projectId && !Object.hasOwn(metadata['local-projects'], scope.projectId)) {
    return { scope, threads: [], unavailableThreadIds: [], clearedBindings: [], missingWorkspaces, clearedWorkspaces };
  }
  const result = await readCodexThreads(state, input.workspaceId, { ...options, metadata, threadIds: input.threadId ? [input.threadId] : [] });
  const unavailable = new Set(result.unavailableThreadIds);
  const workspace = state.workspaces.find(item => item.id === input.workspaceId);
  const expected = state.projects.filter(item => item.workspaceId === input.workspaceId && unavailable.has(item.codexThread?.threadId))
    .map(item => ({ requirementId: item.id, route: requirementRoute(item, workspace) }));
  return { ...result, missingWorkspaces, clearedWorkspaces, clearedBindings: store.clearUnavailableThreadBindings(expected, options.sendToken) };
}

function requirementContext(store, input) {
  const { state } = store.read();
  const requirement = state.projects.find(item => item.id === input.requirementId && item.workspaceId === input.workspaceId);
  if (!requirement) throw new StateError('需求已删除或移动，请刷新后重试。', 409);
  if ((requirement.codexThread?.threadId ?? null) !== input.expectedThreadId) throw new StateError('需求绑定已在其他窗口变化，请刷新后重试。', 409);
  const workspace = state.workspaces.find(item => item.id === input.workspaceId);
  const scope = workspaceScope(state, input.workspaceId);
  return { state, requirement, scope, route: requirementRoute(requirement, workspace) };
}

/** Existing progress writes stay synchronous and do not depend on Codex metadata. */
export function writeWithThreadValidation(store, input, options) {
  const current = store.read();
  if (current.revision !== input.revision) throw new StateError('项目数据已在其他窗口更新，请重新加载后再保存。', 409);
  const state = clearChangedWorkspaceThreads(current.state, sanitizeHierarchy(input.state));
  const changed = state.projects.filter(item => {
    if (!item.codexThread) return false;
    const old = current.state.projects.find(previous => previous.id === item.id);
    return !old || JSON.stringify(old.codexThread) !== JSON.stringify(item.codexThread)
      || requirementRoute(old, current.state.workspaces.find(workspace => workspace.id === old.workspaceId))
        !== requirementRoute(item, state.workspaces.find(workspace => workspace.id === item.workspaceId));
  });
  if (!changed.length) return store.write({ ...input, state });
  return (async () => {
    for (const item of changed) await validateThreadBinding(state, item, options);
    return store.write({ ...input, state });
  })();
}

export async function sendRequirementAi(store, input, options = {}) {
  const context = requirementContext(store, input.requirement);
  const token = store.acquireRequirementSend(context.requirement.id);
  let delivered;
  try {
    const check = async () => {
      const latest = requirementContext(store, input.requirement);
      if (latest.route !== context.route) throw new StateError('需求所属项目的 Codex 绑定已变化，请刷新后重试。', 409);
      const threadResult = await readRequirementThreads(store, { workspaceId: latest.requirement.workspaceId }, { ...options, sendToken: token });
      if (threadResult.missingWorkspaces.length) {
        throw new StateError(threadResult.clearedWorkspaces.length
          ? '绑定的 Codex 项目已不存在，项目及对话绑定已清空；本次未发送，请核对后再次发送。'
          : '绑定的 Codex 项目已不存在，其他需求正在发送，待发送结束后刷新清理；本次未发送。', 409);
      }
      if (latest.requirement.codexThread) {
        try { await validateThreadBinding(latest.state, latest.requirement, { ...options, threadResult }); }
        catch (error) {
          if (error.unavailableThreadId === latest.requirement.codexThread.threadId) {
            const cleared = threadResult.clearedBindings.filter(item => item.requirementId === latest.requirement.id);
            if (cleared.length) throw new StateError('绑定对话已删除或归档，绑定已清空；本次未发送。请核对后再次发送以新建对话。', 409);
          }
          throw error;
        }
      }
    };
    await check();
    const thread = context.requirement.codexThread;
    delivered = await sendCodexAi(input, { ...options, beforeSend: check,
      ...(thread ? { targetThreadId: thread.threadId } : { destination: context.scope, title: context.requirement.name }) });
    if (!delivered.createdThread) return { ...delivered, bindingSaved: true, projectName: context.scope.name };
    try {
      store.bindCreatedThread(context.requirement.id, token, context.route,
        { threadId: delivered.threadId, hostId: 'local', title: context.requirement.name, projectId: context.scope.projectId });
      return { ...delivered, bindingSaved: true };
    } catch (error) {
      return { ...delivered, bindingSaved: false,
        bindingError: `消息已发送，但自动绑定未保存：${error.message} 请刷新对话选项，手动绑定「${context.requirement.name}」（${delivered.threadId}），不要重复发送。` };
    }
  } finally {
    // A cleanup failure after host acceptance must never become a delivery error.
    try { store.releaseRequirementSend(context.requirement.id, token); }
    catch (error) { console.error('释放需求发送锁失败：', error.message); }
  }
}
