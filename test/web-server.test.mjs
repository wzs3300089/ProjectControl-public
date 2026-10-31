import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { request } from 'node:http';
import { startWebServer } from '../src/web-server.mjs';
import { openStore } from '../src/store.mjs';

test('右侧网页真实 HTTP 保存/重启回读，与 AI 共用存储并拒绝冲突及跨站写入', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-web-'));
  const filename = join(folder, 'note.sqlite');
  let web, external;
  try {
    web = await startWebServer({ filename, port: 0 });
    const read = async () => (await fetch(web.origin + '/api/note')).json();
    const post = input => fetch(web.origin + '/api/note', { method: 'POST',
      headers: { Origin: web.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const first = await read();
    const text = '右侧测试 📝\n<script>只保存文字</script>';
    const response = await post({ text, status: 'completed', revision: first.revision });
    assert.equal(response.status, 200);
    const saved = await response.json();
    external = openStore(filename);
    assert.deepEqual(external.read(), saved);
    const ai = external.save({ text: 'AI 更新', status: 'pending', revision: saved.revision });
    assert.equal((await post({ ...saved, text: '旧标签覆盖' })).status, 409);
    assert.deepEqual(await read(), ai);
    assert.equal((await post({ ...ai, status: 'bad' })).status, 400);
    assert.equal((await fetch(web.origin + '/api/note', { method: 'POST', headers: {
      Origin: 'https://unrelated.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(ai) })).status, 403);
    const wrongHost = await new Promise((done, reject) => {
      const req = request(web.origin + '/api/note', { headers: { Host: 'unrelated.invalid' } }, res => {
        res.resume(); res.on('end', () => done(res.statusCode));
      }); req.on('error', reject); req.end();
    });
    assert.equal(wrongHost, 403);
    const page = await fetch(web.origin);
    assert.match(await page.text(), /项目总控台/);
    assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    const module = await fetch(web.origin + '/note-form.mjs');
    assert.equal(module.status, 200);
    assert.match(module.headers.get('Content-Type'), /javascript/);
    const projectRequest = (name, args = {}) => fetch(web.origin + '/api/project-console/tool', {
      method: 'POST', headers: { Origin: web.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    });
    const projects = await (await projectRequest('project_control_projects_read')).json();
    assert.deepEqual(projects.state.projects, []);
    const projectSaved = await projectRequest('project_control_projects_write', {
      revision: projects.revision,
      state: { ...projects.state, workspaces: [{ id: 'original-project', name: '原有项目', modules: ['公司项目'] }], projects: [{ id: 'http-project', workspaceId: 'original-project', module: '公司项目', name: '真实 HTTP 项目', todos: [{ id: 'todo', title: '验证', done: false }] }] },
    });
    assert.equal(projectSaved.status, 200);
    assert.equal((await (await projectRequest('project_control_projects_read')).json()).state.projects[0].name, '真实 HTTP 项目');
    assert.equal((await projectRequest('project_control_projects_write', projects)).status, 409);
    assert.equal((await projectRequest('project_control_open')).status, 404);
    const crossOrigin = await fetch(web.origin + '/api/project-console/tool', { method: 'POST',
      headers: { Origin: 'https://unrelated.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'project_control_projects_read', arguments: {} }),
    });
    assert.equal(crossOrigin.status, 403);
    await web.close(); web = await startWebServer({ filename, port: 0 });
    assert.deepEqual(await read(), ai);
  } finally {
    await web?.close(); external?.close();
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-web-'));
    await rm(folder, { recursive: true, force: true });
  }
});
