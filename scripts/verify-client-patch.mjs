import { readFile, open, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const manifestUrl = new URL('../patches/prepared/manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
async function header(path) {
  const file = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(16);
    await file.read(prefix, 0, 16, 0);
    const bytes = Buffer.alloc(prefix.readUInt32LE(12));
    await file.read(bytes, 0, bytes.length, 16);
    return { tree: JSON.parse(bytes), base: 8 + prefix.readUInt32LE(4) };
  } finally { await file.close(); }
}
const get = (tree, path) => path.split('/').reduce((item, key) => item.files[key], tree);
async function digest(path, options) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, options)) hash.update(chunk);
  return hash.digest('hex');
}

const source = await header(manifest.source), candidate = await header(manifest.output);
const originalSize = (await stat(manifest.source)).size;
const payloadSize = originalSize - source.base;
assert.equal(await digest(manifest.source), manifest.sourceArchiveHash);
assert.equal(await digest(manifest.output), manifest.candidateArchiveHash);
assert.equal(await digest(manifest.source, { start: source.base }),
  await digest(manifest.output, { start: candidate.base, end: candidate.base + payloadSize - 1 }),
  '原归档的所有其他内容必须逐字节保留');

const modified = get(candidate.tree, manifest.assetPath);
const asset = Buffer.alloc(modified.size);
const file = await open(manifest.output, 'r');
try { await file.read(asset, 0, asset.length, candidate.base + Number(modified.offset)); }
finally { await file.close(); }
const candidatePath = manifest.assetPath.split('/');
const leaf = candidatePath.pop();
get(candidate.tree, candidatePath.join('/')).files[leaf] = get(source.tree, manifest.assetPath);
assert.deepEqual(candidate.tree, source.tree, '只能修改一个入口脚本的归档元数据');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '--check'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  child.stdin.end(asset);
});
const report = { installedArchiveUnchanged: true, otherArchiveBytesUnchanged: true,
  onlyOneAssetChanged: true, patchedModuleSyntaxValid: true, applied: false };
await writeFile(new URL('../patches/prepared/verification.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
