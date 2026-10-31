import React from 'react'
import { Btn, Field, Modal, Notice } from './ui.js'
import { createWorkspace, renameWorkspace, deleteWorkspace, createModule, renameModule, deleteModule, codexProjectKey } from '../shared/hierarchy.js'
import { newId, readCodexProjects } from './api.js'
import { AiSettingsFields, useAiSelection } from './ai-settings.js'

const h = React.createElement
const { useEffect, useState } = React

export function HierarchyManager({ mode, state, workspace, onSwitch, onUpdate, onReload, onClose }) {
  const [projectName, setProjectName] = useState('')
  const [moduleName, setModuleName] = useState('')
  const [selectedModule, setSelectedModule] = useState('')
  const [renamedModule, setRenamedModule] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmModule, setConfirmModule] = useState(false)
  const [binding, setBinding] = useState(null)
  const [codexProjects, setCodexProjects] = useState([])
  const [bindingLoading, setBindingLoading] = useState(false)
  const [bindingError, setBindingError] = useState('')
  const [bindAi, setBindAi] = useState(mode === 'create' || !!workspace?.aiSettings)
  const aiSelection = useAiSelection(mode === 'edit' ? workspace?.aiSettings : null, `${mode}:${workspace?.id || 'new'}`, mode === 'create' || mode === 'edit')
  useEffect(() => {
    setProjectName(mode === 'edit' ? workspace?.name || '' : '')
    setBinding(mode === 'edit' ? workspace?.codexProject || null : null)
    setBindAi(mode === 'create' || !!workspace?.aiSettings)
    setSelectedModule(''); setRenamedModule(''); setError(''); setConfirmModule(false)
  }, [mode, workspace?.id, workspace?.name])
  useEffect(() => {
    if (mode !== 'create' && mode !== 'edit') return
    let active = true
    setBindingLoading(true); setBindingError('')
    readCodexProjects().then(async result => {
      const isMissing = value => value?.hostId === 'local' && Array.isArray(result.knownLocalProjectIds)
        && !result.knownLocalProjectIds.includes(value.projectId)
      if (active) {
        setCodexProjects(result.projects)
        setBinding(current => isMissing(current) ? null : current)
      }
      if (result.clearedWorkspaces?.length || isMissing(workspace?.codexProject)) await onReload?.()
    }).catch(cause => {
      if (active) setBindingError(cause.message || '读取 Codex 项目列表失败。')
    }).finally(() => { if (active) setBindingLoading(false) })
    return () => { active = false }
  }, [mode, workspace?.id])
  const run = async (change, after) => {
    if (busy) return
    try { change(state) } catch (cause) { setError(cause.message); return }
    setBusy(true); setError('')
    try {
      const ok = await onUpdate(change)
      if (!ok) { setError('保存失败，请检查总控台提示并重试。'); return }
      after?.()
    } finally { setBusy(false) }
  }
  const addProject = () => {
    const id = newId('workspace')
    return run(current => createWorkspace(current, id, projectName, binding, bindAi ? aiSelection.value : null), () => { onSwitch(id); onClose() })
  }
  const editProject = () => run(current => renameWorkspace(current, workspace.id, projectName, binding, bindAi ? aiSelection.value : null), onClose)
  const removeProject = () => run(current => deleteWorkspace(current, workspace.id), () => {
    onSwitch(state.workspaces.find(item => item.id !== workspace.id)?.id); onClose()
  })
  const count = state.projects.filter(item => item.workspaceId === workspace?.id).length
  const footer = action => [h(Btn, { key: 'cancel', onClick: onClose }, '取消'), action]

  if (mode === 'create' || mode === 'edit') {
    const creating = mode === 'create'
    return h(Modal, { open: true, title: creating ? '新建项目' : '编辑项目', icon: creating ? 'plus' : 'edit', onClose,
      footer: footer(h(Btn, { key: 'save', variant: 'primary', disabled: busy || bindingLoading || !projectName.trim() || (bindAi && (!aiSelection.valid || aiSelection.loading)), onClick: creating ? addProject : editProject }, creating ? '创建项目' : '保存修改')) },
    h('div', { className: 'pc-hierarchy' },
      h(Field, { label: '项目名称' }, h('input', { className: 'pc-input', 'aria-label': '项目名称', value: projectName,
        onChange: event => setProjectName(event.target.value), placeholder: '输入项目名称' })),
      h(Field, { label: '绑定 Codex 项目（可选）' },
        h('select', { className: 'pc-select', 'aria-label': '绑定 Codex 项目', value: codexProjectKey(binding), disabled: bindingLoading,
          onChange: event => setBinding(codexProjects.find(item => codexProjectKey(item) === event.target.value) || null) },
          h('option', { value: '' }, bindingLoading ? '正在读取 Codex 项目…' : '不绑定'),
          binding && !codexProjects.some(item => codexProjectKey(item) === codexProjectKey(binding))
            ? h('option', { value: codexProjectKey(binding) }, `${binding.name}（当前绑定，列表中不可用）`) : null,
          codexProjects.map(item => {
            const used = state.workspaces.find(other => other.id !== (creating ? null : workspace?.id) && codexProjectKey(other.codexProject) === codexProjectKey(item))
            return h('option', { key: codexProjectKey(item), value: codexProjectKey(item), disabled: !!used },
              `${item.name}${used ? `（已绑定「${used.name}」）` : ''}${item.path ? ` · ${item.path}` : ''}`)
          }))),
      bindingError ? h(Notice, { tone: 'warn' }, `${bindingError}仍可保存项目或解除已有绑定。`) : null,
      h('label', { className: 'pc-chips' }, h('input', { type: 'checkbox', checked: bindAi, disabled: busy,
        onChange: event => setBindAi(event.target.checked) }), '绑定项目 AI 默认配置'),
      bindAi ? h(AiSettingsFields, { selection: aiSelection, disabled: busy, binding: true })
        : h('div', { className: 'pc-muted' }, '未绑定时，AI 交互默认读取当前 Codex 聊天配置。'),
      error ? h(Notice, { tone: 'danger' }, error) : null))
  }
  if (mode === 'delete') {
    const blocked = count > 0
    const detail = count > 0 ? `项目中还有 ${count} 条需求，请先移动或删除这些需求。`
      : '删除后将移除该项目及其空模块，不会删除工作区文件。'
    return h(Modal, { open: true, title: `删除项目「${workspace.name}」？`, icon: 'trash', onClose,
      footer: footer(h(Btn, { key: 'delete', variant: 'danger', disabled: busy || blocked, onClick: removeProject }, '确认删除')) },
    h('div', { className: 'pc-hierarchy' }, h('div', null, detail), error ? h(Notice, { tone: 'danger' }, error) : null))
  }
  const addModule = () => run(current => createModule(current, workspace.id, moduleName), () => setModuleName(''))
  return h(Modal, { open: true, title: `模块管理 · ${workspace.name}`, icon: 'grid', onClose,
    footer: [h(Btn, { key: 'close', onClick: onClose }, '关闭')] },
  h('div', { className: 'pc-hierarchy' },
    h('div', { className: 'pc-muted' }, '点击模块，可重命名或删除。'),
    h('div', { className: 'pc-hierarchy-list' }, workspace.modules.length ? workspace.modules.map(name => h('button', {
      key: name, type: 'button', className: 'pc-hierarchy-row', 'aria-current': name === selectedModule,
      onClick: () => { setSelectedModule(name); setRenamedModule(name); setConfirmModule(false); setError('') }
    }, h('span', null, name), h('small', null, `${state.projects.filter(req => req.workspaceId === workspace.id && req.module === name).length} 个需求`))) : h('div', { className: 'pc-muted' }, '还没有模块，先创建一个模块。')),
    h(Field, { label: '新建模块' }, h('div', { className: 'pc-hierarchy-line' },
      h('input', { className: 'pc-input', 'aria-label': '新模块名称', value: moduleName, onChange: event => setModuleName(event.target.value) }),
      h(Btn, { onClick: addModule, disabled: busy || !moduleName.trim() }, '创建模块'))),
    selectedModule ? h(Field, { label: `管理模块：${selectedModule}` }, h('div', { className: 'pc-hierarchy-line' },
      h('input', { className: 'pc-input', 'aria-label': '模块名称', value: renamedModule, onChange: event => setRenamedModule(event.target.value) }),
      h(Btn, { onClick: () => run(current => renameModule(current, workspace.id, selectedModule, renamedModule), () => setSelectedModule(renamedModule.trim())), disabled: busy || !renamedModule.trim() }, '重命名模块'),
      h(Btn, { variant: 'danger', onClick: () => setConfirmModule(true), disabled: busy }, '删除模块'))) : null,
    confirmModule ? h(Notice, { tone: 'warn', action: h('div', { className: 'pc-chips' },
      h(Btn, { onClick: () => setConfirmModule(false) }, '取消'),
      h(Btn, { variant: 'danger', disabled: busy, onClick: () => run(current => deleteModule(current, workspace.id, selectedModule), () => { setSelectedModule(''); setConfirmModule(false) }) }, '确认删除')) }, `确定删除模块「${selectedModule}」？存在需求时不能删除。`) : null,
    error ? h(Notice, { tone: 'danger' }, error) : null))
}
