import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../src/project-store.mjs';
import { createWorkspace, renameWorkspace, deleteWorkspace, createModule, renameModule, deleteModule } from '../src/console/shared/hierarchy.js';
import * as hierarchy from '../src/console/shared/hierarchy.js';

const original = state => createModule(createWorkspace(state, 'original-project', '原有项目'), 'original-project', '公司项目');

async function withFolder(run) {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-hierarchy-'));
  try { await run(join(folder, 'projects.sqlite')); }
  finally {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-hierarchy-'));
    await rm(folder, { recursive: true, force: true });
  }
}

test('旧数据原子迁移一次并保留完整需求，旧面板不能覆盖新结构', async () => {
  await withFolder(filename => {
    const previous = { version: 1, seededAt: '2026-10-29T12:00:00.000Z', projects: [{
      id: 'legacy', name: '已有需求', module: '旧模块', status: '进行中', progress: 55,
      createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
      updates: [{ id: 'u1', at: '2026-10-29T00:00:00.000Z', kind: 'note', text: '记录' }],
      todos: [{ id: 't1', title: '事项', done: false }] }] };
    const db = new DatabaseSync(filename);
    db.exec('CREATE TABLE project_document (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL)');
    db.prepare('INSERT INTO project_document VALUES (1, ?, ?)').run(7, JSON.stringify(previous)); db.close();
    const store = openProjectStore(filename);
    try {
      const migrated = store.read();
      assert.equal(migrated.revision, 8);
      assert.equal(migrated.state.version, 5);
      assert.equal(migrated.state.workspaces[0].name, '原有项目');
      assert.ok(migrated.state.workspaces[0].modules.includes('旧模块'));
      const req = migrated.state.projects[0];
      assert.equal(req.id, 'legacy'); assert.equal(req.workspaceId, 'original-project');
      assert.equal(req.updates[0].text, '记录'); assert.equal(req.todos[0].title, '事项');
      assert.throws(() => store.write({ revision: 7, state: previous }), error => error.status === 409);
      assert.deepEqual(store.read(), migrated);
    } finally { store.close(); }
    const reopened = openProjectStore(filename);
    try { assert.equal(reopened.read().revision, 8); } finally { reopened.close(); }
  });
});

test('项目和模块增删改查、跨模块移动以及有需求时阻止删除', async () => {
  await withFolder(filename => {
    const store = openProjectStore(filename);
    try {
      let state = original(store.read().state);
      state = createWorkspace(state, 'ws2', '第二项目');
      state = createModule(state, 'ws2', '公司项目');
      state = createModule(state, 'ws2', '空模块');
      state = renameWorkspace(state, 'ws2', '第二项目改名');
      state.projects = [
        { id: 'a', name: '需求甲', workspaceId: 'original-project', module: '公司项目' },
        { id: 'b', name: '需求乙', workspaceId: 'ws2', module: '公司项目' },
      ];
      state = store.write({ revision: 0, state }).state;
      assert.throws(() => store.write({ revision: 1, state: {
        ...state, workspaces: state.workspaces.filter(item => item.id !== 'ws2'),
        projects: state.projects.filter(item => item.workspaceId !== 'ws2')
      } }), /还有需求/);
      assert.equal(store.read().revision, 1);
      state = renameModule(state, 'ws2', '公司项目', '新模块');
      assert.equal(state.projects.find(item => item.id === 'a').module, '公司项目');
      assert.equal(state.projects.find(item => item.id === 'b').module, '新模块');
      assert.throws(() => deleteModule(state, 'ws2', '新模块'), /还有需求/);
      assert.throws(() => deleteWorkspace(state, 'ws2'), /还有需求/);
      assert.throws(() => createModule(state, 'ws2', '新模块'), /同名/);
      state.projects = state.projects.map(item => item.id === 'b' ? { ...item, workspaceId: 'original-project', module: '公司项目' } : item);
      state = deleteModule(state, 'ws2', '新模块');
      state = deleteWorkspace(state, 'ws2');
      const result = store.write({ revision: 1, state });
      assert.equal(result.state.projects.length, 2);
      assert.equal(result.state.workspaces.length, 1);
      assert.throws(() => store.write({ revision: 2, state: { ...state, projects: [{ ...state.projects[0], module: '不存在' }] } }), /所属项目或模块不存在/);
      assert.equal(store.read().revision, 2);
    } finally { store.close(); }
    const reopened = openProjectStore(filename);
    try { assert.equal(reopened.read().state.projects.length, 2); } finally { reopened.close(); }
  });
});

test('多项目 AI 请求只匹配所属项目，不接受不存在的模块', async () => {
  await withFolder(filename => {
    const store = openProjectStore(filename);
    try {
      let state = createModule(createWorkspace(original(store.read().state), 'ws2', '第二项目'), 'ws2', '模块二');
      state.projects = [{ id: 'a', name: '同名需求', workspaceId: 'original-project', module: '公司项目' },
        { id: 'b', name: '同名需求', workspaceId: 'ws2', module: '模块二' }];
      store.write({ revision: 0, state });
      assert.throws(() => store.createRequest({ instruction: '修改同名需求' }), /指定当前项目/);
      const request = store.createRequest({ instruction: '修改同名需求', workspaceId: 'ws2' });
      const result = store.propose({ requestId: request.id, plan: { actions: [
        { op: 'update', target: '同名需求', changes: { progress: 80 } },
        { op: 'add', name: '新增需求', module: '其他项目' },
        { op: 'update', target: 'a', changes: { progress: 90 } }
      ] } });
      assert.equal(result.plan.actions.length, 1);
      assert.equal(result.plan.actions[0].projectId, 'b');
      assert.ok(result.plan.issues.some(item => item.includes('不属于当前项目')));
      assert.equal(store.read().revision, 1);
    } finally { store.close(); }
  });
});

test('新数据没有项目，可创建并删除最后一个空项目，重启后仍为空', async () => {
  await withFolder(filename => {
    const store = openProjectStore(filename);
    try {
      assert.deepEqual(store.read().state.workspaces, []);
      let state = createWorkspace(store.read().state, 'first', '第一个项目');
      state = store.write({ revision: 0, state }).state;
      assert.equal(state.workspaces[0].name, '第一个项目');
      state = deleteWorkspace(state, 'first');
      assert.deepEqual(store.write({ revision: 1, state }).state.workspaces, []);
    } finally { store.close(); }
    const reopened = openProjectStore(filename);
    try { assert.deepEqual(reopened.read().state.workspaces, []); } finally { reopened.close(); }
  });
});

test('项目绑定可创建、编辑、解除并重启回读，重名 Codex 项目按 ID 区分', async () => {
  await withFolder(filename => {
    const bound = { projectId: 'codex-a', hostId: 'local', name: '同名项目', path: 'G:\\a' };
    let store = openProjectStore(filename);
    try {
      let state = createWorkspace(store.read().state, 'a', '看板甲', bound);
      state = createWorkspace(state, 'b', '看板乙', { ...bound, projectId: 'codex-b', path: 'G:\\b' });
      state = store.write({ revision: 0, state }).state;
      assert.deepEqual(state.workspaces[0].codexProject, bound);
      assert.equal(state.workspaces[1].codexProject.projectId, 'codex-b');
      assert.throws(() => createWorkspace(state, 'c', '看板丙', bound), /已绑定/);
      assert.throws(() => store.write({ revision: 1, state: { ...state,
        workspaces: state.workspaces.map(item => ({ ...item, codexProject: bound })) } }), /已绑定/);
      assert.equal(store.read().revision, 1);
      state = renameWorkspace(state, 'a', '看板甲改名');
      assert.deepEqual(state.workspaces[0].codexProject, bound);
      store.close(); store = openProjectStore(filename);
      assert.deepEqual(store.read().state.workspaces[0].codexProject, bound);
      state = renameWorkspace(state, 'a', '看板甲改名', null);
      assert.equal(store.write({ revision: 1, state }).state.workspaces[0].codexProject, undefined);
    } finally { store.close(); }
  });
});

test('打开时绑定优先于上次选择，没有匹配则保留有效选择；同名、不同主机不串项目', () => {
  const workspaces = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙', codexProject: { projectId: 'native-b', hostId: 'local' } },
    { id: 'c', name: '丙', codexProject: { projectId: 'native-b', hostId: 'remote' } },
  ];
  assert.equal(typeof hierarchy.defaultWorkspaceId, 'function');
  assert.equal(hierarchy.defaultWorkspaceId(workspaces, { projectId: 'native-b', hostId: 'local' }, 'a'), 'b');
  assert.equal(hierarchy.defaultWorkspaceId(workspaces, { projectId: 'native-b', hostId: 'remote' }, 'a'), 'c');
  assert.equal(hierarchy.defaultWorkspaceId(workspaces, { projectId: 'missing', hostId: 'local' }, 'a'), 'a');
  assert.equal(hierarchy.defaultWorkspaceId(workspaces, null, 'c'), 'c');
  assert.equal(hierarchy.defaultWorkspaceId(workspaces, null, 'removed'), 'a');
  assert.equal(hierarchy.defaultWorkspaceId([], null, ''), '');
});

test('版本 2 项目迁移后保留需求，旧页面不能清除绑定', async () => {
  await withFolder(filename => {
    const previous = { version: 2, seededAt: '', workspaces: [{ id: 'a', name: '已有项目', modules: ['模块'] }],
      projects: [{ id: 'r', name: '已有需求', workspaceId: 'a', module: '模块' }] };
    const db = new DatabaseSync(filename);
    db.exec('CREATE TABLE project_document (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL)');
    db.prepare('INSERT INTO project_document VALUES (1, 7, ?)').run(JSON.stringify(previous)); db.close();
    const store = openProjectStore(filename);
    try {
      const next = store.read();
      assert.equal(next.revision, 8);
      assert.equal(next.state.version, 5);
      assert.equal(next.state.projects[0].name, '已有需求');
      assert.equal(next.state.workspaces[0].codexProject, undefined);
      assert.throws(() => store.write({ revision: 8, state: previous }), error => error.status === 409);
    } finally { store.close(); }
  });
});
