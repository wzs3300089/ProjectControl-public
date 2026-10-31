import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') throw new Error('原生浮窗需在 Windows 上编译');
const root = fileURLToPath(new URL('../', import.meta.url));
const framework = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
await mkdir(join(root, 'dist'), { recursive: true });
const references = ['System.dll', 'System.Core.dll', 'System.Xaml.dll', 'System.Web.Extensions.dll',
  'WPF/WindowsBase.dll', 'WPF/PresentationCore.dll', 'WPF/PresentationFramework.dll'];
const args = ['/nologo', '/target:winexe', '/optimize+', '/utf8output',
  `/out:${join(root, 'dist/ProjectNote.exe')}`, `/win32manifest:${join(root, 'src/native/app.manifest')}`,
  ...references.map((name) => `/reference:${resolve(framework, name)}`), join(root, 'src/native/ProjectNote.cs')];
await new Promise((resolveBuild, reject) => {
  const child = spawn(join(framework, 'csc.exe'), args, { stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolveBuild() : reject(new Error(`Native build failed: ${code}`)));
});
console.log('Built dist/ProjectNote.exe');
