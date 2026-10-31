import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalHandler, patchedHandler, patchAsset } from '../patches/sidebar-popup-patch.mjs';

const ownSource = { hostId: 'local', server: 'project_control', pluginId: 'project-control-test@project-control-local' };
function handler(source, { special = false, result = { structuredContent: { window: 'open_requested' } }, failure = false, original = false } = {}) {
  const navigation = [], calls = [], errors = [];
  const scope = { get: () => ({ danger: (message) => errors.push(message) }) };
  const call = (...args) => { calls.push(args); return failure ? Promise.reject(new Error('offline')) : Promise.resolve(result); };
  const navigate = (...args) => navigation.push(args);
  // Exercise the exact handler text extracted from the installed bundle with its services isolated.
  const invoke = new Function('d', 't', 'hh', 'Ar', 'p', 'Ox', 'c', `return (${original ? originalHandler : patchedHandler});`)
    (source, scope, call, Symbol('toast'), special, navigate, '/original/plugin/path');
  return { invoke, navigation, calls, errors };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('复现旧入口先导航；补丁只唤起自己的浮窗，不导航', async () => {
  const before = handler(ownSource, { original: true });
  before.invoke({ from: 'chat' });
  assert.equal(before.navigation.length, 1);
  const after = handler(ownSource);
  after.invoke({ from: 'chat' });
  await settle();
  assert.equal(after.navigation.length, 0);
  assert.deepEqual(after.calls[0].slice(1), ['local', 'project_control', 'project_control_open', {}]);
  assert.equal(after.errors.length, 0);
});

test('工具失败或旧服务未加载时显示错误，也不切走原对话', async () => {
  for (const options of [{ failure: true }, { result: { isError: true } }, { result: { structuredContent: { text: 'old' } } }]) {
    const current = handler(ownSource, options);
    current.invoke({}); await settle();
    assert.equal(current.errors.length, 1);
    assert.equal(current.navigation.length, 0);
  }
});

test('其他插件、远程服务和内置特殊入口保留原有导航', () => {
  for (const source of [undefined, { ...ownSource, hostId: 'remote' }, { ...ownSource, server: 'other' }, { ...ownSource, pluginId: 'other' }]) {
    for (const special of [false, true]) {
      const before = handler(source, { special, original: true });
      const after = handler(source, { special });
      before.invoke({ from: 'chat' }); after.invoke({ from: 'chat' });
      assert.equal(after.calls.length, 0);
      assert.deepEqual(after.navigation[0].slice(1), before.navigation[0].slice(1));
    }
  }
});

test('客户端版本不匹配时拒绝打补丁', () => {
  assert.throws(() => patchAsset(Buffer.from('different client')), /不匹配/);
});
