import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from '../src/util.js';
const target = path.resolve('Release', 'v' + VERSION);
if (fs.existsSync(target)) throw new Error('Release directory already exists; previous versions are never overwritten');
fs.mkdirSync(target, { recursive: true });
for (const name of ['src', 'scripts', 'tests', 'dsh', 'docs', 'web', 'launcher.py', 'start-web.bat', '.gitignore', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'config.example.json', 'start.bat', 'start-dsh.bat', 'login.bat']) {
  fs.cpSync(path.resolve(name), path.join(target, name), { recursive: true,
    filter: source => path.basename(source) !== '__pycache__' && !source.endsWith('.pyc') });
}
console.log('Release source package: ' + target + '\nRuntime dependencies and credentials are excluded. Follow README to install dependencies.');
