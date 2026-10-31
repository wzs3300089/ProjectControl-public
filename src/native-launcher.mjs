import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function launchNative(filename) {
  if (process.platform !== 'win32') throw new Error('独立浮窗目前仅支持 Windows');
  const executable = fileURLToPath(new URL('../dist/ProjectNote.exe', import.meta.url));
  await access(executable);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--node', process.execPath, '--data', filename, '--show'],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
