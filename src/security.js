import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BridgeError } from './util.js';

export function secureDirectory(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  catch { throw new BridgeError('data-directory-access', '无法访问运行目录，请检查目录所有者及权限'); }
  if (process.platform !== 'win32') { fs.chmodSync(dir, 0o700); return; }
  // Numeric SIDs avoid local/domain name ambiguity. Preserve the directory owner and,
  // for project-local state, the project owner (an unelevated admin's group SID is deny-only).
  const code = `
$ErrorActionPreference='Stop'
try {
  $p=ConvertFrom-Json ([Console]::In.ReadToEnd())
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed=New-Object 'System.Collections.Generic.HashSet[string]'
  foreach($sid in @($current,'S-1-5-18','S-1-5-32-544')){[void]$allowed.Add($sid)}
  $acl=[IO.Directory]::GetAccessControl($p.dir)
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($owner -match '^S-1-5-21-(\\d+-){3}\\d+$'){[void]$allowed.Add($owner)}
  $root=[IO.Path]::GetFullPath($p.root).TrimEnd([char]'\\',[char]'/')
  $full=[IO.Path]::GetFullPath($p.dir)
  if($full.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
    $projectOwner=([IO.Directory]::GetAccessControl($root)).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($projectOwner -match '^S-1-5-21-(\\d+-){3}\\d+$'){[void]$allowed.Add($projectOwner)}
  }
  function Test-PrivateAcl($candidate) {
    if(-not $candidate.AreAccessRulesProtected){return $false}
    $covered=New-Object 'System.Collections.Generic.HashSet[string]'
    foreach($rule in $candidate.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
      if($rule.AccessControlType -ne 'Allow' -or -not $allowed.Contains($rule.IdentityReference.Value)){return $false}
      if(($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and
         ($rule.InheritanceFlags -band 3) -eq 3 -and $rule.PropagationFlags -eq 'None'){[void]$covered.Add($rule.IdentityReference.Value)}
    }
    foreach($sid in $allowed){if(-not $covered.Contains($sid)){return $false}}
    return $true
  }
  if(-not (Test-PrivateAcl $acl)){
    $acl.SetAccessRuleProtection($true,$false)
    foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($rule)}
    foreach($sid in $allowed){
      $identity=New-Object Security.Principal.SecurityIdentifier($sid)
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      [void]$acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($p.dir,$acl)
    if(-not (Test-PrivateAcl ([IO.Directory]::GetAccessControl($p.dir)))){[Console]::Write('acl-verify');exit 1}
  }
  [Console]::Write('ok')
} catch [UnauthorizedAccessException] {[Console]::Write('acl-access-denied');exit 1}
catch [Security.SecurityException] {[Console]::Write('acl-access-denied');exit 1}
catch {[Console]::Write('acl-tool-failed');exit 1}
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    input: JSON.stringify({ dir: path.resolve(dir), root: fileURLToPath(new URL('..', import.meta.url)) }), windowsHide: true, encoding: 'utf8', timeout: 15_000,
  });
  if (r.status !== 0 || r.stdout.trim() !== 'ok') {
    const detail = ['acl-access-denied', 'acl-verify', 'acl-tool-failed'].includes(r.stdout?.trim()) ? r.stdout.trim() : 'acl-tool-failed';
    throw new BridgeError('data-' + detail, '无法验证运行目录的私有 ACL，请由原目录所有者修复权限');
  }
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
