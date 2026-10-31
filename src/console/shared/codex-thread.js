const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function normalizeCodexThread(value) {
  if (value == null) return null
  if (!uuid.test(value.threadId || '') || value.hostId !== 'local'
    || !(value.projectId === null || (typeof value.projectId === 'string' && value.projectId.length > 0 && value.projectId.length <= 200))
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) {
    throw new Error('Codex 对话绑定无效，请重新选择。')
  }
  return { threadId: value.threadId, hostId: 'local', title: value.title.trim(), projectId: value.projectId }
}

export function requirementRoute(requirement, workspace) {
  return JSON.stringify([requirement.workspaceId, workspace?.codexProject?.hostId || 'local',
    workspace?.codexProject?.projectId ?? null, requirement.codexThread?.threadId ?? null])
}
