import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { openProjectStore } from '../src/project-store.mjs';
import { executeProjectTool } from '../src/project-tools.mjs';
import { readCodexThreads } from '../src/codex-threads.mjs';
import { renameWorkspace, codexProjectKey } from '../src/console/shared/hierarchy.js';
import { requirementRoute } from '../src/console/shared/codex-thread.js';

const ids = Object.fromEntries(['bound', 'other', 'projectless', 'unknown', 'remote', 'archived', 'agent', 'unused', 'created', 'mapped', 'conflict'].map(name => [name, randomUUID()]));
const settings = { model: 'model-a', reasoningEffort: 'high' };
const binding = (threadId = ids.bound, projectId = 'cp-a') => ({ threadId, hostId: 'local', title: '同名对话', projectId });
const workspace = { id: 'w-a', name: '项目 A', modules: ['模块'], codexProject: { projectId: 'cp-a', hostId: 'local', name: 'Codex A', path: 'G:/a' } };
const requirement = (codexThread) => ({ id: 'r-a', workspaceId: 'w-a', name: '需求 A', module: '模块', progress: 20,
  status: '进行中', owner: '', startedOn: '', dueDate: '', link: '', summary: '', tags: [], updates: [], todos: [],
  createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', ...(codexThread ? { codexThread } : {}) });
const state = codexThread => ({ version: 5, seededAt: '', workspaces: [structuredClone(workspace), { id: 'w-none', name: '无项目', modules: ['模块'] }], projects: [requirement(codexThread)] });
const sendArgs = (expectedThreadId = ids.bound, overrides = {}) => ({ text: '执行已授权需求', settings,
  requirement: { requirementId: 'r-a', workspaceId: 'w-a', expectedThreadId, ...overrides } });
const result = value => ({ result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] } });
const failure = text => ({ result: { success: false, contentItems: [{ type: 'inputText', text }] } });
const toolList = { result: { tools: ['send_message_to_thread', 'create_thread'].map(name => ({ namespace: 'codex_app', name,
  inputSchema: { properties: { model: {}, thinking: {} } } })) } };

// Controlled SQLite and local pipe exercise the real host framing without a real Codex turn.
async function withFixture(run, initialBinding = binding()) {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-requirement-chat-'));
  const filename = join(folder, 'projects.sqlite'), stores = [];
  const open = () => { const store = openProjectStore(filename); stores.push(store); return store; };
  const metadata = { 'local-projects': {
    'cp-a': { id: 'cp-a', name: 'Codex A', rootPaths: ['G:/a'] }, 'cp-b': { id: 'cp-b', name: 'Codex B', rootPaths: ['G:/b'] },
  }, 'selected-project': { type: 'local', projectId: 'cp-b' },
  'thread-project-assignments': { [ids.bound]: { projectKind: 'local', projectId: 'cp-a' }, [ids.remote]: { projectKind: 'local', projectId: 'cp-a' } },
  'thread-project-membership-host-ids': { [ids.remote]: 'remote' }, 'projectless-thread-ids': [ids.projectless],
  'app-server-project-id-by-legacy-project-id-by-host': { [`local:${folder}`]: { 'cp-a': 'app-a' } } };
  const saveMetadata = () => writeFile(join(folder, '.codex-global-state.json'), JSON.stringify(metadata));
  const sql = (query, ...args) => { const db = new DatabaseSync(join(folder, 'state_5.sqlite')); try { return db.prepare(query).run(...args); } finally { db.close(); } };
  try {
    await saveMetadata();
    await writeFile(join(folder, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'model-a', visibility: 'list', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }] }] }));
    const db = new DatabaseSync(join(folder, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER, source TEXT, project_id TEXT, archived INTEGER, has_user_event INTEGER, model TEXT, reasoning_effort TEXT, first_user_message TEXT, name TEXT)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [name, projectId, source, archived, user] of [
      ['bound', null, 'vscode', 0, 0], ['other', 'cp-b', 'cli', 0, 1], ['projectless', null, 'cli', 0, 0],
      ['unknown', null, 'vscode', 0, 1], ['remote', null, 'vscode', 0, 1], ['archived', 'cp-a', 'vscode', 1, 1],
      ['agent', 'cp-a', 'subagent', 0, 1], ['unused', null, 'mcp_extension_host', 0, 0], ['mapped', 'app-a', 'cli', 0, 1], ['conflict', 'cp-a', 'vscode', 0, 1],
    ]) insert.run(ids[name], name === 'bound' ? '不应显示的消息片段' : '同名对话', 1793318400, source, projectId, archived, user, 'model-a', 'high', '私密正文不得返回', name === 'bound' ? '显示标题' : null);
    db.close();
    metadata['projectless-thread-ids'].push(ids.conflict); await saveMetadata();
    const store = open(); store.write({ revision: 0, state: state(initialBinding) });
    const context = { codexHome: folder, meta: { threadId: 'actual-caller', 'x-codex-turn-metadata': { thread_id: 'actual-caller', turn_id: 'actual-turn' } } };
    await run({ store, open, filename, folder, metadata, saveMetadata, sql, context });
  } finally {
    for (const store of stores) store.close();
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-requirement-chat-'));
    await rm(folder, { recursive: true, force: true });
  }
}

async function withHost(handle, run) {
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\project-control-requirement-${randomUUID()}` : join(tmpdir(), `pc-${randomUUID()}.sock`);
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0), handled = false;
    socket.on('data', async chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (handled || pending.length < 4 || pending.length < pending.readUInt32LE(0) + 4) return;
      handled = true;
      const request = JSON.parse(pending.subarray(4, pending.readUInt32LE(0) + 4));
      let reply;
      try { reply = await handle(request); }
      catch (error) { reply = { error: { code: -32000, message: error.message } }; }
      const body = Buffer.from(JSON.stringify({ id: request.id, jsonrpc: '2.0', ...reply }));
      const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
  try { await run(pipePath); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}

function hostResponder(calls, hook = async () => undefined) {
  return async request => {
    if (request.method === 'tools/list') return toolList;
    const call = request.params; calls.push(call);
    const reply = await hook(call);
    if (reply) return reply;
    if (call.tool === 'read_thread') return result({ thread: { id: call.arguments.threadId, status: { type: 'idle' } } });
    if (call.tool === 'list_projects') return result({ projects: [{ projectId: 'cp-a', projectKind: 'local', hostId: 'local' }] });
    if (call.tool === 'create_thread') return result({ threadId: ids.created, hostId: 'local' });
    return result({ threadId: call.arguments.threadId });
  };
}

test('候选兼容 has_user_event=0 的明确归属对话，按 source 排除临时宿主并区分同名、无项目及元数据冲突', async () => {
  await withFixture(async ({ store, context }) => {
    const list = await executeProjectTool(store, 'project_control_codex_threads', { workspaceId: 'w-a' }, context);
    assert.deepEqual(new Set(list.threads.map(item => item.threadId)), new Set([ids.bound, ids.mapped]));
    assert.deepEqual(list.scope, { projectId: 'cp-a', hostId: 'local', name: 'Codex A' });
    assert.ok(list.threads.every(item => item.hostId === 'local' && item.projectId === 'cp-a' && item.updatedAt));
    assert.equal(list.threads.find(item => item.threadId === ids.bound).title, '显示标题');
    assert.equal(list.threads.find(item => item.threadId === ids.mapped).title, '同名对话');
    assert.ok(!JSON.stringify(list).includes('不应显示的消息片段'));
    assert.ok(!JSON.stringify(list).includes('私密正文'));
    const projectless = await readCodexThreads(store.read().state, 'w-none', context);
    assert.deepEqual(projectless.threads.map(item => item.threadId), [ids.projectless]);
    await assert.rejects(readCodexThreads(store.read().state, 'missing', context), /不存在/);
    const remote = store.read().state; remote.workspaces[0].codexProject.hostId = 'remote';
    await assert.rejects(readCodexThreads(remote, 'w-a', context), /远程/);
  });
});

test('对话显示标题优先使用 name，name 为 null 或空字符串时回退 title', async () => {
  await withFixture(async ({ store, context, sql }) => {
    const query = () => readCodexThreads(store.read().state, 'w-a', context);
    assert.equal((await query()).threads.find(item => item.threadId === ids.bound).title, '显示标题');
    sql('UPDATE threads SET name = ? WHERE id = ?', '', ids.bound);
    assert.equal((await query()).threads.find(item => item.threadId === ids.bound).title, '不应显示的消息片段');
    sql('UPDATE threads SET name = NULL WHERE id = ?', ids.bound);
    assert.equal((await query()).threads.find(item => item.threadId === ids.bound).title, '不应显示的消息片段');
  });
});

test('绑定保存验证归属、解除后可重开；未改绑定的进度更新不依赖 Codex 元数据', async () => {
  await withFixture(async ({ store, open, context, folder }) => {
    const write = value => executeProjectTool(store, 'project_control_projects_write', value, context);
    let latest = store.read(); latest.state.projects[0].codexThread = binding(ids.other, 'cp-b');
    await assert.rejects(async () => write(latest), /绑定|当前项目|对话/);
    assert.equal(store.read().state.projects[0].codexThread.threadId, ids.bound);
    latest = store.read(); latest.state.projects[0].codexThread = binding(ids.mapped);
    await write(latest);
    assert.equal(open().read().state.projects[0].codexThread.threadId, ids.mapped);
    await writeFile(join(folder, '.codex-global-state.json'), 'controlled invalid metadata');
    latest = store.read(); latest.state.projects[0].progress = 55;
    await write(latest);
    assert.equal(store.read().state.projects[0].progress, 55);
    latest = store.read(); delete latest.state.projects[0].codexThread;
    await write(latest);
    assert.equal(open().read().state.projects[0].codexThread, undefined);
  });
});

test('已有绑定随需求移动必须重新验证范围', async () => {
  await withFixture(async ({ store, context }) => {
    let latest = store.read(); latest.state.projects[0].workspaceId = 'w-none';
    await assert.rejects(async () => executeProjectTool(store, 'project_control_projects_write', latest, context), /绑定|对话|当前项目/);
    assert.equal(store.read().state.projects[0].workspaceId, 'w-a');
  });
});

test('切换、解除或新增 Codex 项目绑定清空本项目所有需求对话，改名和其他项目保持不变', async () => {
  await withFixture(async ({ store, open, context, folder }) => {
    const initial = store.read();
    initial.state.projects.push({ ...requirement(binding(ids.mapped)), id: 'r-second' },
      { ...requirement(binding(ids.projectless, null)), id: 'r-free', workspaceId: 'w-none' });
    store.write(initial);
    const before = store.read();
    const renamed = renameWorkspace(before.state, 'w-a', '改名', { ...workspace.codexProject, name: '更新显示名', path: 'G:/updated' });
    assert.deepEqual(renamed.projects, before.state.projects);
    const switched = renameWorkspace(before.state, 'w-a', '项目 A', { ...workspace.codexProject, projectId: 'cp-b' });
    assert.ok(switched.projects.filter(item => item.workspaceId === 'w-a').every(item => !item.codexThread));
    assert.deepEqual(switched.projects[2], before.state.projects[2]);
    assert.equal(before.state.projects[0].codexThread.threadId, ids.bound, '纯变更不污染旧快照');
    // The host must also handle callers that only change workspaces, without UI helpers.
    await writeFile(join(folder, '.codex-global-state.json'), 'unavailable metadata');
    before.state.workspaces[0].codexProject.projectId = 'cp-b';
    const saved = await executeProjectTool(store, 'project_control_projects_write', before, context);
    assert.ok(saved.state.projects.filter(item => item.workspaceId === 'w-a').every(item => !item.codexThread));
    assert.deepEqual(open().read().state, saved.state);
    const unbound = renameWorkspace(state(binding()), 'w-a', '项目 A', null);
    assert.equal(unbound.projects[0].codexThread, undefined);
    const free = state(binding(ids.projectless, null)); delete free.workspaces[0].codexProject;
    assert.equal(renameWorkspace(free, 'w-a', '项目 A', workspace.codexProject).projects[0].codexThread, undefined);
    assert.equal(renameWorkspace(state(binding()), 'w-a', '项目 A', { ...workspace.codexProject, hostId: 'remote' }).projects[0].codexThread, undefined);
  });
});

for (const removed of ['archived', 'deleted']) test(`列表检测到已${removed}对话后清空绑定并持久化，重复读取不写入`, async () => {
  await withFixture(async ({ store, open, context, sql }) => {
    if (removed === 'archived') sql('UPDATE threads SET archived = 1 WHERE id = ?', ids.bound);
    else sql('DELETE FROM threads WHERE id = ?', ids.bound);
    const before = store.read();
    const list = await executeProjectTool(store, 'project_control_codex_threads', { workspaceId: 'w-a' }, context);
    assert.deepEqual(list.unavailableThreadIds, [ids.bound]);
    assert.equal(list.clearedBindings[0].requirementId, 'r-a');
    const saved = open().read();
    assert.equal(saved.state.projects[0].codexThread, undefined);
    assert.equal(saved.state.projects[0].progress, before.state.projects[0].progress);
    assert.equal(saved.revision, before.revision + 1);
    await executeProjectTool(store, 'project_control_codex_threads', { workspaceId: 'w-a' }, context);
    assert.equal(store.read().revision, saved.revision);
  });
});

test('归属冲突或读取失败不被当成删除；未保存的选择也可检测失效', async () => {
  await withFixture(async ({ store, context, metadata, saveMetadata, folder }) => {
    const before = store.read();
    metadata['thread-project-assignments'][ids.bound].projectId = 'cp-b'; await saveMetadata();
    const list = await executeProjectTool(store, 'project_control_codex_threads', { workspaceId: 'w-a', threadId: ids.archived }, context);
    assert.deepEqual(list.unavailableThreadIds, [ids.archived]);
    assert.deepEqual(store.read(), before);
    await writeFile(join(folder, '.codex-global-state.json'), '{invalid');
    await assert.rejects(executeProjectTool(store, 'project_control_codex_threads', { workspaceId: 'w-a' }, context));
    assert.deepEqual(store.read(), before);
  });
});

test('清理失效绑定合并最新进度，不清除已换绑、已移动或发送中的需求', async () => {
  await withFixture(async ({ store, open }) => {
    const second = open();
    const expected = [{ requirementId: 'r-a', route: requirementRoute(store.read().state.projects[0], workspace) }];
    let latest = second.read(); latest.state.projects[0].progress = 73; second.write(latest);
    const token = second.acquireRequirementSend('r-a');
    assert.deepEqual(store.clearUnavailableThreadBindings(expected), []);
    latest = second.read(); latest.state.workspaces[0].codexProject.projectId = 'cp-b';
    assert.throws(() => second.write(latest), /发送/);
    second.releaseRequirementSend('r-a', token);
    latest = second.read(); latest.state.projects[0].codexThread = binding(ids.mapped); second.write(latest);
    assert.deepEqual(store.clearUnavailableThreadBindings(expected), []);
    latest = second.read(); latest.state.projects[0].codexThread = binding(); latest.state.projects[0].workspaceId = 'w-none'; second.write(latest);
    assert.deepEqual(store.clearUnavailableThreadBindings(expected), []);
    latest = second.read(); latest.state.projects[0].workspaceId = 'w-a'; second.write(latest);
    assert.equal(store.clearUnavailableThreadBindings(expected).length, 1);
    assert.equal(second.read().state.projects[0].progress, 73);
    assert.equal(second.read().state.projects[0].codexThread, undefined);
  });
});

test('发送前及宿主检查后确认归档时清空绑定，本次不发送也不自动新建', async () => {
  for (const duringSend of [false, true]) await withFixture(async ({ store, context, sql }) => {
    const calls = [];
    if (!duringSend) sql('UPDATE threads SET archived = 1 WHERE id = ?', ids.bound);
    await withHost(hostResponder(calls, async call => {
      if (call.tool === 'read_thread') sql('UPDATE threads SET archived = 1 WHERE id = ?', ids.bound);
    }), async pipePath => {
      await assert.rejects(executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(), { ...context, pipePath }), /已清空/);
      assert.equal(store.read().state.projects[0].codexThread, undefined);
      assert.equal(calls.filter(item => ['send_message_to_thread', 'create_thread'].includes(item.tool)).length, 0);
    });
  });
});

test('项目列表发现 Codex 项目删除后持久解除项目及全部对话绑定，保留 AI 配置和其他项目', async () => {
  await withFixture(async ({ store, open, context, metadata, saveMetadata }) => {
    const initial = store.read();
    initial.state.workspaces[0].aiSettings = settings;
    initial.state.projects.push({ ...requirement(binding(ids.mapped)), id: 'r-second' },
      { ...requirement(binding(ids.projectless, null)), id: 'r-free', workspaceId: 'w-none' });
    store.write(initial);
    const before = store.read();
    delete metadata['local-projects']['cp-a']; await saveMetadata();
    const result = await executeProjectTool(store, 'project_control_codex_projects', {}, context);
    assert.deepEqual(result.clearedWorkspaces.map(item => item.workspaceId), ['w-a']);
    const saved = open().read();
    assert.equal(saved.state.workspaces[0].codexProject, undefined);
    assert.deepEqual(saved.state.workspaces[0].aiSettings, settings);
    assert.ok(saved.state.projects.filter(item => item.workspaceId === 'w-a').every(item => !item.codexThread));
    assert.deepEqual(saved.state.projects[2], before.state.projects[2]);
    assert.equal(saved.state.projects[0].progress, 20);
    assert.equal(saved.revision, before.revision + 1);
    await executeProjectTool(store, 'project_control_codex_projects', {}, context);
    assert.equal(store.read().revision, saved.revision);
  });
});

test('对话检测可解除已删除的项目并返回无项目候选', async () => {
  await withFixture(async ({ store, context, metadata, saveMetadata }) => {
    delete metadata['local-projects']['cp-a']; await saveMetadata();
    const result = await executeProjectTool(store, 'project_control_codex_threads', { workspaceId: 'w-a', threadId: ids.bound }, context);
    assert.equal(result.scope.projectId, null);
    assert.deepEqual(result.threads.map(item => item.threadId), [ids.projectless]);
    assert.equal(result.clearedWorkspaces[0].workspaceId, 'w-a');
    assert.equal(store.read().state.workspaces[0].codexProject, undefined);
    assert.equal(store.read().state.projects[0].codexThread, undefined);
  });
});

test('项目元数据读取失败、格式异常或远程项目不触发误清理', async () => {
  await withFixture(async ({ store, context, metadata, saveMetadata, folder }) => {
    const before = store.read();
    for (const data of ['{broken', JSON.stringify({ 'local-projects': [] }), JSON.stringify({})]) {
      await writeFile(join(folder, '.codex-global-state.json'), data);
      await assert.rejects(executeProjectTool(store, 'project_control_codex_projects', {}, context), /Codex 项目/);
      assert.deepEqual(store.read(), before);
    }
    // An incomplete existing entry is not authoritative evidence of deletion.
    metadata['local-projects']['cp-a'] = { id: 'cp-a' }; await saveMetadata();
    await executeProjectTool(store, 'project_control_codex_projects', {}, context);
    assert.deepEqual(store.read(), before);
    const remote = store.read(); remote.state.workspaces[0].codexProject.hostId = 'remote'; store.write(remote);
    delete metadata['local-projects']['cp-a']; await saveMetadata();
    const remoteBefore = store.read();
    await executeProjectTool(store, 'project_control_codex_projects', {}, context);
    assert.deepEqual(store.read(), remoteBefore);
  });
});

test('失效项目清理不覆盖并发换绑或进度，存在其他发送锁时整个项目保持原状', async () => {
  await withFixture(async ({ store, open }) => {
    const second = open(), expected = [{ workspaceId: 'w-a', key: codexProjectKey(workspace.codexProject) }];
    let latest = second.read(); latest.state.projects.push({ ...requirement(binding(ids.mapped)), id: 'r-second' }); second.write(latest);
    const token = second.acquireRequirementSend('r-a'), otherToken = second.acquireRequirementSend('r-second');
    const locked = second.read();
    assert.deepEqual(store.clearMissingCodexProjects(expected, token), []);
    assert.deepEqual(second.read(), locked);
    second.releaseRequirementSend('r-a', token); second.releaseRequirementSend('r-second', otherToken);
    latest = second.read(); latest.state.workspaces[0].codexProject.projectId = 'cp-b'; second.write(latest);
    assert.deepEqual(store.clearMissingCodexProjects(expected), []);
    latest = second.read(); latest.state.workspaces[0].codexProject.projectId = 'cp-a'; latest.state.projects[0].progress = 77; second.write(latest);
    assert.equal(store.clearMissingCodexProjects(expected).length, 1);
    assert.equal(second.read().state.workspaces[0].codexProject, undefined);
    assert.equal(second.read().state.projects[0].progress, 77);
  });
});

test('发送前发现项目已删除会清空绑定但本次不发送，下一次显式发送使用无项目', async () => {
  for (const initialBinding of [binding(), null]) await withFixture(async ({ store, context, metadata, saveMetadata }) => {
    delete metadata['local-projects']['cp-a']; await saveMetadata();
    const calls = [];
    await withHost(hostResponder(calls), async pipePath => {
      const options = { ...context, pipePath };
      await assert.rejects(executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(initialBinding?.threadId ?? null), options), /项目.*已.*清空|项目.*已.*解除/);
      assert.equal(calls.length, 0);
      assert.equal(store.read().state.workspaces[0].codexProject, undefined);
      assert.equal(store.read().state.projects[0].codexThread, undefined);
      await executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(null), options);
      assert.deepEqual(calls.find(item => item.tool === 'create_thread').arguments.target, { type: 'projectless' });
    });
  }, initialBinding);
});

test('宿主检查期间 Codex 项目被删除，最终发送前仍清理并阻止消息', async () => {
  await withFixture(async ({ store, context, metadata, saveMetadata }) => {
    const calls = [];
    await withHost(hostResponder(calls, async call => {
      if (call.tool === 'read_thread') { delete metadata['local-projects']['cp-a']; await saveMetadata(); }
    }), async pipePath => {
      await assert.rejects(executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(), { ...context, pipePath }), /项目.*已.*清空/);
      assert.equal(store.read().state.workspaces[0].codexProject, undefined);
      assert.equal(store.read().state.projects[0].codexThread, undefined);
      assert.equal(calls.filter(item => ['send_message_to_thread', 'create_thread'].includes(item.tool)).length, 0);
    });
  });
});

test('v4 数据迁移一次推进 revision，保留需求进展和已有字段', async () => {
  await withFixture(async ({ store, filename, open }) => {
    store.close();
    const legacy = state(); legacy.version = 4; legacy.projects[0].summary = '迁移保留';
    const db = new DatabaseSync(filename);
    db.prepare('UPDATE project_document SET revision = 7, state = ? WHERE id = 1').run(JSON.stringify(legacy)); db.close();
    const migrated = open().read();
    assert.equal(migrated.revision, 8); assert.equal(migrated.state.version, 5);
    assert.equal(migrated.state.projects[0].summary, '迁移保留'); assert.equal(migrated.state.projects[0].progress, 20);
    assert.equal(migrated.state.projects[0].codexThread, undefined);
    assert.equal(open().read().revision, 8);
  });
});

test('错误需求、工作区和过期 expectedThreadId 在任何宿主调用前拒绝', async () => {
  await withFixture(async ({ store, context }) => {
    const calls = [];
    await withHost(hostResponder(calls), async pipePath => {
      for (const args of [sendArgs(ids.bound, { requirementId: 'missing' }), sendArgs(ids.bound, { workspaceId: 'w-none' }), sendArgs(null), sendArgs(ids.other)]) {
        await assert.rejects(async () => executeProjectTool(store, 'project_control_codex_ai_send', args, { ...context, pipePath }), /需求|绑定|项目/);
      }
      assert.equal(calls.length, 0);
    });
  });
});

test('既有绑定按存储真实目标发送，同时保留真实 caller 和 turn 上下文', async () => {
  await withFixture(async ({ store, context }) => {
    const calls = [];
    await withHost(hostResponder(calls), async pipePath => {
      const receipt = await executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(), { ...context, pipePath });
      assert.equal(receipt.accepted, true); assert.equal(receipt.threadId, ids.bound);
      assert.deepEqual(calls.map(item => item.tool), ['read_thread', 'send_message_to_thread']);
      assert.ok(calls.every(item => item.threadId === 'actual-caller' && item.turnId === 'actual-turn'));
      assert.equal(calls[0].arguments.threadId, ids.bound);
      assert.deepEqual(calls[1].arguments, { threadId: ids.bound, prompt: '执行已授权需求', model: 'model-a', thinking: 'high' });
    });
  });
});

for (const projectless of [false, true]) test(`未绑定${projectless ? '无项目' : '项目'}需求直接新建并自动绑定，不借用调用聊天或桌面选择`, async () => {
  await withFixture(async ({ store, context }) => {
    if (projectless) { const latest = store.read(); latest.state.projects[0].workspaceId = 'w-none'; store.write(latest); }
    const calls = [];
    await withHost(hostResponder(calls), async pipePath => {
      const receipt = await executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(null, { workspaceId: projectless ? 'w-none' : 'w-a' }), { ...context, pipePath });
      assert.equal(receipt.accepted, true); assert.equal(receipt.createdThread, true); assert.equal(receipt.bindingSaved, true);
      const created = calls.filter(item => item.tool === 'create_thread'); assert.equal(created.length, 1);
      assert.deepEqual(created[0].arguments.target, projectless ? { type: 'projectless' } : { type: 'project', projectId: 'cp-a', environment: { type: 'local' } });
      assert.equal(created[0].arguments.prompt, '执行已授权需求'); assert.equal(created[0].arguments.model, 'model-a');
      assert.ok(!calls.some(item => ['read_thread', 'send_message_to_thread'].includes(item.tool)));
      assert.deepEqual(store.read().state.projects[0].codexThread, { threadId: ids.created, hostId: 'local', title: store.read().state.projects[0].codexThread.title, projectId: projectless ? null : 'cp-a' });
    });
  }, null);
});

test('需求发送锁跨连接阻止重复创建和移动，同时允许进度回写并合并自动绑定', async () => {
  await withFixture(async ({ store, open, context }) => {
    const second = open(), calls = [];
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    await withHost(hostResponder(calls, async call => {
      if (call.tool === 'create_thread') { entered(); await gate; }
    }), async pipePath => {
      const options = { ...context, pipePath };
      const pending = executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(null), options);
      try {
        await Promise.race([started, pending.then(() => { throw new Error('发送未经过受控创建边界'); })]);
        await assert.rejects(async () => executeProjectTool(second, 'project_control_codex_ai_send', sendArgs(null), options), /发送|等待/);
        const moved = second.read(); moved.state.projects[0].workspaceId = 'w-none';
        assert.throws(() => second.write(moved), /发送/);
        const removed = second.read(); removed.state.projects = [];
        assert.throws(() => second.write(removed), /发送/);
        const rebound = second.read(); rebound.state.projects[0].codexThread = binding();
        assert.throws(() => second.write(rebound), /发送/);
        const progress = second.read(); progress.state.projects[0].progress = 75;
        progress.state.projects[0].updates.push({ id: 'simultaneous', at: '2026-10-30T01:00:00.000Z', kind: 'progress', text: '同时完成回归' });
        second.write(progress);
      } finally { release(); }
      assert.equal((await pending).bindingSaved, true);
      const saved = second.read().state.projects[0]; assert.equal(saved.progress, 75); assert.equal(saved.updates[0].text, '同时完成回归');
      assert.equal(saved.codexThread.threadId, ids.created); assert.equal(calls.filter(item => item.tool === 'create_thread').length, 1);
    });
  }, null);
});

test('目标忙碌、临时宿主、错误回执与发送拒绝均不新建、不降级、不自动重试', async () => {
  await withFixture(async ({ store, context }) => {
    let mode = 'busy'; const calls = [];
    await withHost(hostResponder(calls, async call => {
      if (call.tool === 'read_thread' && mode === 'busy') return result({ thread: { id: ids.bound, status: { type: 'active' } } });
      if (call.tool === 'read_thread' && mode === 'ephemeral') return failure('ephemeral threads do not support thread/turns/list');
      if (call.tool === 'send_message_to_thread') return mode === 'wrong' ? result({ threadId: ids.other }) : failure('发送被拒绝');
    }), async pipePath => {
      for (mode of ['busy', 'ephemeral', 'wrong', 'rejected']) await assert.rejects(async () => executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(), { ...context, pipePath }), /正在|绑定|未确认|未知|发送/);
      assert.equal(calls.filter(item => item.tool === 'create_thread').length, 0);
      assert.equal(calls.filter(item => item.tool === 'send_message_to_thread').length, 2);
      assert.equal(store.read().state.projects[0].codexThread.threadId, ids.bound);
    });
  });
});

test('发送前重检归属，目标被移出当前 Codex 项目后不发送', async () => {
  await withFixture(async ({ store, context, metadata, saveMetadata }) => {
    const calls = [];
    await withHost(hostResponder(calls, async call => {
      if (call.tool === 'read_thread') { metadata['thread-project-assignments'][ids.bound].projectId = 'cp-b'; await saveMetadata(); }
    }), async pipePath => {
      await assert.rejects(async () => executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(), { ...context, pipePath }), /绑定|项目|对话/);
      assert.equal(calls.filter(item => ['send_message_to_thread', 'create_thread'].includes(item.tool)).length, 0);
    });
  });
});

test('新建失败或首条消息回执不明确时不保存绑定、不重试，失败后释放锁', async () => {
  await withFixture(async ({ store, context }) => {
    const calls = []; let receipt;
    await withHost(hostResponder(calls, async call => call.tool === 'create_thread' ? receipt : undefined), async pipePath => {
      const replies = [failure('创建失败'), result({ clientThreadId: 'queued' }), result({ threadId: ids.created, hostId: 'remote' })];
      for (receipt of replies) {
        await assert.rejects(async () => executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(null), { ...context, pipePath }), /未确认|未知|失败/);
        assert.equal(store.read().state.projects[0].codexThread, undefined);
      }
      assert.equal(calls.filter(item => item.tool === 'create_thread').length, replies.length);
    });
  }, null);
});

test('首条消息确认后 SQLite 保存绑定失败仍报告已发送及恢复提示，绝不重发', async () => {
  await withFixture(async ({ store, context, filename }) => {
    const calls = [];
    await withHost(hostResponder(calls, async call => {
      if (call.tool === 'create_thread') {
        const db = new DatabaseSync(filename);
        try { db.exec("CREATE TRIGGER reject_binding BEFORE UPDATE ON project_document BEGIN SELECT RAISE(ABORT, 'controlled binding write failure'); END"); }
        finally { db.close(); }
      }
    }), async pipePath => {
      const receipt = await executeProjectTool(store, 'project_control_codex_ai_send', sendArgs(null), { ...context, pipePath });
      assert.equal(receipt.accepted, true); assert.equal(receipt.createdThread, true);
      assert.equal(receipt.threadId, ids.created); assert.equal(receipt.bindingSaved, false);
      assert.match(receipt.bindingError, /已发送/); assert.match(receipt.bindingError, /不要重复发送/);
      assert.ok(receipt.bindingError.includes(ids.created));
      assert.equal(calls.filter(item => item.tool === 'create_thread').length, 1);
      assert.equal(calls.filter(item => item.tool === 'send_message_to_thread').length, 0);
      assert.equal(store.read().state.projects[0].codexThread, undefined);
      const db = new DatabaseSync(filename);
      try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM requirement_send_lock').get().count, 0); }
      finally { db.close(); }
    });
  }, null);
});
