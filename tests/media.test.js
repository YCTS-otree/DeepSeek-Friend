import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createCipheriv } from 'node:crypto';
import { RuntimeStore } from '../src/runtime.js';
import { MediaClient, mediaKey } from '../src/media.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=', 'base64');
function fixture(t, fetchImpl, request) {
  const dir = path.resolve('.research/media-tests', randomUUID()), runtime = new RuntimeStore(dir); t.after(() => runtime.close());
  const config = { baseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c', allowedHosts: ['novac2c.cdn.weixin.qq.com'], maxBytes: 1024 * 1024, timeoutMs: 1000 };
  return { runtime, media: new MediaClient(config, runtime, { request }, fetchImpl), config };
}
test('official image references decrypt through hex/raw/base64-of-hex AES key encodings', async t => {
  const key = Buffer.alloc(16, 7), cipher = createCipheriv('aes-128-ecb', key, null), encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  const f = fixture(t, async (url, options) => { assert.equal(new URL(url).hostname, 'novac2c.cdn.weixin.qq.com'); assert.equal(options.redirect, 'error'); return new Response(encrypted); });
  for (const item of [{ aeskey: key.toString('hex'), media: { encrypt_query_param: 'fixture' } }, { media: { encrypt_query_param: 'fixture', aes_key: key.toString('base64') } }, { media: { encrypt_query_param: 'fixture', aes_key: Buffer.from(key.toString('hex')).toString('base64') } }]) {
    const image = await f.media.receive(item); assert.equal(image.mediaType, 'image/png'); assert.ok(Buffer.from(image.data, 'base64').equals(png));
  }
  assert.equal(f.runtime.db.prepare('SELECT count(*) n FROM images').get().n, 1);
  assert.throws(() => mediaKey({ aeskey: 'malformed' }), { code: 'image-key-invalid' });
});
test('media rejects arbitrary URLs, redirects, oversized bytes and unsupported payloads', async t => {
  const f = fixture(t, async () => new Response(Buffer.alloc(1024 * 1024 + 17)));
  for (const url of ['http://novac2c.cdn.weixin.qq.com/a', 'https://127.0.0.1/private', 'https://evil.example/x', 'https://novac2c.cdn.weixin.qq.com@evil.example/a']) await assert.rejects(f.media.receive({ media: { full_url: url } }), { code: 'cdn-host-rejected' });
  await assert.rejects(f.media.receive({ media: { full_url: f.config.baseUrl + '/large' } }), { code: 'image-too-large' });
  assert.throws(() => f.media.save(Buffer.from('<svg onload="bad"/>')), { code: 'image-format' });
});
test('official upload preserves encrypted size/key/client ID and caches receipt before send retries', async t => {
  let uploads = 0, apiCalls = 0;
  const f = fixture(t, async (_url, options) => { uploads++; assert.equal(options.body.length % 16, 0); assert.ok(!options.headers.Authorization); return new Response('', { headers: { 'x-encrypted-param': 'test-download-param' } }); }, async (endpoint, body) => {
    apiCalls++; assert.equal(endpoint, 'ilink/bot/getuploadurl'); assert.equal(body.media_type, 1); assert.equal(body.rawsize, png.length); assert.equal(body.filesize % 16, 0); return { upload_param: 'test-upload-param' };
  });
  const saved = f.media.save(png), first = await f.media.prepare('stable-outbox', saved.id, 'user', 'context', 'stable-client', 'run');
  const again = await f.media.prepare('stable-outbox', saved.id, 'user', 'context', 'stable-client', 'run');
  assert.deepEqual(again, first); assert.equal(uploads, 1); assert.equal(apiCalls, 1);
  assert.equal(first.msg.client_id, 'stable-client'); assert.equal(first.msg.context_token, 'context'); assert.equal(first.msg.run_id, 'run'); assert.equal(first.msg.item_list[0].type, 2);
  assert.equal(Buffer.from(first.msg.item_list[0].image_item.media.aes_key, 'base64').length, 16);
});
