import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { BridgeError } from './util.js';

export function secureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { fs.chmodSync(dir, 0o700); return; }
  const r = spawnSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new BridgeError('data-acl', '无法限制 data 目录 ACL，拒绝保存凭证');
}
function dpapi(value, decrypt) {
  const op = decrypt ? 'Unprotect' : 'Protect';
  const code = `Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::${op}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { input: Buffer.from(value).toString('base64'), windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) throw new BridgeError('credential-protection', 'Windows DPAPI 失败（需同一 Windows 用户）');
  return Buffer.from(r.stdout.trim(), 'base64');
}
export function saveCredentials(dir, credentials, filename = 'weixin-credentials.json') {
  secureDirectory(dir);
  const plain = Buffer.from(JSON.stringify(credentials));
  const content = process.platform === 'win32' ? { format: 'dpapi', data: dpapi(plain, false).toString('base64') }
    : { format: 'private-file', data: credentials };
  const file = path.join(dir, filename);
  fs.writeFileSync(file + '.tmp', JSON.stringify(content), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export function loadCredentials(dir, filename = 'weixin-credentials.json') {
  const file = path.join(dir, filename);
  if (!fs.existsSync(file)) return null;
  const x = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (x.format === 'dpapi') {
    if (process.platform !== 'win32') throw new BridgeError('dpapi-windows-only');
    return JSON.parse(dpapi(Buffer.from(x.data, 'base64'), true).toString('utf8'));
  }
  if (process.platform === 'win32' || x.format !== 'private-file' || (fs.statSync(file).mode & 0o077)) throw new BridgeError('credential-permissions');
  return x.data;
}
