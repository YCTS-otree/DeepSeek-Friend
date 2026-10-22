import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { secureDirectory } from '../src/security.js';

test('Windows private state explicitly grants the project owner and passes repeated checks', { skip: process.platform !== 'win32' }, () => {
  const dir = path.resolve('.research/test-state', 'acl-' + randomUUID());
  secureDirectory(dir); secureDirectory(dir);
  const code = `$p=ConvertFrom-Json ([Console]::In.ReadToEnd());$a=[IO.Directory]::GetAccessControl($p.dir);$owner=([IO.Directory]::GetAccessControl($p.root)).GetOwner([Security.Principal.SecurityIdentifier]).Value;$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights;inherit=[int]$_.InheritanceFlags}});[Console]::Write((@{owner=$owner;protected=$a.AreAccessRulesProtected;rules=$rules}|ConvertTo-Json -Depth 4 -Compress))`;
  const r = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    input: JSON.stringify({ dir, root: process.cwd() }), windowsHide: true, encoding: 'utf8',
  });
  assert.equal(r.status, 0); const acl = JSON.parse(r.stdout);
  assert.equal(acl.protected, true);
  assert.ok(acl.rules.some(rule => rule.sid === acl.owner && rule.type === 'Allow' && rule.inherit === 3));
  for (const broad of ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545']) assert.ok(!acl.rules.some(rule => rule.sid === broad));
  const file = path.join(dir, 'write-probe'); fs.writeFileSync(file, 'ok'); fs.unlinkSync(file);
});
test('Windows ACL failures produce a stable actionable code without exposing tool stderr', { skip: process.platform !== 'win32' }, () => {
  const original = childProcess.spawnSync; const dir = path.resolve('.research/test-state', 'acl-fail-' + randomUUID());
  try {
    childProcess.spawnSync = () => ({ status: 1, stdout: 'acl-access-denied', stderr: 'DO-NOT-EXPOSE-RAW-DIAGNOSTICS' });
    syncBuiltinESMExports();
    assert.throws(() => secureDirectory(dir), error => error.code === 'data-acl-access-denied' && !error.message.includes('DO-NOT-EXPOSE'));
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});
