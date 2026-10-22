import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BridgeError } from '../util.js';
const base = new URL('../../cognitive/bootstrap/v0.1.0/', import.meta.url);
export function initialPortrait() {
  const bytes = fs.readFileSync(new URL('SELF_MODEL.md', base));
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', base), 'utf8'));
  if (manifest.version !== '0.1.0' || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new BridgeError('historical-self-integrity');
  return { text: bytes.toString('utf8'), evidenceRefs: [], confidence: 'initial-direction', origin: 'OTREE-bootstrap-v0.1.0' };
}
export function preserveInitial(dir) {
  initialPortrait(); // Verify the source archive before any copy.
  const dest = path.join(dir, 'historical', 'v0.1.0');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const name of ['SELF_MODEL.md', 'manifest.json']) {
    const bytes = fs.readFileSync(new URL(name, base)), target = path.join(dest, name);
    try { fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (!fs.readFileSync(target).equals(bytes)) throw new BridgeError('historical-self-integrity');
  }
}
