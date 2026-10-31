import React from 'react'
import { readCodexThreads } from './api.js'
import { Btn, IconBtn, Notice } from './ui.js'

const h = React.createElement
const { useEffect, useRef, useState } = React

export function requirementScope(projects, requirementId, workspaceId, expectedThreadId = undefined) {
  const project = projects.find(item => item.id === requirementId && item.workspaceId === workspaceId)
  if (!project) throw new Error('需求已删除或已移动，请重新打开需求后发送。')
  if (expectedThreadId !== undefined && expectedThreadId !== (project.codexThread?.threadId || null)) {
    throw new Error('需求绑定已变化，请重新打开需求并核对对话后发送。')
  }
  return { requirementId, workspaceId, expectedThreadId: project.codexThread?.threadId || null }
}

export function availableRequirementThreads(threads, workspace) {
  if (workspace.codexProject && workspace.codexProject.hostId !== 'local') return []
  const projectId = workspace.codexProject?.projectId ?? null
  return threads.filter(item => item.hostId === 'local' && item.projectId === projectId)
}

/** Controlled selection: detail saves immediately; forms keep the same value in their draft. */
export function RequirementChat({ workspace, value, onChange, onReconcile, onBusyChange, disabled = false }) {
  const [threads, setThreads] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const changing = useRef(false)
  const reconcile = useRef(onReconcile)
  reconcile.current = onReconcile
  useEffect(() => {
    let active = true
    setLoading(true); setError(''); setThreads([])
    readCodexThreads(workspace.id, value?.threadId).then(async result => {
      if (active) setThreads(availableRequirementThreads(result.threads || [], workspace))
      const scopeChanged = result.scope && (result.scope.projectId !== (workspace.codexProject?.projectId ?? null)
        || result.scope.hostId !== (workspace.codexProject?.hostId || 'local'))
      const bindingOutOfScope = value && result.scope && (value.projectId !== result.scope.projectId || value.hostId !== result.scope.hostId)
      // Refresh completed host cleanup even after this selector closes. Draft-only
      // changes, however, belong only to the view that requested the check.
      if (active || result.clearedBindings?.length || result.clearedWorkspaces?.length) {
        await reconcile.current?.({ ...result, active, scopeChanged, bindingOutOfScope })
      }
    }).catch(cause => { if (active) setError(cause.message || '读取 Codex 对话失败。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [workspace.id, workspace.codexProject?.projectId, workspace.codexProject?.hostId, value?.threadId, retry])
  const change = async event => {
    if (changing.current || disabled) return
    const thread = threads.find(item => item.threadId === event.target.value)
    const next = thread ? { threadId: thread.threadId, hostId: 'local', title: thread.title, projectId: thread.projectId } : null
    changing.current = true; setBusy(true); onBusyChange?.(true); setError('')
    try {
      if (await onChange(next) === false) setError('保存绑定失败，请检查总控台提示后重试。')
    } catch (cause) { setError(cause.message || '保存绑定失败。') }
    finally { changing.current = false; setBusy(false); onBusyChange?.(false) }
  }
  const missing = value && !threads.some(item => item.threadId === value.threadId)
  return h('div', { className: 'pc-field pc-field-span' },
    h('div', { className: 'pc-composer' },
      h('select', { className: 'pc-select', style: { flex: 1, minWidth: 0 }, 'aria-label': '绑定 Codex 对话', value: value?.threadId || '', disabled: disabled || busy || loading, onChange: change },
      h('option', { value: '' }, loading ? '正在读取本机对话…' : '不绑定（发送时新建对话）'),
      missing ? h('option', { value: value.threadId, disabled: true }, `${value.title || value.threadId}（当前绑定，列表中不可用）`) : null,
      threads.map(item => h('option', { key: item.threadId, value: item.threadId }, `${item.title || '未命名对话'} · ${item.threadId.slice(-8)}`))),
      h(IconBtn, { icon: 'refresh', title: '刷新对话', disabled: disabled || loading || busy, onClick: () => setRetry(value => value + 1) }),
      value ? h(IconBtn, { icon: 'close', title: '解除绑定', disabled: disabled || busy, onClick: () => change({ target: { value: '' } }) }) : null),
    missing && !loading && !error ? h(Notice, { tone: 'warn' }, '当前绑定对话已不可用，可重新选择或解除绑定。') : null,
    error ? h(Notice, { tone: 'warn', action: h(Btn, { size: 'sm', disabled: loading || busy, onClick: () => setRetry(value => value + 1) }, '重新读取') }, error) : null)
}
