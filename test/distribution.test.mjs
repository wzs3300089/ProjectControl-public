import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('分发插件在带空格和中文的路径运行，版本切换后读取独立数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-control-package-'));
  const source = resolve(process.env.PROJECT_CONTROL_PACKAGE_ROOT || 'release/project-control-codex', 'marketplace/plugins/project-control');
  const first = join(root, '插件 一'), second = join(root, '插件 二'), data = join(root, '独立数据'), codexHome = join(root, 'codex');
  let client;
  const connect = async directory => {
    const result = new Client({ name: 'distribution-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [join(directory, 'runtime/launcher.mjs')], cwd: directory,
      env: { ...process.env, CODEX_HOME: codexHome, CODEX_APP_TOOLS_PIPE_PATH: '', PROJECT_CONTROL_DATA_DIR: data }, stderr: 'pipe' });
    await result.connect(transport);
    return result;
  };
  try {
    await cp(source, first, { recursive: true });
    await cp(source, second, { recursive: true });
    await mkdir(codexHome);
    await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'test-model',
      visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] }] }));
    const mcp = JSON.parse(await readFile(join(first, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers.project_control.command, 'node');
    assert.equal(mcp.mcpServers.project_control.args[0], 'runtime/launcher.mjs');
    assert.equal(mcp.mcpServers.project_control.cwd, '.');
    assert.deepEqual(mcp.mcpServers.project_control.env_vars, ['CODEX_APP_TOOLS_PIPE_PATH']);
    client = await connect(first);
    const entry = (await client.listTools()).tools.find(item => item.name === 'project_control_open');
    assert.ok(entry);
    const toolNames = (await client.listTools()).tools.map(item => item.name);
    for (const name of ['project_control_codex_projects', 'project_control_codex_threads', 'project_control_codex_ai_read', 'project_control_codex_ai_send']) assert.ok(toolNames.includes(name));
    const ai = await client.callTool({ name: 'project_control_codex_ai_read', arguments: {} });
    assert.equal(ai.structuredContent.models[0].id, 'test-model');
    assert.equal(ai.structuredContent.canSend, false);
    const html = await client.readResource({ uri: entry._meta.ui.resourceUri });
    assert.match(html.contents[0].text, /id="root"/);
    const initial = (await client.callTool({ name: 'project_control_projects_read', arguments: {} })).structuredContent;
    assert.deepEqual(initial.state.workspaces, []);
    const state = { ...initial.state, workspaces: [{ id: 'test', name: '测试项目', modules: ['测试模块'] }],
      projects: [{ id: 'req', name: '测试需求', workspaceId: 'test', module: '测试模块' }] };
    const saved = (await client.callTool({ name: 'project_control_projects_write', arguments: { revision: initial.revision, state } })).structuredContent;
    assert.equal(saved.state.projects[0].name, '测试需求');
    await client.close(); client = undefined;
    client = await connect(second);
    const reopened = (await client.callTool({ name: 'project_control_projects_read', arguments: {} })).structuredContent;
    assert.equal(reopened.state.workspaces[0].name, '测试项目');
    assert.equal(reopened.state.projects[0].name, '测试需求');
    assert.equal(reopened.revision, saved.revision);
    assert.ok((await readdir(data)).includes('projects.sqlite'));
  } finally {
    await client?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('project-control-package-'));
    await rm(root, { recursive: true, force: true });
  }
});
