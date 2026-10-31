import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openStore, saveSchema } from './store.mjs';
import { openProjectStore } from './project-store.mjs';
import { registerProjectTools } from './project-tools.mjs';

const resourceUri = 'ui://project-control-test/console-v4.html';
const dataIndex = process.argv.indexOf('--data');
const filename = dataIndex >= 0 ? process.argv[dataIndex + 1]
  : fileURLToPath(new URL('../data/note.sqlite', import.meta.url));
if (!filename) throw new Error('--data requires a database filename');
const store = openStore(filename);
const projectIndex = process.argv.indexOf('--projects');
const projectFilename = projectIndex >= 0 ? process.argv[projectIndex + 1] : join(dirname(filename), 'projects.sqlite');
if (!projectFilename) throw new Error('--projects requires a database filename');
const projects = openProjectStore(projectFilename);
const server = new McpServer({ name: 'project-control-mcp-server', version: '0.1.0' });
const output = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
});

server.registerResource('project-control-editor', resourceUri,
  { title: '项目总控台', mimeType: 'text/html;profile=mcp-app' },
  async () => ({ contents: [{
    uri: resourceUri,
    mimeType: 'text/html;profile=mcp-app',
    text: await readFile(new URL('../dist/editor.html', import.meta.url), 'utf8'),
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));

server.registerTool('project_control_open', {
  title: '项目总控台',
  description: '在聊天右侧打开多项目总控台，按项目、模块、需求管理，提供看板、待跟进与 Codex AI 助手。',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri }, 'openai/ui': { entrypoints: [{ type: 'thread' }] },
    'openai/outputTemplate': resourceUri, 'openai/widgetAccessible': true },
}, async () => output(projects.read()));

server.registerTool('project_control_read', {
  title: '读取项目便签',
  description: '读取项目便签的文字、完成状态和版本。',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ['app', 'model'] }, 'openai/widgetAccessible': true },
}, async () => output(store.read()));

server.registerTool('project_control_save', {
  title: '保存项目便签',
  description: '保存用户输入的文字和状态；revision 必须来自最近一次读取，防止覆盖其他窗口的修改。',
  inputSchema: saveSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ['app', 'model'] }, 'openai/widgetAccessible': true },
}, async (input) => {
  try { return output(store.save(input)); }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});

registerProjectTools(server, projects);
process.once('exit', () => { store.close(); projects.close(); });
await server.connect(new StdioServerTransport());
