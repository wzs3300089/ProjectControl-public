import React from 'react'
import { readCodexAi } from './api.js'
import { Btn, Field, Notice } from './ui.js'
import { EFFORT_LABELS } from '../shared/ai-settings.js'

const h = React.createElement
const { useCallback, useEffect, useRef, useState } = React

export function useAiSelection(defaults, scope, enabled = true, initialOverride = null) {
  const [catalog, setCatalog] = useState(null)
  const [override, setOverride] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestSerial = useRef(0)
  useEffect(() => { setOverride(initialOverride) }, [scope, defaults?.model, defaults?.reasoningEffort, initialOverride?.model, initialOverride?.reasoningEffort])
  const load = useCallback(async (adoptCurrent = false) => {
    const serial = ++requestSerial.current
    setLoading(true); setError('')
    try {
      const value = await readCodexAi()
      if (serial !== requestSerial.current) return
      setCatalog(value)
      if (adoptCurrent) {
        if (value.current) setOverride(value.current)
        else setError(value.currentError || '无法读取当前 Codex 配置。')
      }
    } catch (cause) {
      if (serial === requestSerial.current) { setCatalog(null); setError(cause.message || '读取 Codex 模型失败。') }
    } finally { if (serial === requestSerial.current) setLoading(false) }
  }, [])
  useEffect(() => {
    if (enabled) void load()
    return () => { requestSerial.current++ }
  }, [scope, enabled, load])
  const value = override || defaults || catalog?.current || null
  const models = catalog?.models || []
  const valid = !!models.find(model => model.id === value?.model)?.reasoningEfforts.includes(value?.reasoningEffort)
  return { value, models, loading, error, valid, current: catalog?.current,
    canSend: valid && !loading && !error && catalog?.canSend === true,
    warning: catalog?.sendError || (!value ? catalog?.currentError : ''),
    sendHint: catalog?.sendHint,
    setValue: setOverride, refresh: () => load(), useCurrent: () => load(true),
    reset: () => setOverride(null), isOverride: !!override, hasDefault: !!defaults }
}

/** The same two controls are used before every AI send and in project settings. */
export function AiSettingsFields({ selection, disabled = false, binding = false }) {
  const { value, models, loading, error, valid } = selection
  const model = models.find(item => item.id === value?.model)
  const locked = disabled || loading
  return h('div', { className: 'pc-ai-settings' },
    h('div', { className: 'pc-grid2' },
      h(Field, { label: '模型' }, h('select', { className: 'pc-select', 'aria-label': '模型', value: value?.model || '', disabled: locked,
        onChange: event => {
          const next = models.find(item => item.id === event.target.value)
          if (next) selection.setValue({ model: next.id, reasoningEffort: next.reasoningEfforts.includes(value?.reasoningEffort) ? value.reasoningEffort : next.defaultReasoningEffort })
        } },
      !value ? h('option', { value: '' }, loading ? '正在读取 Codex…' : '请选择模型') : null,
      value && !model ? h('option', { value: value.model }, `${value.model}（不可用）`) : null,
      models.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
      h(Field, { label: '思维长度' }, h('select', { className: 'pc-select', 'aria-label': '思维长度', value: value?.reasoningEffort || '', disabled: locked || !model,
        onChange: event => selection.setValue({ ...value, reasoningEffort: event.target.value }) },
      !value ? h('option', { value: '' }, '请选择思维长度') : null,
      value && !model?.reasoningEfforts.includes(value.reasoningEffort) ? h('option', { value: value.reasoningEffort }, `${value.reasoningEffort}（不可用）`) : null,
      (model?.reasoningEfforts || []).map(effort => h('option', { key: effort, value: effort }, `${EFFORT_LABELS[effort]} · ${effort}`))))),
    h('div', { className: 'pc-chips' },
      h(Btn, { size: 'sm', disabled: locked, onClick: selection.refresh }, '刷新选项'),
      h(Btn, { size: 'sm', disabled: locked || !selection.current, onClick: selection.useCurrent }, '使用 Codex 当前配置'),
      !binding && selection.isOverride ? h(Btn, { size: 'sm', disabled: locked, onClick: selection.reset }, '恢复默认') : null),
    error ? h(Notice, { tone: 'danger' }, error) : !loading && value && !valid ? h(Notice, { tone: 'warn' }, '绑定的模型或思维长度已不可用，请重新选择。') : null,
    selection.warning ? h(Notice, { tone: 'warn' }, selection.warning) : null,
    !binding && selection.sendHint ? h(Notice, { tone: 'info' }, selection.sendHint) : null)
}
