import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { LauncherIO, qrSvg } from '../src/launcher-io.js';
import { randomUUID } from 'node:crypto';

test('QR SVG has square integer modules, four-module quiet zone and no URL text', () => {
  const svg = qrSvg('https://example.org/login?qr=fixture');
  const size = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)[1]);
  assert.ok(size >= 29);
  assert.match(svg, new RegExp(`width="${size * 8}" height="${size * 8}"`));
  for (const match of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    assert.ok(Number(match[1]) >= 4 && Number(match[1]) < size - 4);
    assert.ok(Number(match[2]) >= 4 && Number(match[2]) < size - 4);
  }
  assert.ok(!svg.includes('example.org'));
  assert.ok(!svg.includes('<script'));
});

test('launcher verification binds request ID, accepts digits only and consumes once', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let emitted = '';
  output.on('data', chunk => { emitted += chunk; });
  const ui = new LauncherIO({ input, output });
  const promise = ui.verify(new AbortController().signal);
  const request = JSON.parse(emitted.trim());
  input.write(JSON.stringify({ command: 'verify', id: 'wrong', code: '1234' }) + '\n');
  assert.ok(ui.pending);
  input.write(JSON.stringify({ command: 'verify', id: request.id, code: 'bad' }) + '\n');
  assert.ok(ui.pending);
  input.write(JSON.stringify({ command: 'verify', id: request.id, code: '01234' }) + '\n');
  assert.equal(await promise, '01234'); assert.equal(ui.pending, null);
  assert.ok(!emitted.includes('01234')); ui.close();
});

test('launcher stops on stdin EOF and aborts pending verification', async () => {
  const input = new PassThrough(); const output = new PassThrough(); const ac = new AbortController();
  let stopped = false;
  const ui = new LauncherIO({ input, output, shutdown: () => { stopped = true; ac.abort(); } });
  const pending = ui.verify(ac.signal);
  input.end();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(stopped, true);
});

test('session IPC exposes only the requested result and returns bounded error codes', async () => {
  const input = new PassThrough(), output = new PassThrough(); let emitted = '';
  output.on('data', chunk => { emitted += chunk; });
  const ui = new LauncherIO({ input, output });
  ui.sessions = (action, args) => { assert.equal(action, 'history'); return { entries: [{ role: 'assistant', text: args.session }] }; };
  const id = randomUUID(); input.write(JSON.stringify({ command: 'sessions', action: 'history', args: { session: 'fixture' }, id }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const result = JSON.parse(emitted.trim()); assert.equal(result.id, id); assert.equal(result.result.entries[0].text, 'fixture');
  emitted = ''; ui.sessions = () => { throw Object.assign(Error('sensitive error body'), { code: 'session-busy' }); };
  input.write(JSON.stringify({ command: 'sessions', action: 'create', id }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(emitted.trim()).error, 'session-busy'); assert.ok(!emitted.includes('sensitive')); ui.close();
});
