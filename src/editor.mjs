import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { configureTransport, ApiError } from './console/client/api.js';
import { mountConsole } from './console/mount.js';

const app = new App({ name: '项目总控台', version: '1.0.0' }, {}, { autoResize: false, strict: true });
async function call(name, args = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new ApiError(result.structuredContent?.error || result.content?.find(item => item.type === 'text')?.text || '操作失败', result.structuredContent?.status || 500);
  if (!result.structuredContent) throw new ApiError('服务未返回数据，请重新打开面板。');
  return result.structuredContent;
}

function syncHost() {
  const context = app.getHostContext();
  if (context?.theme) { applyDocumentTheme(context.theme); document.documentElement.dataset.theme = context.theme; }
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.addEventListener('hostcontextchanged', syncHost);
try {
  await app.connect();
  syncHost();
  configureTransport({ call, openThread: threadId => app.openLink({ url: `codex://threads/${encodeURIComponent(threadId)}` }) });
  await mountConsole();
} catch (error) {
  const root = document.querySelector('#root');
  root.textContent = `连接失败：${error.message}。请关闭后重新打开项目总控台。`;
  root.className = 'connection-error';
}
