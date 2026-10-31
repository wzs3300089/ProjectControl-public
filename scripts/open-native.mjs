import { fileURLToPath } from 'node:url';
import { launchNative } from '../src/native-launcher.mjs';
await launchNative(fileURLToPath(new URL('../data/note.sqlite', import.meta.url)));
console.log('已请求打开独立便签窗口');
