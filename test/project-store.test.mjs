import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openProjectStore } from '../src/project-store.mjs';
import { emptyHierarchy } from '../src/console/server/hierarchy.js';
import * as projectTools from '../src/project-tools.mjs';
const { registerProjectTools } = projectTools;

const runFile = promisify(execFile);
const stamp = '2026-10-30T10:00:00.000Z';
const project = {
  id: 'project-1', workspaceId: 'original-project', name: '真实结构项目', module: '公司项目', status: '进行中', owner: '张三',
  dueDate: '2026-11-02', startedOn: '2026-10-01', progress: 35, link: 'https://example.test/project',
  summary: '中文和 emoji 📝', tags: ['交付', '核心'], createdAt: stamp, updatedAt: stamp,
  updates: [{ id: 'update-1', at: stamp, kind: 'blocker', text: '等待接口' }],
  todos: [{ id: 'todo-1', title: '确认接口', owner: '李四', dueDate: '2026-10-31', done: true, doneAt: stamp }],
};
const withWorkspace = () => ({ ...emptyHierarchy(), workspaces: [{ id: 'original-project', name: '原有项目', modules: ['公司项目'] }] });
const state = () => ({ ...withWorkspace(), seededAt: stamp, projects: [structuredClone(project)] });

async function withDatabase(run) {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-project-store-'));
  const filename = join(folder, 'projects.sqlite');
  const stores = [];
  const open = () => { const store = openProjectStore(filename); stores.push(store); return store; };
  try { await run({ filename, open }); }
  finally {
    for (const store of stores) store.close();
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-project-store-'));
    await rm(folder, { recursive: true, force: true });
  }
}

const hasStatus = (status) => (error) => error?.status === status;

test('独立项目 SQLite 保留全部上游字段，重启可读并支持整体更新及删除', async () => {
  await withDatabase(({ open }) => {
    const store = open();
    assert.deepEqual(store.read(), { revision: 0, state: emptyHierarchy() });
    const saved = store.write({ revision: 0, state: state() });
    assert.equal(saved.revision, 1);
    assert.equal(saved.projectCount, 1);
    assert.deepEqual(saved.state, state());
    store.close();
    const reopened = open();
    assert.deepEqual(reopened.read(), { revision: 1, state: state() });
    const modified = state();
    modified.projects[0].progress = 60;
    reopened.write({ revision: 1, state: modified });
    assert.equal(reopened.read().state.projects[0].progress, 60);
    modified.projects[0].progress = 100;
    modified.projects[0].status = '已完成';
    modified.projects[0].updates.push({ id: 'finished', at: stamp, kind: 'progress',
      text: '完成：接口联调，100%。\n验证：重试与并发用例通过。\n待办：无。' });
    reopened.write({ revision: 2, state: modified });
    reopened.close();
    const completed = open();
    assert.deepEqual(completed.read(), { revision: 3, state: modified });
    assert.equal(completed.read().state.projects[0].updates[1].text.split('\n').length, 3);
    completed.write({ revision: 3, state: { ...withWorkspace(), seededAt: stamp, projects: [] } });
    assert.deepEqual(completed.read(), { revision: 4, state: { ...withWorkspace(), seededAt: stamp, projects: [] } });
  });
});

test('多个连接每次读取当前版本，旧版本写入不覆盖新数据', async () => {
  await withDatabase(({ open }) => {
    const first = open();
    const second = open();
    const stale = second.read();
    first.write({ revision: 0, state: state() });
    assert.equal(second.read().revision, 1);
    assert.throws(() => second.write(stale), hasStatus(409));
    assert.deepEqual(first.read(), second.read());
  });
});

test('不同 Node 进程竞争同一版本只有一次原子写入成功', async () => {
  await withDatabase(async ({ filename, open }) => {
    const store = open();
    const script = `import { openProjectStore } from ${JSON.stringify(new URL('../src/project-store.mjs', import.meta.url).href)};
      const store = openProjectStore(process.argv[1]);
      try { store.write({ revision: 0, state: { ...store.read().state, workspaces: [{ id: 'original-project', name: '原有项目', modules: ['公司项目'] }], projects: [{ id: process.argv[2], name: process.argv[2], workspaceId: 'original-project', module: '公司项目' }] } }); process.stdout.write('saved'); }
      catch (error) { process.stdout.write(String(error.status)); }
      finally { store.close(); }`;
    const results = await Promise.all(['进程甲', '进程乙'].map((name) =>
      runFile(process.execPath, ['--input-type=module', '-e', script, filename, name])));
    assert.deepEqual(results.map((result) => result.stdout).sort(), ['409', 'saved']);
    assert.equal(store.read().revision, 1);
    assert.equal(store.read().state.projects.length, 1);
  });
});

test('非法版本、非对象状态及超过 4MiB 的输入均拒绝且不修改数据', async () => {
  await withDatabase(({ open }) => {
    const store = open();
    for (const revision of [-1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      assert.throws(() => store.write({ revision, state: state() }), hasStatus(400));
    }
    for (const invalid of [null, [], '', 123]) {
      assert.throws(() => store.write({ revision: 0, state: invalid }), hasStatus(400));
    }
    assert.throws(() => store.write({ revision: 0, state: {}, unexpected: true }), hasStatus(400));
    assert.throws(() => store.write({ revision: 0, state: { projects: [], extra: 'x'.repeat(4 * 1024 * 1024) } }), hasStatus(413));
    const cyclic = { projects: [] }; cyclic.self = cyclic;
    assert.throws(() => store.write({ revision: 0, state: cyclic }), hasStatus(400));
    assert.equal(store.read().revision, 0);
  });
});

test('复用上游规范化规则收敛项目字段，并独立返回快照避免缓存污染', async () => {
  await withDatabase(({ open }) => {
    const store = open();
    store.write({ revision: 0, state: { ...withWorkspace(), projects: [{ id: 'fixed', workspaceId: 'original-project', module: '公司项目', name: ' 项目 ', progress: 160, todos: [{ title: '待办', done: false }] }] } });
    const current = store.read();
    assert.equal(current.state.version, 5);
    assert.equal(current.state.projects[0].name, '项目');
    assert.equal(current.state.projects[0].progress, 100);
    assert.equal(current.state.projects[0].todos[0].doneAt, '');
    current.state.projects.length = 0;
    assert.equal(store.read().state.projects.length, 1);
  });
});

test('AI 请求关联原指令并持久化规范化预览，生成计划不修改项目', async () => {
  await withDatabase(({ open }) => {
    const store = open();
    store.write({ revision: 0, state: state() });
    const request = store.createRequest({ instruction: '把真实结构项目进度改为80%', today: '2026-10-30' });
    assert.equal(request.status, 'pending');
    assert.equal(request.source, 'codex');
    assert.equal(request.revision, 1);
    assert.equal(request.today, '2026-10-30');
    assert.equal(request.instruction, '把真实结构项目进度改为80%');
    assert.ok(request.id);
    assert.ok(!Number.isNaN(Date.parse(request.createdAt)));
    const ready = store.propose({ requestId: request.id, plan: { intent: 'update', reply: '修改进度', actions: [{ op: 'update', target: 'project-1', changes: { progress: '80%' } }] } });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.planRevision, 1);
    assert.deepEqual(ready.plan.actions, [{ op: 'update', projectId: 'project-1', name: '真实结构项目', changes: { progress: 80 } }]);
    assert.deepEqual(store.read(), { revision: 1, state: state() });
    store.close();
    assert.deepEqual(open().readRequest(request.id), ready);
  });
});

test('AI 计划按提交时当前项目解析，取消请求和未知请求不能提交', async () => {
  await withDatabase(({ open }) => {
    const store = open();
    store.write({ revision: 0, state: state() });
    const request = store.createRequest({ instruction: '更新项目' });
    store.write({ revision: 1, state: { ...state(), projects: [] } });
    const ready = store.propose({ requestId: request.id, plan: { actions: [{ op: 'delete', target: 'project-1' }] } });
    assert.equal(ready.planRevision, 2);
    assert.deepEqual(ready.plan.actions, []);
    assert.ok(ready.plan.issues.some((issue) => issue.includes('找不到')));
    assert.equal(store.cancelRequest(request.id).status, 'cancelled');
    assert.equal(store.cancelRequest(request.id).status, 'cancelled');
    assert.throws(() => store.propose({ requestId: request.id, plan: {} }), hasStatus(409));
    assert.throws(() => store.readRequest('missing'), hasStatus(404));
    assert.throws(() => store.cancelRequest('missing'), hasStatus(404));
    assert.throws(() => store.propose({ requestId: 'missing', plan: {} }), hasStatus(404));
    assert.throws(() => store.createRequest({ instruction: ' ' }), hasStatus(400));
    assert.throws(() => store.createRequest({ instruction: '更新', today: '2026-02-31' }), hasStatus(400));
    assert.throws(() => store.propose({ requestId: request.id, plan: [] }), hasStatus(400));
  });
});

test('数据库内损坏的项目 JSON 明确报错，不静默重置', async () => {
  await withDatabase(({ filename, open }) => {
    const store = open();
    const db = new DatabaseSync(filename);
    try { db.prepare('UPDATE project_document SET state = ? WHERE id = 1').run('{broken'); }
    finally { db.close(); }
    assert.throws(() => store.read(), hasStatus(500));
  });
});

test('HTTP 可复用的执行入口统一校验项目工具并拒绝旧便签及未知工具', async () => {
  await withDatabase(({ open }) => {
    const store = open();
    assert.equal(typeof projectTools.executeProjectTool, 'function');
    const execute = (name, args) => projectTools.executeProjectTool(store, name, args);
    assert.equal(execute('project_control_projects_read').revision, 0);
    assert.equal(execute('project_control_projects_write', { revision: 0, state: state() }).revision, 1);
    const request = execute('project_control_request_create', { instruction: '修改进度', today: '2026-10-30' });
    assert.equal(execute('project_control_request_read', { requestId: request.id }).instruction, '修改进度');
    const ready = execute('project_control_propose_plan', { requestId: request.id, plan: { actions: [{ op: 'update', target: 'project-1', changes: { progress: 75 } }] } });
    assert.equal(ready.plan.actions[0].changes.progress, 75);
    assert.equal(execute('project_control_context').hooksEnabled, false);
    assert.equal(execute('project_control_projects_read').state.projects[0].progress, 35);
    assert.equal(execute('project_control_request_cancel', { requestId: request.id }).status, 'cancelled');
    for (const name of ['project_control_read', 'project_control_save', 'project_control_open', 'missing', 'toString', '__proto__']) {
      assert.throws(() => execute(name, {}), hasStatus(404));
    }
    for (const [name, args] of [
      ['project_control_projects_read', { ignored: true }],
      ['project_control_projects_write', { revision: '1', state: {} }],
      ['project_control_request_create', { instruction: '' }],
      ['project_control_request_read', { requestId: 12 }],
      ['project_control_request_cancel', { requestId: request.id, unexpected: true }],
      ['project_control_propose_plan', { requestId: request.id, plan: [] }],
      ['project_control_context', null],
    ]) assert.throws(() => execute(name, args), hasStatus(400));
    assert.equal(store.read().revision, 1);
  });
});

test('真实 MCP 工具公开严格写入契约、AI 请求预览、结构化冲突及禁用钩子上下文', async () => {
  await withDatabase(async ({ open }) => {
    const store = open();
    const server = new McpServer({ name: 'project-store-test', version: '1' });
    registerProjectTools(server, store);
    const client = new Client({ name: 'project-store-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 11);
      for (const tool of tools) assert.deepEqual(tool._meta.ui.visibility,
        ['project_control_codex_ai_send', 'project_control_codex_threads'].includes(tool.name) ? ['app'] : ['app', 'model']);
      const write = tools.find((tool) => tool.name === 'project_control_projects_write');
      assert.deepEqual(write.inputSchema.required.sort(), ['revision', 'state']);
      assert.equal(write.inputSchema.additionalProperties, false);
      const saved = await client.callTool({ name: write.name, arguments: { revision: 0, state: state() } });
      assert.equal(saved.structuredContent.revision, 1);
      const stale = await client.callTool({ name: write.name, arguments: { revision: 0, state: state() } });
      assert.equal(stale.isError, true);
      assert.equal(stale.structuredContent.status, 409);
      assert.equal(typeof stale.structuredContent.error, 'string');
      const request = (await client.callTool({ name: 'project_control_request_create', arguments: { instruction: '删除真实结构项目', today: '2026-10-30' } })).structuredContent;
      const ready = await client.callTool({ name: 'project_control_propose_plan', arguments: { requestId: request.id, plan: { actions: [{ op: 'delete', target: 'project-1' }] } } });
      assert.equal(ready.structuredContent.status, 'ready');
      assert.equal(store.read().state.projects.length, 1);
      const context = (await client.callTool({ name: 'project_control_context', arguments: {} })).structuredContent;
      assert.equal(context.hooksEnabled, false);
      assert.equal(context.revision, 1);
      assert.equal(context.state.projects[0].id, 'project-1');
      const cancelled = await client.callTool({ name: 'project_control_request_cancel', arguments: { requestId: request.id } });
      assert.equal(cancelled.structuredContent.status, 'cancelled');
      const read = await client.callTool({ name: 'project_control_request_read', arguments: { requestId: request.id } });
      assert.equal(read.structuredContent.status, 'cancelled');
    } finally { await client.close(); await server.close(); }
  });
});
