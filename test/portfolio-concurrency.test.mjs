import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ApiError } from '../src/console/client/api.js';

const panel = await readFile(new URL('../src/console/client/panel.js', import.meta.url), 'utf8');
const source = panel.match(/function usePortfolio\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(source, 'usePortfolio implementation must be available to the regression harness');

// Execute the production hook. Only React storage/effects and the asynchronous
// transport boundary are isolated; queueing, rollback and revision handling stay real.
function portfolioHarness(readState, writeState, readCodexProjects = async () => ({})) {
  const slots = [];
  let cursor = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  const useRef = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  };
  const render = new Function('useState', 'useRef', 'useCallback', 'useEffect', 'readState', 'writeState', 'ApiError', 'readCodexProjects',
    `${source}\nreturn usePortfolio();`);
  return () => {
    cursor = 0;
    return render(useState, useRef, callback => callback, () => {}, readState, writeState, ApiError, readCodexProjects);
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const binding = { threadId: '11111111-1111-4111-8111-111111111111', hostId: 'local', title: '需求', projectId: null };
const snapshot = (revision, bound = false) => ({ revision, state: { version: 5, seededAt: '',
  workspaces: [{ id: 'w1', name: '项目', modules: ['模块'] }],
  projects: [{ id: 'r1', workspaceId: 'w1', name: '需求', module: '模块', progress: 0, ...(bound ? { codexThread: binding } : {}) }] } });
const progress = value => state => ({ ...state, projects: state.projects.map(item => ({ ...item, progress: value })) });

test('旧保存延迟失败后刷新仍保留新绑定，后续保存使用刷新后的 revision', async () => {
  let latest = snapshot(1);
  const pendingWrite = deferred(), writeStarted = deferred(), writes = [];
  const portfolio = portfolioHarness(async () => structuredClone(latest), (revision, state) => {
    writes.push({ revision, state: structuredClone(state) });
    if (writes.length === 1) { writeStarted.resolve(); return pendingWrite.promise; }
    return Promise.resolve({ revision: 3, state });
  });
  await portfolio().reload();
  const save = portfolio().update(progress(25));
  await writeStarted.promise;

  latest = snapshot(2, true);
  const refresh = portfolio().reload();
  await new Promise(resolve => setImmediate(resolve));
  pendingWrite.reject(new ApiError('项目已被自动绑定更新。', 409));
  assert.equal(await save, false);
  assert.equal(await refresh, undefined);
  assert.deepEqual(portfolio().state.projects[0].codexThread, binding);
  assert.equal(portfolio().revision, 2);
  assert.equal(portfolio().conflict, false);

  assert.equal(await portfolio().update(progress(50)), true);
  assert.equal(writes[1].revision, 2);
  assert.deepEqual(writes[1].state.projects[0].codexThread, binding);
  assert.equal(writes[1].state.projects[0].progress, 50);
});

test('刷新读取尚未结束时的保存等待新状态并使用新 revision', async () => {
  const pendingRead = deferred(), readStarted = deferred(), writes = [];
  let reads = 0;
  const portfolio = portfolioHarness(() => {
    if (++reads === 1) return Promise.resolve(snapshot(1));
    readStarted.resolve();
    return pendingRead.promise;
  }, async (revision, state) => {
    writes.push({ revision, state: structuredClone(state) });
    return { revision: 3, state };
  });
  await portfolio().reload();
  const refresh = portfolio().reload();
  await readStarted.promise;
  const save = portfolio().update(progress(75));
  await new Promise(resolve => setImmediate(resolve));
  pendingRead.resolve(snapshot(2, true));
  await refresh;
  assert.equal(await save, true);

  assert.equal(writes[0].revision, 2);
  assert.deepEqual(writes[0].state.projects[0].codexThread, binding);
  assert.equal(writes[0].state.projects[0].progress, 75);
  assert.equal(portfolio().revision, 3);
  assert.equal(portfolio().state.projects[0].progress, 75);
});

test('刷新失败保留原状态与返回行为，且不阻塞后续保存', async () => {
  let reads = 0;
  const writes = [];
  const portfolio = portfolioHarness(async () => {
    if (++reads === 1) return snapshot(4, true);
    throw new Error('读取失败');
  }, async (revision, state) => {
    writes.push({ revision, state: structuredClone(state) });
    return { revision: 5, state };
  });
  await portfolio().reload();
  assert.equal(await portfolio().reload(), undefined);
  assert.equal(portfolio().status, 'error');
  assert.equal(portfolio().error, '读取失败');
  assert.deepEqual(portfolio().state.projects[0].codexThread, binding);
  assert.equal(await portfolio().update(progress(10)), true);
  assert.equal(writes[0].revision, 4);
  assert.deepEqual(writes[0].state.projects[0].codexThread, binding);
});

test('保存采用服务端已清理绑定的权威状态，后续编辑不能恢复旧绑定', async () => {
  const writes = [];
  const portfolio = portfolioHarness(async () => snapshot(1, true), async (revision, state) => {
    writes.push(structuredClone(state));
    const saved = structuredClone(state);
    delete saved.projects[0].codexThread;
    return { revision: revision + 1, state: saved };
  });
  await portfolio().reload();
  assert.equal(await portfolio().update(progress(40)), true);
  assert.equal(portfolio().state.projects[0].codexThread, undefined);
  assert.equal(await portfolio().update(progress(60)), true);
  assert.equal(writes[1].projects[0].codexThread, undefined);
});

test('后台清理回读期间保持现有界面，防止编辑草稿被卸载重置', async () => {
  const pending = deferred(), started = deferred();
  let reads = 0;
  const portfolio = portfolioHarness(() => {
    if (++reads === 1) return Promise.resolve(snapshot(1, true));
    started.resolve(); return pending.promise;
  }, async () => { throw new Error('不应保存'); });
  await portfolio().reload();
  const refresh = portfolio().reload({ background: true });
  await started.promise;
  assert.equal(portfolio().status, 'ready');
  pending.resolve(snapshot(2)); await refresh;
  assert.equal(portfolio().state.projects[0].codexThread, undefined);
  assert.equal(portfolio().revision, 2);
});

test('刷新数据先检查失效项目再回读；元数据故障仍可读取原状态并显示原因', async () => {
  let latest = snapshot(1, true), unavailable = false, checks = 0;
  const portfolio = portfolioHarness(async () => structuredClone(latest), async () => {}, async () => {
    checks++;
    if (unavailable) throw new Error('读取 Codex 项目列表失败');
    latest = snapshot(2); return { clearedWorkspaces: [{ workspaceId: 'w1' }] };
  });
  await portfolio().reload({ checkBindings: true });
  assert.equal(checks, 1);
  assert.equal(portfolio().revision, 2);
  assert.equal(portfolio().state.projects[0].codexThread, undefined);
  unavailable = true; latest = snapshot(3, true);
  await portfolio().reload({ checkBindings: true });
  assert.equal(portfolio().status, 'ready');
  assert.equal(portfolio().state.projects[0].codexThread.threadId, binding.threadId);
  assert.match(portfolio().error, /Codex 项目/);
});
