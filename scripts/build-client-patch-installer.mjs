import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const framework = join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const args = ['/nologo', '/target:winexe', '/optimize+', '/utf8output',
  `/out:${join(root, 'patches/prepared/ClientPatchInstaller.exe')}`,
  `/win32manifest:${join(root, 'src/native/app.manifest')}`,
  ...['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'].map(name => `/reference:${join(framework, name)}`),
  join(root, 'patches/ClientPatchInstaller.cs')];
await new Promise((resolve, reject) => {
  const child = spawn(join(framework, 'csc.exe'), args, { windowsHide: true, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Installer build failed: ${code}`)));
});
console.log('Built patches/prepared/ClientPatchInstaller.exe');
