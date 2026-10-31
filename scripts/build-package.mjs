import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error('--output 需要指定交付目录');
const output = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : 'release/project-control-codex');
try { await access(output); throw new Error(`交付目录已存在：${output}，请先人工处理，打包不会覆盖。`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const plugin = join(output, 'marketplace/plugins/project-control');
await mkdir(join(plugin, 'runtime'), { recursive: true });
await cp('distribution/marketplace/.agents', join(output, 'marketplace/.agents'), { recursive: true });
await cp('distribution/plugin', plugin, { recursive: true });
await mkdir(join(plugin, 'dist'), { recursive: true });
await cp('dist/editor.html', join(plugin, 'dist/editor.html'));
// Preserve source separately so recipients can inspect and change the application.
await cp('src', join(output, 'source/src'), { recursive: true });
await mkdir(join(output, 'source/scripts'), { recursive: true });
await cp('scripts/build.mjs', join(output, 'source/scripts/build.mjs'));
await cp('scripts/build-package.mjs', join(output, 'source/scripts/build-package.mjs'));
await cp('distribution', join(output, 'source/distribution'), { recursive: true });
await cp('test', join(output, 'source/test'), { recursive: true });
await cp('licenses', join(output, 'source/licenses'), { recursive: true });
await cp('package.json', join(output, 'source/package.json'));
await cp('package-lock.json', join(output, 'source/package-lock.json'));
await cp('licenses', join(output, 'licenses'), { recursive: true });
await cp('distribution/INSTALL.md', join(output, '安装说明.md'));
const result = await build({
  entryPoints: ['src/server.mjs'], outfile: join(plugin, 'runtime/server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true,
  legalComments: 'inline', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
});
const browser = await build({ entryPoints: ['src/editor.mjs'], bundle: true, platform: 'browser',
  format: 'esm', target: 'chrome120', metafile: true, write: false,
  define: { 'process.env.NODE_ENV': '"production"' } });
// Include license files for all bundled third-party packages.
const packages = new Set();
for (const input of [...Object.keys(result.metafile.inputs), ...Object.keys(browser.metafile.inputs)]) {
  const match = input.replaceAll('\\', '/').match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packages.add(match[1]);
}
await mkdir(join(output, 'licenses/dependencies'), { recursive: true });
for (const name of packages) {
  const root = join('node_modules', name);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  let license;
  for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'license.txt', 'COPYING']) {
    try { license = await readFile(join(root, candidate), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license) throw new Error(`缺少依赖许可证：${name}`);
  await writeFile(join(output, 'licenses/dependencies', `${name.replaceAll('/', '__')}.txt`), `${name}@${metadata.version}\n\n${license}`);
}
console.log(`Package prepared: ${output} (${packages.size} dependency licenses)`);
