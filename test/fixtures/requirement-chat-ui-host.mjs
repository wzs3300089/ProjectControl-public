// Isolated UI acceptance host. Every host response here is a controlled fixture,
// not evidence of a real Codex delivery. Never opens the production database.
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openProjectStore } from '../../src/project-store.mjs';
import { executeProjectTool } from '../../src/project-tools.mjs';

const folder = await mkdtemp(join(tmpdir(), 'project-control-chat-ui-'));
const ids = { caller: randomUUID(), a: randomUUID(), b: randomUUID(), free: randomUUID() };
const metadata = { 'local-projects': {
  a: { id: 'a', name: 'Codex 甲', rootPaths: ['G:/a'] }, b: { id: 'b', name: 'Codex 乙', rootPaths: ['G:/b'] } },
  'thread-project-assignments': { [ids.a]: { projectKind: 'local', projectId: 'a' }, [ids.b]: { projectKind: 'local', projectId: 'b' } },
  'projectless-thread-ids': [ids.free] };
const saveMetadata = () => writeFile(join(folder, '.codex-global-state.json'), JSON.stringify(metadata));
await saveMetadata();
await writeFile(join(folder, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'model-a', display_name: '验收模型', visibility: 'list',
  default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] }));
const db = new DatabaseSync(join(folder, 'state_5.sqlite'));
db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER, source TEXT, project_id TEXT, archived INTEGER, has_user_event INTEGER, model TEXT, reasoning_effort TEXT, name TEXT)');
const add = (id, title) => db.prepare("INSERT INTO threads VALUES (?, ?, ?, 'vscode', NULL, 0, 0, 'model-a', 'low', ?)").run(id, title, Math.floor(Date.now()/1000), title);
add(ids.a, '甲项目已有对话'); add(ids.b, '乙项目已有对话'); add(ids.free, '无项目已有对话'); add(ids.caller, '调用聊天');
const store = openProjectStore(join(folder, 'projects.sqlite'));
const base = store.read();
store.write({ revision: base.revision, state: { ...base.state,
  workspaces: [{ id: 'wa', name: '验收甲项目', modules: ['模块'], codexProject: { projectId: 'a', hostId: 'local', name: 'Codex 甲', path: 'G:/a' }, aiSettings: { model: 'model-a', reasoningEffort: 'low' } },
    { id: 'wf', name: '未绑定项目', modules: ['模块'], aiSettings: { model: 'model-a', reasoningEffort: 'low' } }],
  projects: [{ id: 'ra', workspaceId: 'wa', module: '模块', name: '绑定验收需求', summary: '隔离样本，仅测试界面和路由' },
    { id: 'rf', workspaceId: 'wf', module: '模块', name: '无项目验收需求', summary: '隔离样本' }] } });
const calls = [], sockets = new Set();
let busy = false;
const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\pc-ui-${randomUUID()}` : join(folder, 'host.sock');
const pipe = netServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  let data = Buffer.alloc(0);
  socket.on('data', async chunk => {
    data = Buffer.concat([data, chunk]);
    if (data.length < 4 || data.length < data.readUInt32LE(0) + 4) return;
    const req = JSON.parse(data.subarray(4)); let value;
    if (req.method === 'tools/list') value = { tools: ['send_message_to_thread','create_thread'].map(name => ({ name, namespace: 'codex_app', inputSchema: { properties: { model: {}, thinking: {} } } })) };
    else {
      const { tool, arguments: args } = req.params;
      let result;
      if (tool === 'read_thread') result = { thread: { id: args.threadId, status: { type: busy ? 'active' : 'idle' } } };
      if (tool === 'list_projects') result = { projects: ['a','b'].map(projectId => ({ projectId, projectKind: 'local', hostId: 'local' })) };
      if (tool === 'create_thread') {
        const id = randomUUID(); add(id, args.title);
        if (args.target.type === 'project') metadata['thread-project-assignments'][id] = { projectKind: 'local', projectId: args.target.projectId };
        else metadata['projectless-thread-ids'].push(id);
        await saveMetadata(); result = { threadId: id, hostId: 'local' }; calls.push({ tool, args, result });
      }
      if (tool === 'send_message_to_thread') { result = { threadId: args.threadId }; calls.push({ tool, args, result }); }
      value = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    }
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: value }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.end(Buffer.concat([header,body]));
  });
});
await new Promise(done => pipe.listen(pipePath, done));
const assets = { '/': '../../dist/console-web.html', '/console-web.mjs': '../../dist/console-web.mjs', '/console-host.css': '../../src/console/host.css' };
const server = httpServer(async (req, res) => {
  try {
    if (req.method === 'GET' && assets[req.url]) {
      res.setHeader('Content-Type', req.url.endsWith('mjs') ? 'text/javascript' : req.url.endsWith('css') ? 'text/css' : 'text/html');
      res.end(await readFile(new URL(assets[req.url], import.meta.url))); return;
    }
    res.setHeader('Content-Type','application/json');
    if (req.url === '/__evidence') { res.end(JSON.stringify({ ...store.read(), calls, ids })); return; }
    if (req.url === '/__busy') { busy = !busy; res.end(JSON.stringify({ busy })); return; }
    if (req.method === 'POST' && req.url === '/__project-state') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const { projectId, action } = JSON.parse(Buffer.concat(chunks));
      if (action === 'corrupt') await writeFile(join(folder, '.codex-global-state.json'), '{controlled invalid metadata');
      else if (action === 'restore') await saveMetadata();
      else if (action === 'delete' && Object.hasOwn(metadata['local-projects'], projectId)) {
        delete metadata['local-projects'][projectId]; await saveMetadata();
      } else throw new Error('未知验收操作');
      res.end('{}'); return;
    }
    if (req.method === 'POST' && req.url === '/__thread-state') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const { threadId, action } = JSON.parse(Buffer.concat(chunks));
      if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId)) throw new Error('未知验收对话');
      if (action === 'archive') db.prepare('UPDATE threads SET archived = 1 WHERE id = ?').run(threadId);
      else if (action === 'delete') db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
      else throw new Error('未知验收操作');
      res.end('{}'); return;
    }
    if (req.url === '/__stop') { res.end('{}'); setTimeout(stop, 100); return; }
    if (req.method !== 'POST' || req.url !== '/api/project-console/tool') { res.statusCode=404; res.end('{}'); return; }
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks));
    res.end(JSON.stringify(await executeProjectTool(store,input.name,input.arguments,{codexHome:folder,pipePath,meta:{threadId:ids.caller}})));
  } catch(error) {res.statusCode=error.status||500;res.end(JSON.stringify({error:error.message}));}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,pid:process.pid}));
let stopped=false;
async function stop(){if(stopped)return;stopped=true;await new Promise(done=>server.close(done));for(const socket of sockets)socket.destroy();await new Promise(done=>pipe.close(done));store.close();db.close();
  if(dirname(resolve(folder))===resolve(tmpdir())&&basename(folder).startsWith('project-control-chat-ui-'))await rm(folder,{recursive:true,force:true});}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
