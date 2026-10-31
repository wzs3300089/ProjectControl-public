import { open, mkdir, writeFile, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assetPath, sourceHash, patchAsset, popupGuard } from '../patches/sidebar-popup-patch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1023.6621.0_x64__2p2nqsd0c76g0/app/resources/app.asar';
const outputDir = join(root, 'patches/prepared');
const output = join(outputDir, 'app.sidebar-popup.asar');
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
function entry(tree, path) { return path.split('/').reduce((item, key) => item.files[key], tree); }
async function readHeader(path) {
  const file = await open(path, 'r');
  const prefix = Buffer.alloc(16);
  await file.read(prefix, 0, prefix.length, 0);
  const header = Buffer.alloc(prefix.readUInt32LE(12));
  await file.read(header, 0, header.length, 16);
  return { file, tree: JSON.parse(header), payloadOffset: 8 + prefix.readUInt32LE(4) };
}

await mkdir(outputDir, { recursive: true });
const original = await readHeader(source);
let patched;
let originalEntry;
try {
  const item = entry(original.tree, assetPath);
  originalEntry = structuredClone(item);
  const bytes = Buffer.alloc(item.size);
  await original.file.read(bytes, 0, bytes.length, original.payloadOffset + Number(item.offset));
  patched = patchAsset(bytes);
  const originalSize = (await stat(source)).size;
  item.offset = String(originalSize - original.payloadOffset);
  item.size = patched.length;
  const blockSize = item.integrity.blockSize;
  const blocks = [];
  for (let i = 0; i < patched.length; i += blockSize) blocks.push(hash(patched.subarray(i, i + blockSize)));
  item.integrity = { algorithm: 'SHA256', hash: hash(patched), blockSize, blocks };

  const json = Buffer.from(JSON.stringify(original.tree));
  const payloadSize = Math.ceil((json.length + 4) / 4) * 4;
  const header = Buffer.alloc(8 + 4 + payloadSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(4 + payloadSize, 4);
  header.writeUInt32LE(payloadSize, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  // Create only a candidate under this workspace. Never write the installed archive.
  await writeFile(output, header, { flag: 'wx' });
  await pipeline(createReadStream(source, { start: original.payloadOffset }), createWriteStream(output, { flags: 'a' }));
  await writeFile(output, patched, { flag: 'a' });
} finally { await original.file.close(); }

const candidate = await readHeader(output);
try {
  const item = entry(candidate.tree, assetPath);
  const bytes = Buffer.alloc(item.size);
  await candidate.file.read(bytes, 0, bytes.length, candidate.payloadOffset + Number(item.offset));
  if (!bytes.equals(patched) || hash(bytes) !== item.integrity.hash) throw new Error('候选归档回读校验失败');
} finally { await candidate.file.close(); }

const manifest = {
  status: 'PREPARED_NOT_APPLIED', source, output, assetPath, sourceAssetHash: sourceHash,
  sourceArchiveHash: await fileHash(source), candidateArchiveHash: await fileHash(output),
  patchedAssetHash: hash(patched), originalEntry, changedBehavior: 'Only the local project-control-test sidebar click calls its native-window tool without navigation.',
};
await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(outputDir, 'inserted-handler.txt'), popupGuard + '\n');
console.log(JSON.stringify({ status: manifest.status, output, assetPath, archiveVerified: true }));
