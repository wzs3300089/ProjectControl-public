import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { openStore, saveSchema } from './store.mjs';
import { openProjectStore } from './project-store.mjs';
import { executeProjectTool } from './project-tools.mjs';

const assets = new Map([
  ['/', ['../dist/console-web.html', 'text/html; charset=utf-8']],
  ['/console-web.mjs', ['../dist/console-web.mjs', 'text/javascript; charset=utf-8']],
  ['/console-host.css', ['console/host.css', 'text/css; charset=utf-8']],
  ['/web.css', ['web.css', 'text/css; charset=utf-8']],
  ['/web.mjs', ['web.mjs', 'text/javascript; charset=utf-8']],
  ['/note-form.mjs', ['note-form.mjs', 'text/javascript; charset=utf-8']],
]);

export async function startWebServer({ filename, projectFilename = join(dirname(filename), 'projects.sqlite'), port = 43937 }) {
  const store = openStore(filename);
  const projects = openProjectStore(projectFilename);
  let origin;
  const json = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)) {
        json(response, 403, { error: '仅允许从本机总控台页面访问。' }); return;
      }
      const pathname = new URL(request.url, origin).pathname;
      if (request.method === 'GET' && pathname === '/api/project-console/state') {
        json(response, 200, projects.read()); return;
      }
      if (request.method === 'POST' && pathname === '/api/project-console/tool') {
        if (request.headers.origin !== origin || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          json(response, 403, { error: '请从总控台页面操作。' }); return;
        }
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 4 * 1024 * 1024 + 4096) { json(response, 413, { error: '项目数据过大。' }); return; }
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { json(response, 400, { error: '请求不是合法 JSON。' }); return; }
        try { json(response, 200, await executeProjectTool(projects, input?.name, input?.arguments)); }
        catch (error) {
          if (Number.isInteger(error?.status)) json(response, error.status, { error: error.message, status: error.status });
          else throw error;
        }
        return;
      }
      if (request.method === 'GET' && pathname === '/api/note') {
        json(response, 200, store.read()); return;
      }
      if (request.method === 'POST' && pathname === '/api/note') {
        if (request.headers.origin !== origin ||
          request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          json(response, 403, { error: '请从总控台页面保存。' }); return;
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 650000) { json(response, 413, { error: '输入内容过长。' }); return; }
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { json(response, 400, { error: '保存数据格式无效。' }); return; }
        const parsed = saveSchema.safeParse(input);
        if (!parsed.success) { json(response, 400, { error: '请检查文字长度、状态和版本。' }); return; }
        // Every writer uses the same optimistic revision check in store.mjs.
        if (parsed.data.revision !== store.read().revision) {
          json(response, 409, { error: '内容已在其他窗口或 AI 中更新。请先重新读取，再保存。' }); return;
        }
        try { json(response, 200, store.save(parsed.data)); }
        catch (error) {
          if (parsed.data.revision !== store.read().revision) {
            json(response, 409, { error: '内容已更新，请重新读取后再保存。' });
          } else throw error;
        }
        return;
      }
      const asset = request.method === 'GET' && assets.get(pathname);
      if (asset) {
        const body = await readFile(new URL(asset[0], import.meta.url));
        response.writeHead(200, { 'Content-Type': asset[1] }); response.end(body); return;
      }
      json(response, 404, { error: '页面不存在。' });
    } catch (error) {
      console.error('ProjectControl web request failed:', error.message);
      if (!response.headersSent) json(response, 500, { error: '读取或保存失败，请重试。' });
      else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', done);
    });
  } catch (error) { store.close(); projects.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: async () => {
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    store.close();
    projects.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (key, fallback) => {
    const index = process.argv.indexOf(key);
    if (index === -1) return fallback;
    if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`${key} 缺少参数`);
    return process.argv[index + 1];
  };
  const filename = option('--data', fileURLToPath(new URL('../data/note.sqlite', import.meta.url)));
  const port = Number(option('--port', '43937'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('无效端口');
  const projectFilename = option('--projects', join(dirname(filename), 'projects.sqlite'));
  const web = await startWebServer({ filename, projectFilename, port });
  console.log(JSON.stringify({ app: 'project-control', url: web.origin, pid: process.pid }));
  let stopping = false;
  const stop = async () => { if (!stopping) { stopping = true; await web.close(); } };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
