import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../src/project-store.mjs';
import { createWorkspace, renameWorkspace } from '../src/console/shared/hierarchy.js';

const settings = { model: 'model-from-codex', reasoningEffort: 'high' };
async function withDatabase(run) {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-ai-settings-'));
  try { await run(join(folder, 'projects.sqlite')); }
  finally {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-ai-settings-'));
    await rm(folder, { recursive: true, force: true });
  }
}

test('项目 AI 绑定独立持久化，改名保留、修改和解除不影响其他项目', async () => {
  await withDatabase(filename => {
    let store = openProjectStore(filename);
    try {
      let state = createWorkspace(store.read().state, 'a', '甲', null, settings);
      state = createWorkspace(state, 'b', '乙', null, { ...settings, reasoningEffort: 'low' });
      state = store.write({ revision: 0, state }).state;
      assert.deepEqual(state.workspaces[0].aiSettings, settings);
      store.close(); store = openProjectStore(filename);
      state = renameWorkspace(store.read().state, 'a', '甲改名');
      assert.deepEqual(state.workspaces[0].aiSettings, settings);
      state = renameWorkspace(state, 'a', '甲改名', undefined, { ...settings, reasoningEffort: 'ultra' });
      state = store.write({ revision: 1, state }).state;
      assert.equal(state.workspaces[0].aiSettings.reasoningEffort, 'ultra');
      state = renameWorkspace(state, 'a', '甲改名', undefined, null);
      state = store.write({ revision: 2, state }).state;
      assert.equal(state.workspaces[0].aiSettings, undefined);
      assert.deepEqual(state.workspaces[1].aiSettings, { ...settings, reasoningEffort: 'low' });
    } finally { store.close(); }
  });
});

test('不完整或格式错误的 AI 配置拒绝保存，不静默清除已有配置', async () => {
  await withDatabase(filename => {
    const store = openProjectStore(filename);
    try {
      const state = createWorkspace(store.read().state, 'a', '甲', null, settings);
      store.write({ revision: 0, state });
      for (const invalid of [{ model: '' }, { model: 'm' }, { ...settings, reasoningEffort: 'imaginary' }, 'm']) {
        assert.throws(() => store.write({ revision: 1, state: { ...state,
          workspaces: [{ ...state.workspaces[0], aiSettings: invalid }] } }), /模型|思维/);
      }
      assert.deepEqual(store.read().state.workspaces[0].aiSettings, settings);
      assert.equal(store.read().revision, 1);
    } finally { store.close(); }
  });
});

test('版本 3 原子迁移保留 Codex 绑定，旧面板不能覆盖新版 AI 配置', async () => {
  await withDatabase(filename => {
    const previous = { version: 3, seededAt: '', workspaces: [{ id: 'a', name: '甲', modules: [],
      codexProject: { projectId: 'native', hostId: 'local', name: '甲', path: 'G:\\project' } }], projects: [] };
    const db = new DatabaseSync(filename);
    db.exec('CREATE TABLE project_document (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL)');
    db.prepare('INSERT INTO project_document VALUES (1, 7, ?)').run(JSON.stringify(previous)); db.close();
    let store = openProjectStore(filename);
    try {
      const migrated = store.read();
      assert.equal(migrated.revision, 8);
      assert.equal(migrated.state.version, 5);
      assert.deepEqual(migrated.state.workspaces, previous.workspaces);
      assert.throws(() => store.write({ revision: 8, state: previous }), error => error.status === 409);
      store.close(); store = openProjectStore(filename);
      assert.deepEqual(store.read(), migrated);
    } finally { store.close(); }
  });
});
