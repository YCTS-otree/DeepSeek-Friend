import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const levels = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

// Integer module coordinates and a four-module quiet zone; independent of terminal fonts.
export function qrSvg(content) {
  const qr = new QRCode(-1, levels.M); qr.addData(content); qr.make();
  const size = qr.getModuleCount() + 8; const cells = [];
  for (let y = 0; y < size - 8; y++) for (let x = 0; x < size - 8; x++) {
    if (qr.isDark(y, x)) cells.push(`M${x + 4} ${y + 4}h1v1h-1z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${size}v${size}H0z"/><path fill="#000" d="${cells.join('')}"/></svg>`;
}

export class LauncherIO {
  constructor({ input = process.stdin, output = process.stdout, shutdown, open } = {}) {
    this.output = output; this.pending = null;
    this.reader = createInterface({ input, crlfDelay: Infinity });
    this.reader.on('line', line => {
      if (line.length > 65536) return;
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.command === 'shutdown') shutdown?.();
      if (msg.command === 'open-dsh') Promise.resolve(open?.()).catch(() => this.emit('ui.open-failed'));
      if (msg.command === 'sessions' && typeof msg.id === 'string' && /^[a-f0-9-]{36}$/.test(msg.id)) {
        Promise.resolve().then(() => {
          if (!this.sessions) throw Object.assign(new Error(), { code: 'bridge-not-ready' });
          return this.sessions(msg.action, msg.args ?? {});
        }).then(result => this.emit('ui.sessions', { id: msg.id, result }), e => this.emit('ui.sessions', { id: msg.id, error: e.code ?? 'session-operation-failed' }));
      }
      if (msg.command === 'verify' && this.pending && msg.id === this.pending.id && /^\d{1,12}$/.test(msg.code ?? '')) this.pending.resolve(msg.code);
    });
    this.reader.on('close', () => shutdown?.());
  }
  emit(event, data = {}) { this.output.write(JSON.stringify({ event, ...data }) + '\n'); }
  qr(content) { this.emit('ui.qr', { svg: qrSvg(content) }); }
  verify(signal) {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => { signal?.removeEventListener('abort', abort); this.pending = null; fn(value); };
      const abort = () => finish(reject, signal.reason);
      this.pending = { id, resolve: code => finish(resolve, code) };
      signal?.addEventListener('abort', abort, { once: true });
      this.emit('ui.verify', { id });
    });
  }
  close() { this.reader.close(); }
}
