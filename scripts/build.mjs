import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const options = { bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'inline' };
const result = await build({ ...options, entryPoints: ['src/editor.mjs'], write: false });
const template = await readFile('src/console/index.html', 'utf8');
const styles = await readFile('src/console/host.css', 'utf8');
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
await mkdir('dist', { recursive: true });
await writeFile('dist/editor.html', template
  .replace('<link rel="stylesheet" href="/console-host.css">', () => `<style>${styles}</style>`)
  .replace('<script type="module" src="/console-web.mjs"></script>', () => `<script type="module">${script}</script>`));
await writeFile('dist/console-web.html', template);
await build({ ...options, entryPoints: ['src/console/web-entry.js'], outfile: 'dist/console-web.mjs' });
console.log('Built Codex project console and browser preview');
