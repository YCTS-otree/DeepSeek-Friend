import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(?:mjs|js)$/.test(d.name) ? [path.join(dir, d.name)] : []); }
let failed = false;
for (const file of ['src', 'scripts', 'tests', 'dsh', 'web'].flatMap(walk)) {
  const p = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (p.status) failed = true;
}
if (failed) process.exitCode = 1; else console.log('Syntax checks passed.');
