import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { openStore } from '../src/store.mjs';

async function bridge(filename, request) {
  return new Promise((resolveCall, reject) => {
    const child = spawn(process.execPath, [resolve('src/native-bridge.mjs'), '--data', filename], { windowsHide: true });
    let output = '', errors = '';
    child.stdout.setEncoding('utf8').on('data', (text) => { output += text; });
    child.stderr.setEncoding('utf8').on('data', (text) => { errors += text; });
    child.once('error', reject);
    child.once('close', (code) => {
      try { resolveCall({ code, ...JSON.parse(output) }); }
      catch { reject(new Error(errors || output || `Bridge exited ${code}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

test('原生窗口 stdio 桥与 MCP 存储共享数据，并拒绝过期覆盖', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'project-control-native-'));
  const filename = join(folder, '带 空格.sqlite');
  let store;
  try {
    const first = await bridge(filename, { action: 'read' });
    assert.equal(first.ok, true);
    const text = '独立浮窗 📝\n中文 / "引号" / `文本` / $(普通文字)';
    const saved = await bridge(filename, { action: 'save', value: { text, status: 'completed', revision: first.value.revision } });
    assert.equal(saved.ok, true);
    store = openStore(filename);
    assert.equal(store.read().text, text);
    assert.equal(store.read().status, 'completed');
    const updated = store.save({ text: 'AI 更新的文字', status: 'pending', revision: saved.value.revision });
    const conflict = await bridge(filename, { action: 'save', value: { text: '旧窗口', status: 'completed', revision: saved.value.revision } });
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /另一个窗口/);
    const reopened = await bridge(filename, { action: 'read' });
    assert.deepEqual(reopened.value, updated);
  } finally {
    store?.close();
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('project-control-native-'));
    await rm(folder, { recursive: true, force: true });
  }
});
