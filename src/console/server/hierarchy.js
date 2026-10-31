import { sanitizeState, StateError } from './upstream-store.js'
import { normalizeCodexProject, codexProjectKey } from '../shared/hierarchy.js'
import { normalizeAiSettings } from '../shared/ai-settings.js'
import { normalizeCodexThread } from '../shared/codex-thread.js'

export const HIERARCHY_VERSION = 5
export const DEFAULT_WORKSPACE_ID = 'original-project'
export const DEFAULT_MODULES = ['公司项目', '日常工作', '其他项目']

// Version 1 called requirements "projects". Keep their IDs and all existing fields.
export function migrateLegacy(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.projects) || typeof raw.seededAt !== 'string') {
    throw new StateError('旧项目数据格式不正确，无法迁移。', 500)
  }
  const legacy = sanitizeState(raw)
  const modules = [...new Set([...DEFAULT_MODULES, ...legacy.projects.map(item => item.module)])]
  return { version: HIERARCHY_VERSION, seededAt: legacy.seededAt,
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: '原有项目', modules }],
    projects: legacy.projects.map(item => ({ ...item, workspaceId: DEFAULT_WORKSPACE_ID })) }
}

export function emptyHierarchy() {
  return { version: HIERARCHY_VERSION, seededAt: '',
    workspaces: [], projects: [] }
}

export function sanitizeHierarchy(raw) {
  if (!raw || raw.version !== HIERARCHY_VERSION || !Array.isArray(raw.workspaces) || !Array.isArray(raw.projects)) {
    throw new StateError('数据版本已更新，请重新打开总控台后再保存。', 409)
  }
  if (raw.workspaces.length > 2000 || raw.projects.length > 2000) throw new StateError('项目和需求数量不能超过限制。')
  const workspaceIds = new Set(), workspaceNames = new Set(), bindings = new Set()
  const workspaces = raw.workspaces.map(item => {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    if (!id || id.length > 120 || !name || name.length > 200 || workspaceIds.has(id) || workspaceNames.has(name) || !Array.isArray(item.modules)) {
      throw new StateError('项目名称、标识或模块列表无效，或项目名称重复。')
    }
    workspaceIds.add(id); workspaceNames.add(name)
    const seen = new Set()
    const modules = item.modules.map(value => {
      const moduleName = typeof value === 'string' ? value.trim() : ''
      if (!moduleName || moduleName.length > 200 || moduleName === '全部' || seen.has(moduleName)) throw new StateError('模块名称无效或重复。')
      seen.add(moduleName); return moduleName
    })
    let codexProject, aiSettings
    try {
      codexProject = normalizeCodexProject(item.codexProject)
      aiSettings = normalizeAiSettings(item.aiSettings)
    }
    catch (error) { throw new StateError(error.message) }
    if (codexProject) {
      const key = codexProjectKey(codexProject)
      if (bindings.has(key)) throw new StateError('这个 Codex 项目已绑定其他项目，请先解除原绑定。')
      bindings.add(key)
    }
    return { id, name, modules, ...(codexProject ? { codexProject } : {}), ...(aiSettings ? { aiSettings } : {}) }
  })
  const lookup = new Map(workspaces.map(item => [item.id, item]))
  const ids = new Set()
  for (const item of raw.projects) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new StateError('需求标识无效或重复。')
    ids.add(item.id)
    const workspace = lookup.get(item.workspaceId)
    if (!workspace || !workspace.modules.includes(typeof item.module === 'string' ? item.module.trim() : '')) {
      throw new StateError('需求所属项目或模块不存在，请重新选择。')
    }
  }
  const legacy = sanitizeState(raw)
  if (legacy.projects.length !== raw.projects.length) throw new StateError('需求名称不能为空。')
  return { version: HIERARCHY_VERSION, seededAt: legacy.seededAt, workspaces,
    projects: legacy.projects.map((item, index) => {
      let codexThread
      try { codexThread = normalizeCodexThread(raw.projects[index].codexThread) }
      catch (error) { throw new StateError(error.message) }
      return { ...item, workspaceId: raw.projects[index].workspaceId, ...(codexThread ? { codexThread } : {}) }
    }) }
}
