import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { executeProjectTool } from '../src/project-tools.mjs';

async function withCodex(run) {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-ai-codex-'));
  try {
    await writeFile(join(folder, 'models_cache.json'), JSON.stringify({ fetched_at: '2026-10-30T00:00:00Z', models: [
      { slug: 'model-a', display_name: '模型 A', visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], private: '不可返回' },
      { slug: 'model-b', display_name: '模型 B', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] },
      { slug: 'hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] }
    ] }));
    const db = new DatabaseSync(join(folder, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, model TEXT, reasoning_effort TEXT, first_user_message TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('caller-a', 'model-a', 'high', '私密聊天正文');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('caller-b', 'model-b', 'medium', '不可返回');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run('caller-default', 'model-b', null, '不可返回');
    db.close();
    await run({ codexHome: folder, pipePath: '' });
  } finally {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-ai-codex-'));
    await rm(folder, { recursive: true, force: true });
  }
}

test('从 Codex 模型目录读取支持强度，当前配置严格按调用聊天取值，不泄漏正文', async () => {
  await withCodex(async context => {
    const result = await executeProjectTool(null, 'project_control_codex_ai_read', {}, { ...context, meta: { threadId: 'caller-a' } });
    assert.deepEqual(result.current, { model: 'model-a', reasoningEffort: 'high' });
    assert.deepEqual(result.models.map(m => [m.id, m.reasoningEfforts]), [['model-a', ['low', 'high']], ['model-b', ['medium']]]);
    assert.ok(!JSON.stringify(result).includes('私密'));
    assert.ok(!JSON.stringify(result).includes('不可返回'));
    assert.equal(result.canSend, false);
    assert.equal((await executeProjectTool(null, 'project_control_codex_ai_read', {}, context)).current, null);
    assert.equal((await executeProjectTool(null, 'project_control_codex_ai_read', {}, { ...context, meta: { threadId: 'unknown' } })).current, null);
    const inherited = await executeProjectTool(null, 'project_control_codex_ai_read', {}, { ...context, meta: { threadId: 'caller-default' } });
    assert.deepEqual(inherited.current, { model: 'model-b', reasoningEffort: 'medium' });
    assert.equal(inherited.currentEffortSource, 'model-default');
  });
});

// Real pipe framing against a controlled host boundary, not a real Codex turn.
async function withHost(handle, run) {
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\project-control-test-${randomUUID()}` : join(tmpdir(), `pc-${randomUUID()}.sock`);
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', async chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4 || pending.length < pending.readUInt32LE(0) + 4) return;
      const request = JSON.parse(pending.subarray(4).toString());
      const response = await handle(request);
      const data = Buffer.from(JSON.stringify({ id: request.id, jsonrpc: '2.0', ...response }));
      const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
      socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), data]));
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(pipePath, done); });
  try { await run(pipePath); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); }
}

const toolList = { tools: ['send_message_to_thread', 'create_thread'].map(name => ({ namespace: 'codex_app', name,
  inputSchema: { properties: { model: { type: 'string' }, thinking: { type: 'string' } } } })) };
const hostResult = value => ({ result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] } });
const hostError = text => ({ result: { success: false, contentItems: [{ type: 'inputText', text }] } });
const ephemeralError = () => hostError('ephemeral threads do not support thread/turns/list');
const createdId = '01a18d15-4aa8-7c43-8415-ebeb40c85972';
async function selectProject(context, selected = { type: 'local', projectId: 'project-a' }) {
  await writeFile(join(context.codexHome, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { 'project-a': { id: 'project-a', name: '甲项目', rootPaths: ['G:/project-a'] } },
    'selected-project': selected,
  }));
}

test('新聊天的临时宿主创建正式项目聊天并在首条消息中携带所选配置', async () => {
  await withCodex(async context => {
    await selectProject(context);
    const calls = [];
    await withHost(async request => {
      if (request.method === 'tools/list') return { result: toolList };
      calls.push(request.params);
      if (request.params.tool === 'read_thread') return ephemeralError();
      if (request.params.tool === 'list_projects') return hostResult({ projects: [{ projectId: 'project-a', projectKind: 'local', hostId: 'local' }] });
      return hostResult({ threadId: createdId, hostId: 'local' });
    }, async pipePath => {
      const result = await executeProjectTool(null, 'project_control_codex_ai_send',
        { text: '开发需求正文', settings: { model: 'model-b', reasoningEffort: 'medium' } },
        { ...context, pipePath, meta: { threadId: 'ephemeral-host' } });
      assert.deepEqual(result, { accepted: true, createdThread: true, threadId: createdId, projectName: '甲项目',
        settings: { model: 'model-b', reasoningEffort: 'medium' } });
      assert.deepEqual(calls.map(c => c.tool), ['read_thread', 'list_projects', 'create_thread']);
      assert.deepEqual(calls.at(-1).arguments, { prompt: '开发需求正文', model: 'model-b', thinking: 'medium',
        target: { type: 'project', projectId: 'project-a', environment: { type: 'local' } } });
      assert.equal(calls.at(-1).threadId, 'ephemeral-host');
    });
  });
});

test('普通读取错误、缺失状态或其他聊天回执都不能触发新建聊天', async () => {
  await withCodex(async context => {
    let statusReply; let writes = 0;
    await withHost(async request => {
      if (request.method === 'tools/list') return { result: toolList };
      if (request.params.tool === 'read_thread') return statusReply;
      writes++; return hostResult({ threadId: createdId, hostId: 'local' });
    }, async pipePath => {
      for (const reply of [hostError('thread not found'), hostResult({}),
        hostResult({ thread: { id: 'wrong', status: { type: 'idle' } } })]) {
        statusReply = reply;
        await assert.rejects(executeProjectTool(null, 'project_control_codex_ai_send',
          { text: '需求', settings: { model: 'model-a', reasoningEffort: 'high' } },
          { ...context, pipePath, meta: { threadId: 'unknown' } }), /无法确认当前聊天/);
      }
      assert.equal(writes, 0);
    });
  });
});

test('新聊天缺少当前项目、项目不在宿主目录或发送途中切换项目时不创建', async () => {
  await withCodex(async context => {
    let projects = [], changeSelection = false, writes = 0;
    await withHost(async request => {
      if (request.method === 'tools/list') return { result: toolList };
      if (request.params.tool === 'read_thread') return ephemeralError();
      if (request.params.tool === 'list_projects') {
        if (changeSelection) await selectProject(context, null);
        return hostResult({ projects });
      }
      writes++; return hostResult({ threadId: createdId, hostId: 'local' });
    }, async pipePath => {
      const send = () => executeProjectTool(null, 'project_control_codex_ai_send',
        { text: '需求', settings: { model: 'model-a', reasoningEffort: 'high' } },
        { ...context, pipePath, meta: { threadId: 'ephemeral-host' } });
      await selectProject(context, null);
      await assert.rejects(send(), /选择.*项目/);
      await selectProject(context);
      await assert.rejects(send(), /项目.*不可用/);
      projects = [{ projectId: 'project-a', projectKind: 'local', hostId: 'remote' }];
      await assert.rejects(send(), /项目.*不可用/);
      projects[0].hostId = 'local'; changeSelection = true;
      await assert.rejects(send(), /项目.*变化/);
      assert.equal(writes, 0);
    });
  });
});

test('新聊天创建失败或没有首条消息接收回执时，不报告成功、不自动重发', async () => {
  await withCodex(async context => {
    await selectProject(context);
    let receipt, creates = 0;
    await withHost(async request => {
      if (request.method === 'tools/list') return { result: toolList };
      if (request.params.tool === 'read_thread') return ephemeralError();
      if (request.params.tool === 'list_projects') return hostResult({ projects: [{ projectId: 'project-a', projectKind: 'local', hostId: 'local' }] });
      creates++; return receipt;
    }, async pipePath => {
      const replies = [hostError('creation rejected'), hostResult({ clientThreadId: 'queued', hostId: 'local' }),
        hostResult({ status: 'created', conversationId: createdId, firstTurn: { status: 'failed' }, hostId: 'local' }),
        hostResult({ threadId: createdId, hostId: 'remote' })];
      for (const reply of replies) {
        receipt = reply;
        await assert.rejects(executeProjectTool(null, 'project_control_codex_ai_send',
          { text: '需求', settings: { model: 'model-a', reasoningEffort: 'high' } },
          { ...context, pipePath, meta: { threadId: 'ephemeral-host' } }), /未确认|未知/);
      }
      assert.equal(creates, replies.length);
    });
  });
});
test('发送按宿主聊天定位，携带明确模型和思维，并在聊天运行时阻止发送', async () => {
  await withCodex(async context => {
    let status = 'idle'; const calls = [];
    await withHost(async request => {
      if (request.method === 'tools/list') return { result: toolList };
      calls.push(request.params);
      if (request.params.tool === 'read_thread') return hostResult({ thread: { id: 'caller-a', status: { type: status } } });
      return hostResult({ threadId: 'caller-a' });
    }, async pipePath => {
      const options = { ...context, pipePath, meta: { threadId: 'caller-a' } };
      const args = { text: '验证消息', settings: { model: 'model-a', reasoningEffort: 'high' } };
      assert.equal((await executeProjectTool(null, 'project_control_codex_ai_send', args, options)).accepted, true);
      const sent = calls.filter(c => c.tool === 'send_message_to_thread');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].threadId, 'caller-a');
      assert.deepEqual(sent[0].arguments, { threadId: 'caller-a', prompt: '验证消息', model: 'model-a', thinking: 'high' });
      status = 'active';
      await assert.rejects(executeProjectTool(null, 'project_control_codex_ai_send', args, options), /正在|结束/);
      assert.equal(calls.filter(c => c.tool === 'send_message_to_thread').length, 1);
      assert.ok(calls.every(c => c.namespace === 'codex_app'));
    });
  });
});

test('不支持的强度和宿主设置/发送失败均不降级重发', async () => {
  await withCodex(async context => {
    let sends = 0;
    await withHost(async request => {
      if (request.method === 'tools/list') return { result: toolList };
      if (request.params.tool === 'read_thread') return hostResult({ thread: { id: 'caller-a', status: { type: 'idle' } } });
      sends++; return { result: { success: false, contentItems: [{ type: 'inputText', text: 'settings rejected' }] } };
    }, async pipePath => {
      const options = { ...context, pipePath, meta: { threadId: 'caller-a' } };
      await assert.rejects(executeProjectTool(null, 'project_control_codex_ai_send', { text: '消息', settings: { model: 'model-b', reasoningEffort: 'ultra' } }, options), /不可用/);
      assert.equal(sends, 0);
      await assert.rejects(executeProjectTool(null, 'project_control_codex_ai_send', { text: '消息', settings: { model: 'model-b', reasoningEffort: 'medium' } }, options), /未确认/);
      assert.equal(sends, 1);
    });
  });
});

test('宿主成功回执若指向其他聊天，不能报告发送成功或自动重试', async () => {
  await withCodex(async context => {
    let sends = 0;
    await withHost(async request => {
      if (request.method === 'tools/list') return { result: toolList };
      if (request.params.tool === 'read_thread') return hostResult({ thread: { id: 'caller-a', status: { type: 'idle' } } });
      sends++; return hostResult({ threadId: 'caller-b' });
    }, async pipePath => {
      await assert.rejects(executeProjectTool(null, 'project_control_codex_ai_send',
        { text: '消息', settings: { model: 'model-a', reasoningEffort: 'high' } },
        { ...context, pipePath, meta: { threadId: 'caller-a' } }), /目标聊天|结果未知/);
      assert.equal(sends, 1);
    });
  });
});

test('发送工具不接受外部指定目标，缺少调用聊天或本地通道时拒绝发送', async () => {
  await withCodex(async context => {
    const args = { text: '验证消息', settings: { model: 'model-a', reasoningEffort: 'high' } };
    await assert.rejects(async () => executeProjectTool(null, 'project_control_codex_ai_send', { ...args, threadId: 'caller-b' }, context), /输入无效/);
    await assert.rejects(async () => executeProjectTool(null, 'project_control_codex_ai_send', args, context), /聊天/);
    await assert.rejects(async () => executeProjectTool(null, 'project_control_codex_ai_send', args, { ...context, meta: { threadId: 'caller-a' } }), /通道/);
  });
});
