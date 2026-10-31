// Pure hierarchy operations shared by the management UI and regression tests.
import { normalizeAiSettings } from './ai-settings.js'
const clean = value => typeof value === 'string' ? value.trim() : ''
function nameOf(value, label) {
  const name = clean(value)
  if (!name || name.length > 200 || name === '全部') throw new Error(`${label}名称不能为空、不能超过 200 字，也不能是“全部”。`)
  return name
}
function find(state, id) {
  const item = state.workspaces.find(workspace => workspace.id === id)
  if (!item) throw new Error('项目已不存在，请刷新后重试。')
  return item
}
export function codexProjectKey(project) {
  return project?.projectId && project?.hostId ? JSON.stringify([project.hostId, project.projectId]) : ''
}
// A workspace's chat bindings are scoped to its Codex destination, not its label/path.
export function clearChangedWorkspaceThreads(previous, next) {
  const oldKeys = new Map(previous.workspaces.map(item => [item.id, codexProjectKey(item.codexProject)]))
  const changed = new Set(next.workspaces.filter(item => oldKeys.has(item.id)
    && oldKeys.get(item.id) !== codexProjectKey(item.codexProject)).map(item => item.id))
  if (!changed.size) return next
  const at = new Date().toISOString()
  return { ...next, projects: next.projects.map(item => {
    if (!changed.has(item.workspaceId) || !item.codexThread) return item
    const { codexThread, ...rest } = item
    return { ...rest, updatedAt: at }
  }) }
}
export function normalizeCodexProject(value) {
  if (value == null) return null
  const projectId = clean(value.projectId), hostId = clean(value.hostId), name = clean(value.name), path = clean(value.path)
  if (!projectId || projectId.length > 200 || !hostId || hostId.length > 200 || !name || name.length > 200 || path.length > 4000) {
    throw new Error('Codex 项目绑定无效，请重新选择。')
  }
  return { projectId, hostId, name, path }
}
function bindingFields(state, id, value) {
  const codexProject = normalizeCodexProject(value)
  if (codexProject && state.workspaces.some(item => item.id !== id && codexProjectKey(item.codexProject) === codexProjectKey(codexProject))) {
    throw new Error('这个 Codex 项目已绑定其他项目，请先解除原绑定。')
  }
  return codexProject ? { codexProject } : {}
}
export function defaultWorkspaceId(workspaces, currentProject, previousId) {
  const key = codexProjectKey(currentProject)
  return (key && workspaces.find(item => codexProjectKey(item.codexProject) === key)?.id)
    || workspaces.find(item => item.id === previousId)?.id || workspaces[0]?.id || ''
}
export function createWorkspace(state, id, value, codexProject = null, settings = null) {
  const name = nameOf(value, '项目')
  if (!id || state.workspaces.some(item => item.id === id || item.name === name)) throw new Error('项目名称已存在。')
  const aiSettings = normalizeAiSettings(settings)
  return { ...state, workspaces: [...state.workspaces, { id, name, modules: [], ...bindingFields(state, id, codexProject), ...(aiSettings ? { aiSettings } : {}) }] }
}
export function renameWorkspace(state, id, value, codexProject = undefined, settings = undefined) {
  const name = nameOf(value, '项目'); find(state, id)
  if (state.workspaces.some(item => item.id !== id && item.name === name)) throw new Error('项目名称已存在。')
  const binding = codexProject === undefined ? null : bindingFields(state, id, codexProject)
  const aiSettings = normalizeAiSettings(settings)
  return clearChangedWorkspaceThreads(state, { ...state, workspaces: state.workspaces.map(item => {
    if (item.id !== id) return item
    const { codexProject: previous, aiSettings: previousAi, ...rest } = item
    const nextAi = settings === undefined ? previousAi : aiSettings
    return { ...rest, name, ...(binding ?? (previous ? { codexProject: previous } : {})), ...(nextAi ? { aiSettings: nextAi } : {}) }
  }) })
}
export function deleteWorkspace(state, id) {
  find(state, id)
  if (state.projects.some(item => item.workspaceId === id)) throw new Error('项目内还有需求，请先移动或删除这些需求。')
  return { ...state, workspaces: state.workspaces.filter(item => item.id !== id) }
}
export function createModule(state, id, value) {
  const name = nameOf(value, '模块'), workspace = find(state, id)
  if (workspace.modules.includes(name)) throw new Error('当前项目已有同名模块。')
  return { ...state, workspaces: state.workspaces.map(item => item.id === id ? { ...item, modules: [...item.modules, name] } : item) }
}
export function renameModule(state, id, from, value) {
  const name = nameOf(value, '模块'), workspace = find(state, id)
  if (!workspace.modules.includes(from)) throw new Error('模块已不存在，请刷新后重试。')
  if (name !== from && workspace.modules.includes(name)) throw new Error('当前项目已有同名模块。')
  return { ...state,
    workspaces: state.workspaces.map(item => item.id === id ? { ...item, modules: item.modules.map(module => module === from ? name : module) } : item),
    projects: state.projects.map(item => item.workspaceId === id && item.module === from ? { ...item, module: name } : item) }
}
export function deleteModule(state, id, name) {
  const workspace = find(state, id)
  if (!workspace.modules.includes(name)) throw new Error('模块已不存在，请刷新后重试。')
  if (state.projects.some(item => item.workspaceId === id && item.module === name)) throw new Error('模块内还有需求，请先移动或删除这些需求。')
  return { ...state, workspaces: state.workspaces.map(item => item.id === id ? { ...item, modules: item.modules.filter(module => module !== name) } : item) }
}
