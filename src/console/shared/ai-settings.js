// Persist only an explicit selection; supported combinations come from Codex.
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const EFFORT_LABELS = { none: '无', minimal: '最短', low: '短', medium: '中等', high: '长', xhigh: '更长', max: '最长', ultra: '极长' }

export function normalizeAiSettings(value) {
  if (value == null) return null
  const model = typeof value?.model === 'string' ? value.model.trim() : ''
  if (!model || model.length > 200 || /[\s\x00-\x1f]/.test(model) || !REASONING_EFFORTS.includes(value?.reasoningEffort)) {
    throw new Error('AI 模型或思维长度无效，请重新选择。')
  }
  return { model, reasoningEffort: value.reasoningEffort }
}
