import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { openProjectStore } from '../src/project-store.mjs';
import { executeProjectTool } from '../src/project-tools.mjs';
import { askAi, configureTransport, sendToCodex, readCodexThreads } from '../src/console/client/api.js';
import { requirementScope, availableRequirementThreads, RequirementChat } from '../src/console/client/requirement-chat.js';
import { blankDraft, draftFromProject, projectFromDraft } from '../src/console/client/panel.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const settings = { model: 'model-a', reasoningEffort: 'high' };

// A transport test double isolates the host. This is not proof of real Codex delivery.
async function withStore(run) {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-bridge-'));
  const store = openProjectStore(join(folder, 'projects.sqlite'));
  store.write({ revision: 0, state: { ...store.read().state, workspaces: [{ id: 'test-project', name: '测试项目', modules: [] }] } });
  try { await run(store); }
  finally {
    configureTransport(undefined);
    store.close();
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-bridge-'));
    await rm(folder, { recursive: true, force: true });
  }
}

test('AI adapter associates the instruction and returns a proposal without applying it', async () => {
  await withStore(async store => {
    let id;
    configureTransport({
      call: async (name, args) => {
        if (name === 'project_control_codex_ai_send') {
          assert.deepEqual(args.settings, settings);
          assert.ok(args.text.includes(id));
          assert.ok(args.text.includes('查询项目数量'));
          assert.ok(args.text.includes('只生成预览'));
          store.propose({ requestId: id, plan: { intent: 'query', reply: '0 个项目', actions: [] } });
          return { accepted: true, settings };
        }
        const result = executeProjectTool(store, name, args);
        if (name === 'project_control_request_create') id = result.id;
        return result;
      },
      sendMessage: async () => assert.fail('不能再通过 ui/message 双发'),
    });
    const before = store.read();
    const reply = await askAi('查询项目数量', [], '2026-10-30', { settings });
    assert.equal(reply.id, id);
    assert.equal(reply.status, 'ready');
    assert.equal(reply.plan.reply, '0 个项目');
    assert.deepEqual(store.read(), before);
  });
});

test('failed host delivery cancels its request without pretending the AI responded', async () => {
  await withStore(async store => {
    let id;
    configureTransport({
      call: async (name, args) => {
        if (name === 'project_control_codex_ai_send') throw new Error('消息未能交给 Codex');
        const result = executeProjectTool(store, name, args);
        if (name === 'project_control_request_create') id = result.id;
        return result;
      },
      sendMessage: async () => ({ isError: true }),
    });
    await assert.rejects(askAi('查询项目数量', [], '2026-10-30', { settings }), /消息未能交给 Codex/);
    assert.equal(store.readRequest(id).status, 'cancelled');
    assert.equal(store.read().revision, 1);
  });
});

test('closing while request creation is pending prevents sending and cancels the request', async () => {
  await withStore(async store => {
    const controller = new AbortController();
    let id;
    let sent = 0;
    configureTransport({
      call: async (name, args) => {
        const result = executeProjectTool(store, name, args);
        if (name === 'project_control_request_create') { id = result.id; controller.abort(); }
        return result;
      },
      sendMessage: async () => { sent++; return {}; },
    });
    await assert.rejects(askAi('查询项目数量', [], '2026-10-30', { signal: controller.signal, settings }), { name: 'AbortError' });
    assert.equal(sent, 0);
    assert.equal(store.readRequest(id).status, 'cancelled');
  });
});

test('所有发送必须带完整模型配置并取得宿主确认，不退回普通消息接口', async () => {
  const calls = [];
  configureTransport({ call: async (name, args) => { calls.push({ name, args }); return {}; },
    sendMessage: async () => assert.fail('不允许无模型发送') });
  try {
    await assert.rejects(sendToCodex('需求'), /模型|思维/);
    assert.equal(calls.length, 0);
    await assert.rejects(sendToCodex('需求', settings), /未确认/);
    assert.deepEqual(calls, [{ name: 'project_control_codex_ai_send', args: { text: '需求', settings } }]);
  } finally { configureTransport(undefined); }
});

test('新聊天发送确认后才打开，导航失败仍保留成功回执且不重发', async () => {
  const threadId = '01a18d15-4aa8-7c43-8415-ebeb40c85972';
  let calls = 0, opens = 0, navigationFails = false;
  configureTransport({
    call: async () => { calls++; return { accepted: true, createdThread: true, threadId, projectName: '甲项目', settings }; },
    openThread: async id => { assert.equal(id, threadId); opens++; if (navigationFails) throw new Error('navigation failed'); return {}; },
  });
  try {
    const sent = await sendToCodex('需求', settings);
    assert.equal(sent.createdThread, true);
    assert.equal(sent.navigationError, undefined);
    assert.equal(opens, 1);
    navigationFails = true;
    const kept = await sendToCodex('另一条需求', settings);
    assert.equal(kept.accepted, true);
    assert.match(kept.navigationError, /已发送.*左侧/);
    assert.equal(calls, 2);
    assert.equal(opens, 2);
  } finally { configureTransport(undefined); }
});

test('新聊天 AI 填充保持原面板等待预览，不因自动导航取消请求', async () => {
  await withStore(async store => {
    let id, opens = 0;
    configureTransport({
      call: async (name, args) => {
        if (name === 'project_control_codex_ai_send') {
          store.propose({ requestId: id, plan: { intent: 'query', reply: '查询完成', actions: [] } });
          return { accepted: true, createdThread: true, threadId: 'new-chat', projectName: '甲项目', settings };
        }
        const value = executeProjectTool(store, name, args);
        if (name === 'project_control_request_create') id = value.id;
        return value;
      },
      openThread: async () => { opens++; return {}; },
    });
    const messages = [];
    const result = await askAi('查询需求', [], '2026-10-30', { settings, onStatus: message => messages.push(message) });
    assert.equal(result.status, 'ready');
    assert.equal(store.readRequest(id).status, 'ready');
    assert.equal(opens, 0);
    assert.match(messages[0], /已在「甲项目」创建.*等待变更预览/);
  });
});

test('需求对话查询按 workspace 发送，绑定保存失败仍返回已发送回执', async () => {
  const calls = [];
  const requirement = { requirementId: 'r1', workspaceId: 'w1', expectedThreadId: null };
  configureTransport({ call: async (name, args) => {
    calls.push({ name, args });
    return name === 'project_control_codex_threads' ? { threads: [] }
      : { accepted: true, createdThread: true, threadId: 'new-thread', bindingSaved: false, bindingError: '修订冲突' };
  }, openThread: async () => assert.fail('本测试要求不导航') });
  try {
    assert.deepEqual(await readCodexThreads('w1'), { threads: [] });
    const receipt = await sendToCodex('开发需求', settings, { requirement, openCreatedThread: false });
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.bindingSaved, false);
    assert.equal(receipt.bindingError, '修订冲突');
    assert.deepEqual(calls, [
      { name: 'project_control_codex_threads', args: { workspaceId: 'w1' } },
      { name: 'project_control_codex_ai_send', args: { text: '开发需求', settings, requirement } },
    ]);
  } finally { configureTransport(undefined); }
});

test('需求草稿重发读取最新绑定；已删除或移动需求不能退回当前聊天', () => {
  const project = { id: 'r1', workspaceId: 'w1' };
  assert.deepEqual(requirementScope([project], 'r1', 'w1'), { requirementId: 'r1', workspaceId: 'w1', expectedThreadId: null });
  const latest = { ...project, codexThread: { threadId: 'auto-created' } };
  assert.equal(requirementScope([latest], 'r1', 'w1').expectedThreadId, 'auto-created');
  assert.equal(requirementScope([latest], 'r1', 'w1', 'auto-created').expectedThreadId, 'auto-created');
  assert.throws(() => requirementScope([latest], 'r1', 'w1', null), /绑定已变化/);
  assert.throws(() => requirementScope([{ ...latest, codexThread: { threadId: 'manually-rebound' } }], 'r1', 'w1', 'auto-created'), /绑定已变化/);
  assert.throws(() => requirementScope([], 'r1', 'w1'), /删除或已移动/);
  assert.throws(() => requirementScope([{ ...latest, workspaceId: 'w2' }], 'r1', 'w1'), /删除或已移动/);
});

test('对话候选严格限定本机及明确项目归属，无项目不接受缺失归属字段', () => {
  const threads = [
    { threadId: 'local-project', hostId: 'local', projectId: 'cp1' },
    { threadId: 'other-project', hostId: 'local', projectId: 'cp2' },
    { threadId: 'remote', hostId: 'remote', projectId: 'cp1' },
    { threadId: 'unassigned', hostId: 'local', projectId: null },
    { threadId: 'unknown', hostId: 'local' },
  ];
  assert.deepEqual(availableRequirementThreads(threads, { codexProject: { hostId: 'local', projectId: 'cp1' } }).map(item => item.threadId), ['local-project']);
  assert.deepEqual(availableRequirementThreads(threads, {}).map(item => item.threadId), ['unassigned']);
  assert.deepEqual(availableRequirementThreads(threads, { codexProject: { hostId: 'remote', projectId: 'cp1' } }), []);
});

test('新建/编辑草稿保留绑定字段，可显式解除绑定；选择器保留不可用的当前绑定', () => {
  const workspace = { id: 'w1', modules: ['模块'] };
  const binding = { threadId: 't1', hostId: 'local', title: '已有对话', projectId: null };
  assert.equal(blankDraft(workspace).codexThread, null);
  const existing = { ...projectFromDraft({ ...blankDraft(workspace), name: '需求', codexThread: binding }), id: 'r1' };
  assert.deepEqual(draftFromProject(existing).codexThread, binding);
  assert.deepEqual(projectFromDraft(draftFromProject(existing), existing).codexThread, binding);
  assert.equal(projectFromDraft({ ...draftFromProject(existing), codexThread: null }, existing).codexThread, null);
  const markup = renderToStaticMarkup(React.createElement(RequirementChat, { workspace, value: binding, onChange: () => true }));
  assert.match(markup, /已有对话（当前绑定，列表中不可用）/);
  assert.match(markup, /解除绑定/);
  assert.match(markup, /aria-label="绑定 Codex 对话"/);
  assert.doesNotMatch(markup, /绑定 Codex 对话（可选）|未绑定时发送将新建对话并自动绑定/);
});
