import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function connect(filename) {
  const client = new Client({ name: 'project-control-test', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('src/server.mjs'), '--data', filename], stderr: 'pipe' });
  await client.connect(transport);
  return client;
}

test('真实 MCP 保存、重启回读、状态切换、版本冲突和输入校验', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-test-'));
  const filename = join(folder, 'note.sqlite');
  let client;
  try {
    client = await connect(filename);
    const { tools } = await client.listTools();
    const entry = tools.find((tool) => tool.name === 'project_control_open');
    assert.deepEqual(entry._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
    assert.equal(entry.title, '项目总控台');
    const resource = await client.readResource({ uri: entry._meta.ui.resourceUri });
    assert.match(resource.contents[0].text, /id="root"/);
    assert.doesNotMatch(resource.contents[0].text, /打开独立浮窗|src="\/web.mjs"/);
    const initial = await client.callTool({ name: 'project_control_read', arguments: {} });
    const opened = await client.callTool({ name: 'project_control_open', arguments: {} });
    assert.deepEqual(opened.structuredContent.state.projects, []);
    assert.equal(opened.structuredContent.revision, 0);
    assert.ok(tools.some(tool => tool.name === 'project_control_propose_plan'));
    assert.equal(initial.structuredContent.status, 'pending');
    const text = '测试文字：中文、emoji 📝\n<script>按原样保存</script>';
    const saved = await client.callTool({ name: 'project_control_save', arguments: {
      text, status: 'completed', revision: initial.structuredContent.revision,
    } });
    assert.equal(saved.isError, undefined);
    assert.equal(saved.structuredContent.text, text);
    assert.equal(saved.structuredContent.status, 'completed');
    await client.close();
    client = await connect(filename);
    const reopened = await client.callTool({ name: 'project_control_read', arguments: {} });
    assert.deepEqual(reopened.structuredContent, saved.structuredContent);
    const stale = await client.callTool({ name: 'project_control_save', arguments: {
      text: '旧窗口覆盖', status: 'pending', revision: 0,
    } });
    assert.equal(stale.isError, true);
    const invalid = await client.callTool({ name: 'project_control_save', arguments: {
      text: '非法状态', status: 'unknown', revision: saved.structuredContent.revision,
    } });
    assert.equal(invalid.isError, true);
    const pending = await client.callTool({ name: 'project_control_save', arguments: {
      text: '', status: 'pending', revision: saved.structuredContent.revision,
    } });
    assert.equal(pending.structuredContent.text, '');
    assert.equal(pending.structuredContent.status, 'pending');
    assert.equal(pending.structuredContent.revision, saved.structuredContent.revision + 1);
  } finally {
    await client?.close();
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-test-'));
    await rm(folder, { recursive: true, force: true });
  }
});
