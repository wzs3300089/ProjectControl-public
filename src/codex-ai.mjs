import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { StateError } from './console/server/upstream-store.js';
import { normalizeAiSettings, REASONING_EFFORTS } from './console/shared/ai-settings.js';
import { callerThread, readCodexProjects } from './codex-projects.mjs';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const defaults = () => ({ codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'), pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH });
const sending = new Set();

// Codex's bundled codex-app-tools uses this length-prefixed local transport.
// One request per connection; no retries after a possibly delivered message.
async function nativeRequest(pipePath, method, params, deadline = Date.now() + 20000) {
  if (!pipePath) throw new StateError('Codex 本地工具通道不可用，请重新启用项目总控台插件。', 503);
  if (Date.now() >= deadline) throw new StateError('Codex 响应超时，消息未发送，请稍后重试。', 504);
  const id = randomUUID();
  const body = Buffer.from(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
  if (body.length > MAX_FRAME_BYTES) throw new StateError('消息过长，未发送。', 413);
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath);
    let data = Buffer.alloc(0), written = false, settled = false;
    const fail = () => finish(new StateError(written && method === 'tools/call'
      ? '发送结果未确认，请先查看当前聊天，避免重复发送。'
      : '连接 Codex 本地工具通道失败，消息未发送，请重新打开总控台。', 502));
    const timer = setTimeout(fail, Math.min(20000, deadline - Date.now()));
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    }
    socket.once('connect', () => { written = true; socket.write(Buffer.concat([header, body])); });
    socket.on('error', fail);
    socket.on('close', () => { if (!settled) fail(); });
    socket.on('data', chunk => {
      if (settled) return;
      if (data.length + chunk.length > MAX_FRAME_BYTES + 4) { fail(); return; }
      data = Buffer.concat([data, chunk]);
      if (data.length < 4) return;
      const size = data.readUInt32LE(0);
      if (size === 0 || size > MAX_FRAME_BYTES) { fail(); return; }
      if (data.length < size + 4) return;
      let value;
      try { value = JSON.parse(data.subarray(4, size + 4).toString('utf8')); }
      catch { fail(); return; }
      if (value.id !== id || value.jsonrpc !== '2.0') { fail(); return; }
      if (value.error) {
        finish(new StateError(`Codex 拒绝操作：${String(value.error.message || '工具调用失败').slice(0, 1000)}`, 502)); return;
      }
      if (!Object.hasOwn(value, 'result')) { fail(); return; }
      finish(null, value.result);
    });
  });
}

async function sendTool(pipePath, deadline, name = 'send_message_to_thread') {
  const catalog = await nativeRequest(pipePath, 'tools/list', { threadStartKind: 'all' }, deadline);
  const tool = catalog?.tools?.find(item => item.name === name && item.namespace === 'codex_app');
  if (!tool?.inputSchema?.properties?.model || !tool.inputSchema.properties.thinking) {
    throw new StateError(`当前 Codex 未提供指定模型${name === 'create_thread' ? '新建聊天' : '发送'}能力，请更新客户端。`, 501);
  }
  return tool;
}

function callContext(threadId, meta) {
  let turnMeta = meta?.['x-codex-turn-metadata'];
  if (typeof turnMeta === 'string') { try { turnMeta = JSON.parse(turnMeta); } catch { turnMeta = null; } }
  return { callerSource: 'codex', namespace: 'codex_app', threadId, hostId: 'local',
    turnId: turnMeta?.turn_id || `mcp-turn-${randomUUID()}`, callId: `mcp-call-${randomUUID()}` };
}

function hostJson(result) {
  if (result?.success !== true) return null;
  try { return JSON.parse(result.contentItems.find(item => item.type === 'inputText').text); }
  catch { return null; }
}

async function sendMode(pipePath, threadId, meta, deadline, callerId = threadId) {
  const result = await nativeRequest(pipePath, 'tools/call', { ...callContext(callerId, meta), tool: 'read_thread',
    arguments: { threadId, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 } }, deadline);
  // This specific host error identifies an unsent chat's MCP extension host.
  // Missing DB rows, arbitrary read failures and stale IDs must never create chats.
  if (result?.success === false && result.contentItems?.some(item => item.type === 'inputText'
    && item.text.trim() === 'ephemeral threads do not support thread/turns/list')) return 'new';
  const thread = hostJson(result)?.thread;
  if (thread?.id !== threadId || !thread.status?.type) throw new StateError('无法确认当前聊天状态，消息未发送，请稍后重试。', 503);
  if (thread.status.type !== 'idle') throw new StateError('当前 Codex 聊天正在处理任务，请等本轮结束后发送，确保使用所选模型和思维长度。', 409);
  return 'existing';
}

async function createProjectChat({ codexHome, pipePath, meta, threadId, deadline, text, selection, destination, beforeSend, title }) {
  const tool = await sendTool(pipePath, deadline, 'create_thread');
  // The caller was positively identified as ephemeral above. Reuse the opening
  // selection fallback only to choose a new chat's project, never an existing ID.
  const context = { codexHome, meta, onOpen: true };
  const currentProject = destination === undefined ? (await readCodexProjects(context)).currentProject : destination;
  if (destination === undefined && !currentProject) throw new StateError('请先在 Codex 左侧选择本机项目，再发送新聊天的首条消息。', 409);
  if (currentProject?.projectId) {
    const listed = await nativeRequest(pipePath, 'tools/call', { ...callContext(threadId, meta), tool: 'list_projects', arguments: {} }, deadline);
    const project = hostJson(listed)?.projects?.find(item => item.projectId === currentProject.projectId
      && item.hostId === 'local' && item.projectKind === 'local');
    if (!project) throw new StateError('当前 Codex 项目不可用，消息未发送，请重新选择项目。', 409);
    if (destination === undefined) {
      const latest = (await readCodexProjects(context)).currentProject;
      if (latest?.projectId !== project.projectId || latest.hostId !== 'local') {
        throw new StateError('当前 Codex 项目已变化，消息未发送，请重新打开总控台。', 409);
      }
    }
  }
  await beforeSend?.();
  const result = await nativeRequest(pipePath, 'tools/call', { ...callContext(threadId, meta), tool: tool.name,
    arguments: { prompt: text, model: selection.model, thinking: selection.reasoningEffort, ...(title ? { title } : {}),
      target: currentProject?.projectId ? { type: 'project', projectId: currentProject.projectId, environment: { type: 'local' } } : { type: 'projectless' } } }, deadline);
  const receipt = hostJson(result);
  // The desktop returns threadId only when creation AND the first turn were
  // accepted. Queued/failed first turns return other shapes and are not success.
  if (receipt?.hostId !== 'local' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(receipt?.threadId || '')
    || receipt.threadId === threadId) {
    throw new StateError('Codex 未确认新聊天及首条消息已接收，请先查看左侧项目，避免重复发送。', 502);
  }
  return { accepted: true, createdThread: true, threadId: receipt.threadId, projectName: currentProject?.name || '无项目', settings: selection };
}

async function modelCatalog(codexHome) {
  const path = join(codexHome, 'models_cache.json');
  try {
    if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('oversized');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(raw.models)) throw new Error('invalid');
    const seen = new Set();
    const models = raw.models.flatMap(item => {
      if (item.visibility !== 'list' || typeof item.slug !== 'string' || !item.slug || seen.has(item.slug)) return [];
      const reasoningEfforts = [...new Set((item.supported_reasoning_levels || []).map(level => level.effort).filter(level => REASONING_EFFORTS.includes(level)))];
      if (!reasoningEfforts.length) return [];
      seen.add(item.slug);
      return [{ id: item.slug, name: typeof item.display_name === 'string' ? item.display_name : item.slug,
        reasoningEfforts, defaultReasoningEffort: reasoningEfforts.includes(item.default_reasoning_level) ? item.default_reasoning_level : reasoningEfforts[0] }];
    });
    if (!models.length) throw new Error('empty');
    return { models, fetchedAt: typeof raw.fetched_at === 'string' ? raw.fetched_at : null };
  } catch {
    throw new StateError('读取 Codex 模型目录失败，请先在 Codex 中打开模型选择器后重试。', 503);
  }
}

function currentSettings(codexHome, threadId, models) {
  if (!threadId) return null;
  let db;
  try {
    db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
    const row = db.prepare('SELECT model, reasoning_effort FROM threads WHERE id = ?').get(threadId);
    if (!row?.model) return null;
    const reasoningEffort = row.reasoning_effort || models.find(item => item.id === row.model)?.defaultReasoningEffort;
    if (!reasoningEffort) return null;
    return { selection: normalizeAiSettings({ model: row.model, reasoningEffort }), effortSource: row.reasoning_effort ? 'thread' : 'model-default' };
  } catch {
    throw new StateError('读取当前 Codex 聊天模型失败，请重新打开总控台后重试。', 503);
  } finally { db?.close(); }
}

export async function readCodexAi(options = {}) {
  const { codexHome, pipePath, meta } = { ...defaults(), ...options };
  const catalog = await modelCatalog(codexHome);
  const threadId = callerThread(meta);
  let current = null, currentEffortSource = null, currentError = '', sendError = '';
  try {
    const saved = currentSettings(codexHome, threadId, catalog.models);
    current = saved?.selection || null; currentEffortSource = saved?.effortSource || null;
  } catch (error) { currentError = error.message; }
  if (!threadId) currentError = '未取得调用聊天，请从 Codex 聊天中的项目总控台打开。';
  else if (!current && !currentError) currentError = '当前聊天尚未保存模型配置，请手动选择。';
  try { await sendTool(pipePath); } catch (error) { sendError = error.message; }
  return { ...catalog, current, currentEffortSource, currentError, canSend: !!threadId && !sendError, sendError: sendError || (!threadId ? currentError : ''),
    sendHint: threadId && !current ? '新聊天首次发送会在 Codex 当前选中项目下创建正式聊天，并使用这里所选的模型和思维长度。' : '',
    source: 'persisted-thread-settings' };
}

/** Existing callers receive a follow-up; ephemeral callers create a project chat. */
export async function sendCodexAi({ text, settings }, options = {}) {
  const { codexHome, pipePath, meta, destination, targetThreadId, beforeSend, title } = { ...defaults(), ...options };
  const callerId = callerThread(meta);
  if (!callerId) throw new StateError('无法确认调用聊天，消息未发送。请在 Codex 聊天中重新打开总控台。', 400);
  const threadId = targetThreadId || callerId;
  const selection = normalizeAiSettings(settings);
  if (!selection) throw new StateError('请选择模型和思维长度。');
  const catalog = await modelCatalog(codexHome);
  const model = catalog.models.find(item => item.id === selection.model);
  if (!model?.reasoningEfforts.includes(selection.reasoningEffort)) throw new StateError('所选模型或思维长度已不可用，请刷新选项后重试。');
  if (sending.has(threadId)) throw new StateError('当前聊天已有消息正在发送，请等待结果后再试。', 409);
  sending.add(threadId);
  try {
    const deadline = Date.now() + 25000;
    if (destination !== undefined) {
      return await createProjectChat({ codexHome, pipePath, meta, threadId: callerId, deadline, text, selection, destination, beforeSend, title });
    }
    const tool = await sendTool(pipePath, deadline);
    if (await sendMode(pipePath, threadId, meta, deadline, callerId) === 'new') {
      if (targetThreadId) throw new StateError('绑定对话不是已建立的聊天，请重新选择。', 409);
      return await createProjectChat({ codexHome, pipePath, meta, threadId, deadline, text, selection });
    }
    await beforeSend?.();
    const result = await nativeRequest(pipePath, 'tools/call', {
      ...callContext(callerId, meta), namespace: tool.namespace, tool: tool.name,
      arguments: { threadId, prompt: text, model: selection.model, thinking: selection.reasoningEffort },
    }, deadline);
    if (result?.success !== true) {
      const detail = result?.contentItems?.filter(item => item.type === 'inputText').map(item => item.text).join('\n');
      throw new StateError(`Codex 未确认发送成功，请检查当前聊天后再试。${detail ? ` ${detail.slice(0, 1000)}` : ''}`, 502);
    }
    const receipt = hostJson(result);
    if (receipt?.threadId !== threadId) throw new StateError('Codex 未确认目标聊天，发送结果未知，请先查看聊天，避免重复发送。', 502);
    return { accepted: true, ...(targetThreadId ? { threadId } : {}), settings: selection };
  } finally { sending.delete(threadId); }
}
