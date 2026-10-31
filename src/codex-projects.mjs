import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StateError } from './console/server/upstream-store.js';
import { codexProjectKey } from './console/shared/hierarchy.js';

export function callerThread(meta) {
  for (const key of ['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id']) {
    if (typeof meta?.[key] === 'string' && meta[key].trim()) return meta[key].trim();
  }
  let turn = meta?.['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    try { turn = JSON.parse(turn); } catch { return null; }
  }
  return typeof turn?.thread_id === 'string' ? turn.thread_id : null;
}

/** Read project metadata. Desktop selection is only an opening fallback, never a caller identity. */
export async function readCodexMetadata(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  let state;
  try {
    const json = await readFile(join(codexHome, '.codex-global-state.json'), 'utf8');
    if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new Error('metadata too large');
    state = JSON.parse(json);
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state['local-projects']
      || typeof state['local-projects'] !== 'object' || Array.isArray(state['local-projects'])) throw new Error('metadata unavailable');
  } catch (error) {
    throw new StateError(error.code === 'ENOENT' ? '未找到 Codex 项目列表，请在 Codex 桌面端使用项目绑定。' : '读取 Codex 项目列表失败，请稍后重试。', 503);
  }
  return state;
}

export async function readCodexProjects({ meta, onOpen = false, codexHome, metadata, store, workspaceId, sendToken } = {}) {
  const state = metadata || await readCodexMetadata(codexHome);
  const entries = state['local-projects'];
  const knownLocalProjectIds = Object.keys(entries);
  // A missing entry in a successfully read local catalog proves deletion.
  // Existing but incomplete entries, and remote projects, are not such evidence.
  const missingWorkspaces = store ? store.read().state.workspaces.filter(item => (!workspaceId || item.id === workspaceId)
    && item.codexProject?.hostId === 'local' && !Object.hasOwn(entries, item.codexProject.projectId))
    .map(item => ({ workspaceId: item.id, key: codexProjectKey(item.codexProject) })) : [];
  const clearedWorkspaces = store ? store.clearMissingCodexProjects(missingWorkspaces, sendToken) : [];
  const order = Array.isArray(state['project-order']) ? state['project-order'] : [];
  const projects = [...new Set([...order, ...Object.keys(entries)])].flatMap(id => {
    const item = entries[id];
    if (!item || item.id !== id || typeof item.name !== 'string' || !item.name.trim() || !Array.isArray(item.rootPaths)) return [];
    return [{ projectId: id, hostId: 'local', name: item.name, path: item.rootPaths.find(path => typeof path === 'string') || '' }];
  });
  const threadId = callerThread(meta);
  const assignment = threadId ? state['thread-project-assignments']?.[threadId] : null;
  const hostId = state['thread-project-membership-host-ids']?.[threadId] || 'local';
  let currentProject = assignment?.projectKind === 'local'
    ? projects.find(item => item.projectId === assignment.projectId && item.hostId === hostId) || null : null;
  let currentProjectSource = currentProject ? 'thread' : null;
  // Unsent chats use Codex's ephemeral mcp_extension_host thread. It has no
  // persisted project assignment; only when opening the console may the desktop
  // selection fill that gap. Explicit projectless/deleted/remote assignments win.
  const projectless = Array.isArray(state['projectless-thread-ids']) && state['projectless-thread-ids'].includes(threadId);
  if (onOpen && threadId && !assignment && !projectless && hostId === 'local') {
    const selected = state['selected-project'];
    if (selected?.type === 'local') {
      currentProject = projects.find(item => item.projectId === selected.projectId && item.hostId === 'local') || null;
      if (currentProject) currentProjectSource = 'selection';
    }
  }
  return { projects, currentProject, currentProjectSource, threadId, knownLocalProjectIds, missingWorkspaces, clearedWorkspaces };
}
