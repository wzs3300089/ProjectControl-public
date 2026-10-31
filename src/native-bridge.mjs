import { openStore } from './store.mjs';

// A private stdio bridge for the desktop window. User text never enters a shell command.
let store;
try {
  const index = process.argv.indexOf('--data');
  if (index < 0 || !process.argv[index + 1]) throw new Error('缺少数据库路径');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) throw new Error('输入内容过长');
  }
  const request = JSON.parse(input);
  store = openStore(process.argv[index + 1]);
  let value;
  if (request.action === 'read') value = store.read();
  else if (request.action === 'save') value = store.save(request.value);
  else throw new Error('未知的便签操作');
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
} finally {
  store?.close();
}
