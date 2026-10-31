import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultWorkspaceId } from '../src/console/shared/hierarchy.js';

// Mirrors the desktop project's persisted metadata, without chat contents or credentials.
const desktop = {
  'local-projects': {
    a: { id: 'a', name: '同名项目', rootPaths: ['G:\\a'] },
    b: { id: 'b', name: '同名项目', rootPaths: ['G:\\b'] },
  },
  'project-order': ['b', 'a'],
  'thread-project-assignments': { 'chat-a': { projectKind: 'local', projectId: 'a' }, 'chat-b': { projectKind: 'local', projectId: 'b' } },
  'thread-project-membership-host-ids': { 'chat-a': 'local', 'chat-b': 'local' },
  'selected-project': { type: 'local', projectId: 'b' },
  unrelated: { private: '不应返回' },
};

test('真实 MCP 按调用聊天归属读取项目，未提供聊天时不借用全局选择，且项目列表实时刷新', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-codex-'));
  const stateFile = join(folder, '.codex-global-state.json');
  const client = new Client({ name: 'codex-binding-test', version: '1' });
  try {
    await writeFile(stateFile, JSON.stringify(desktop));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve('src/server.mjs'), '--data', join(folder, 'note.sqlite')],
      env: { ...process.env, CODEX_HOME: folder }, stderr: 'pipe' }));
    const list = await client.listTools();
    const tool = list.tools.find(item => item.name === 'project_control_codex_projects');
    assert.ok(tool, '应提供 Codex 项目及当前聊天归属入口');
    assert.equal(tool.annotations.readOnlyHint, false, '入口会清理总控台失效绑定，应准确声明写入副作用');
    const call = meta => client.callTool({ name: tool.name, arguments: {}, ...(meta ? { _meta: meta } : {}) });
    let result = await call({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'chat-a' }) });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.projects.map(p => p.projectId), ['b', 'a']);
    assert.equal(result.structuredContent.currentProject.projectId, 'a');
    assert.ok(!JSON.stringify(result).includes('不应返回'));
    // Desktop calls currently carry both threadId and an object-valued turn metadata field.
    result = await call({ threadId: 'chat-a', 'x-codex-turn-metadata': { thread_id: 'chat-a' } });
    assert.equal(result.structuredContent.currentProject.projectId, 'a');
    result = await call({ 'x-codex-turn-metadata': { thread_id: 'chat-a' } });
    assert.equal(result.structuredContent.currentProject.projectId, 'a');
    result = await call({ 'openai/threadId': 'chat-b' });
    assert.equal(result.structuredContent.currentProject.projectId, 'b');
    assert.equal((await call()).structuredContent.currentProject, null);
    assert.equal((await call({ 'openai/threadId': 'missing' })).structuredContent.currentProject, null);
    const open = meta => client.callTool({ name: tool.name, arguments: { onOpen: true }, ...(meta ? { _meta: meta } : {}) });
    // A new, unsent chat uses an ephemeral MCP host thread, with no project assignment.
    // The previous console selection is a; the currently selected Codex project is b.
    const workspaces = [
      { id: 'console-a', codexProject: { projectId: 'a', hostId: 'local' } },
      { id: 'console-b', codexProject: { projectId: 'b', hostId: 'local' } },
    ];
    result = await open({ threadId: 'ephemeral-host' });
    assert.equal(result.isError, undefined, '打开页面应支持新聊天的项目定位');
    assert.equal(defaultWorkspaceId(workspaces, result.structuredContent.currentProject, 'console-a'), 'console-b');
    assert.equal(result.structuredContent.currentProjectSource, 'selection');
    assert.equal((await open({ threadId: 'chat-a' })).structuredContent.currentProject.projectId, 'a', '已有聊天归属优先于全局选择');
    assert.equal((await open()).structuredContent.currentProject, null, '独立浏览器没有宿主聊天，不借用桌面选择');
    for (const selection of [null, { type: 'remote', projectId: 'b' }, { type: 'local', projectId: 'deleted' }]) {
      await writeFile(stateFile, JSON.stringify({ ...desktop, 'selected-project': selection }));
      assert.equal((await open({ threadId: 'ephemeral-host' })).structuredContent.currentProject, null);
    }
    await writeFile(stateFile, JSON.stringify({ ...desktop, 'projectless-thread-ids': ['no-project'],
      'thread-project-assignments': { ...desktop['thread-project-assignments'],
        'deleted-project': { projectKind: 'local', projectId: 'deleted' },
        'remote-chat': { projectKind: 'remote', projectId: 'b' } } }));
    for (const threadId of ['no-project', 'deleted-project', 'remote-chat']) {
      assert.equal((await open({ threadId })).structuredContent.currentProject, null, '明确的无项目、已删除或远程归属不能被全局选择覆盖');
    }
    await writeFile(stateFile, JSON.stringify({ ...desktop, 'local-projects': { ...desktop['local-projects'], a: { ...desktop['local-projects'].a, name: '改名后' } } }));
    assert.equal((await call({ 'openai/threadId': 'chat-a' })).structuredContent.currentProject.name, '改名后');
    await writeFile(stateFile, '{broken');
    result = await call();
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /Codex 项目/);
  } finally {
    await client.close();
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-codex-'));
    await rm(folder, { recursive: true, force: true });
  }
});
