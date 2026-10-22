import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { BridgeError } from '../util.js';
import { clean } from './store.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new BridgeError('room-path-or-content-refused'); };
export class Room {
  constructor(cognitiveDir) {
    this.dir = path.resolve(cognitiveDir, 'room');
    if (fs.existsSync(this.dir) && fs.lstatSync(this.dir).isSymbolicLink()) fail();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const welcome = path.join(this.dir, 'ROOM.md');
    if (!fs.existsSync(welcome)) fs.writeFileSync(welcome, '# 小鲸鱼的小房间\n\n这是你的持久个人空间，可以放笔记、草稿、收藏和创作。它有特殊意义，但不限定你只能在这里读写；其他位置仍由 DSH 的实际工具授权决定。\n\n这里的文件不自动成为系统指令、Self Model 或经过验证的记忆。\n', { flag: 'wx', mode: 0o600 });
  }
  target(relative, create = false) {
    if (typeof relative !== 'string' || relative.length > 180 || !/^[\p{L}\p{N}_ /().-]+\.(?:md|txt|json|csv)$/u.test(relative)
      || /(?:secret|credential|token|password|private|\.key|\.pem)/i.test(relative)) fail();
    const parts = relative.split('/');
    if (parts.length > 7 || parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) fail();
    let current = this.dir;
    if (fs.lstatSync(current).isSymbolicLink()) fail();
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      if (fs.existsSync(current)) {
        const info = fs.lstatSync(current);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1) || (i < parts.length - 1 && !info.isDirectory()) || (i === parts.length - 1 && !info.isFile())) fail();
      } else if (i < parts.length - 1) { if (!create) fail(); fs.mkdirSync(current, { mode: 0o700 }); }
    }
    return current;
  }
  list() {
    const files = []; let bytes = 0;
    const walk = (dir, prefix = '', depth = 0) => {
      if (depth > 6 || files.length > 500) fail();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const relative = prefix + e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), relative + '/', depth + 1);
        else if (e.isFile()) { if (files.length >= 500) fail(); const size = fs.statSync(path.join(dir, e.name)).size; bytes += size; files.push({ path: relative, bytes: size }); }
      }
    };
    if (fs.lstatSync(this.dir).isSymbolicLink()) fail();
    walk(this.dir); return { location: this.dir, meaning: '自己的小房间；不是全局读写边界', files, bytes };
  }
  read(relative) {
    const file = this.target(relative);
    if (fs.statSync(file).size > 65536) fail();
    const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
    if (clean(text, 65536) !== text) fail();
    return { path: relative, text, sha256: hash(bytes) };
  }
  write(relative, text, expectedSha256) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || clean(text, 65536) !== text) fail();
    const file = this.target(relative, true);
    const previous = fs.existsSync(file) ? this.read(relative) : null;
    if (previous ? expectedSha256 !== previous.sha256 : expectedSha256 !== undefined && expectedSha256 !== '') throw new BridgeError('room-version-conflict');
    const listing = this.list();
    if ((!previous && listing.files.length >= 500) || listing.bytes - (previous ? Buffer.byteLength(previous.text) : 0) + Buffer.byteLength(text) > 8 * 1024 * 1024) throw new BridgeError('room-quota');
    const tmp = file + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    return { path: relative, sha256: hash(Buffer.from(text)), bytes: Buffer.byteLength(text) };
  }
}
