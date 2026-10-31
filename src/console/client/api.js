/** Codex transport adapter; the upstream views share this API in MCP and browser previews. */
import { planSchemaDoc, projectSnapshot } from '../shared/aiplan.js'
import { normalizeAiSettings } from '../shared/ai-settings.js'

let transport
export function configureTransport(value) { transport = value }
export class ApiError extends Error {
  constructor(message, status = 500) { super(message); this.name = 'ApiError'; this.status = status }
}
export function newId(prefix = 'p') { return `${prefix}_${crypto.randomUUID()}` }
async function call(name, args = {}) {
  if (!transport) throw new ApiError('总控台尚未连接，请重新打开。', 503)
  return transport.call(name, args)
}
export const readState = () => call('project_control_projects_read')
export const readCodexProjects = (options = {}) => call('project_control_codex_projects', options)
export const readCodexThreads = (workspaceId, threadId) => call('project_control_codex_threads', { workspaceId, ...(threadId ? { threadId } : {}) })
export const readCodexAi = () => call('project_control_codex_ai_read')
export const writeState = (revision, state) => call('project_control_projects_write', { revision, state })

export async function sendToCodex(text, value, { requirement, openCreatedThread = true } = {}) {
  const settings = normalizeAiSettings(value)
  if (!settings) throw new ApiError('请选择模型和思维长度。', 400)
  const result = await call('project_control_codex_ai_send', { text, settings, ...(requirement ? { requirement } : {}) })
  if (result?.accepted !== true) throw new ApiError('发送结果未确认，请先查看当前聊天，避免重复发送。', 502)
  if (result.createdThread && openCreatedThread) {
    try {
      const opened = await transport.openThread?.(result.threadId)
      if (!opened || opened.isError) throw new Error('聊天导航不可用')
    } catch (error) {
      console.warn('消息已发送，打开新聊天失败：', error.message)
      return { ...result, navigationError: '消息已发送，请在 Codex 左侧项目中打开新聊天。' }
    }
  }
  return result
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('已取消等待', 'AbortError')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Codex produces a proposal; only the existing confirmation flow changes project data. */
export async function askAi(instruction, projects, today, { signal, onStatus, workspaceId, workspaceName, modules, settings } = {}) {
  signal?.throwIfAborted()
  if (!normalizeAiSettings(settings)) throw new ApiError('请选择模型和思维长度。', 400)
  const request = await call('project_control_request_create', { instruction, today, ...(workspaceId ? { workspaceId } : {}) })
  let finished = false
  try {
    signal?.throwIfAborted()
    const delivery = await sendToCodex([
      '请处理这条来自项目总控台的 AI 填充请求。',
      `请求 ID：${request.id}`,
      ...(workspaceId ? [`当前项目：${workspaceName || workspaceId}（ID：${workspaceId}）。请只处理这个项目下的需求；其他项目仅作为背景，不得修改。`] : []),
      'AI 填充只处理需求和待跟进。用户若要求管理项目或模块，请引导使用项目与模块管理，不要把它误当作需求操作。',
      `用户指令：${instruction}`,
      '请先调用 project_control_request_read 和 project_control_projects_read 核对请求与最新数据；再调用 project_control_propose_plan 提交计划。只生成预览，不直接写入项目；用户将在面板确认执行。查询也请提交 intent=query、actions=[] 和 reply。',
      planSchemaDoc(today, modules),
      `点击时当前项目的需求快照：\n${JSON.stringify(projectSnapshot(projects, today))}`,
    ].join('\n\n'), settings, { openCreatedThread: false })
    onStatus?.(delivery.navigationError || (delivery.createdThread
      ? `已在「${delivery.projectName}」创建 Codex 聊天，等待变更预览。`
      : '已发送到 Codex，等待变更预览；你可以在旁边的聊天中查看处理进度。'))
    const deadline = Date.now() + 15 * 60 * 1000
    while (!signal?.aborted && Date.now() < deadline) {
      const value = await call('project_control_request_read', { requestId: request.id })
      if (value.status === 'ready') { finished = true; return value }
      if (value.status === 'cancelled') throw new ApiError('请求已取消，可以重新输入指令。', 409)
      await delay(1500, signal)
    }
    if (signal?.aborted) throw new DOMException('已取消等待', 'AbortError')
    throw new ApiError('等待 Codex 超时，请先查看聊天中的处理进度。', 408)
  } finally {
    if (!finished) {
      try { await call('project_control_request_cancel', { requestId: request.id }) }
      catch (error) { console.error('取消 AI 预览请求失败：', error.message) }
    }
  }
}
