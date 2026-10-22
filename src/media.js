// Official Tencent iLink CDN shape; independent of OpenClaw. See THIRD_PARTY_NOTICES.md.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { BridgeError, signalWithTimeout } from './util.js';
export function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new BridgeError('image-format');
}
export function mediaKey(item) {
  if (item.aeskey !== undefined) {
    if (!/^[a-f0-9]{32}$/i.test(item.aeskey)) throw new BridgeError('image-key-invalid');
    return Buffer.from(item.aeskey, 'hex');
  }
  if (!item.media?.aes_key) return null;
  const decoded = Buffer.from(item.media.aes_key, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f0-9]{32}$/i.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex');
  throw new BridgeError('image-key-invalid');
}
export class MediaClient {
  constructor(config, runtime, ilink, fetchImpl = fetch) { this.c = config; this.runtime = runtime; this.ilink = ilink; this.fetch = fetchImpl; }
  url(value) {
    let u; try { u = new URL(value); } catch { throw new BridgeError('cdn-host-rejected'); }
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || !this.c.allowedHosts.includes(u.hostname)) throw new BridgeError('cdn-host-rejected');
    return u;
  }
  async bytes(response, max) {
    if (Number(response.headers.get('content-length')) > max) throw new BridgeError('image-too-large');
    const parts = []; let size = 0;
    for await (const part of response.body ?? []) { size += part.byteLength; if (size > max) throw new BridgeError('image-too-large'); parts.push(part); }
    return Buffer.concat(parts);
  }
  save(bytes) {
    if (bytes.length > this.c.maxBytes) throw new BridgeError('image-too-large');
    const mediaType = imageType(bytes), id = 'img-' + createHash('sha256').update(bytes).digest('hex');
    const dir = path.join(this.runtime.dir, 'media'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, id + '.bin');
    try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.runtime.db.prepare('INSERT OR IGNORE INTO images(id,media_type,file,bytes,created) VALUES(?,?,?,?,?)').run(id, mediaType, file, bytes.length, Date.now());
    return { id, mediaType, data: bytes.toString('base64') };
  }
  async receive(item, signal) {
    const m = item.media;
    if (!m || (!m.full_url && !m.encrypt_query_param)) throw new BridgeError('image-reference-missing');
    const url = this.url(m.full_url || this.c.baseUrl + '/download?encrypted_query_param=' + encodeURIComponent(m.encrypt_query_param));
    let response;
    try { response = await this.fetch(url, { redirect: 'error', signal: signalWithTimeout(signal, this.c.timeoutMs) }); }
    catch { throw new BridgeError('image-download', '', { retryable: true }); }
    if (!response.ok) throw new BridgeError('image-download', '', { retryable: response.status >= 500 });
    const encrypted = await this.bytes(response, this.c.maxBytes + 16), key = mediaKey(item);
    let bytes = encrypted;
    if (key) { try { const cipher = createDecipheriv('aes-128-ecb', key, null); bytes = Buffer.concat([cipher.update(encrypted), cipher.final()]); } catch { throw new BridgeError('image-decrypt'); } }
    return this.save(bytes);
  }
  image(id) {
    const row = this.runtime.db.prepare('SELECT * FROM images WHERE id=?').get(id); if (!row) throw new BridgeError('image-not-found');
    const expected = path.join(this.runtime.dir, 'media', id + '.bin');
    if (row.file !== expected || fs.lstatSync(expected).isSymbolicLink() || fs.statSync(expected).size > this.c.maxBytes) throw new BridgeError('image-path');
    const bytes = fs.readFileSync(expected);
    if ('img-' + createHash('sha256').update(bytes).digest('hex') !== id) throw new BridgeError('image-integrity');
    imageType(bytes); return { row, bytes };
  }
  async prepare(id, imageId, to, context, clientId, runId, signal) {
    const { bytes } = this.image(imageId);
    this.runtime.db.prepare('INSERT OR IGNORE INTO uploads(id,filekey,aes) VALUES(?,?,?)').run(id, randomBytes(16).toString('hex'), randomBytes(16).toString('hex'));
    const row = this.runtime.db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
    let result = row.result && JSON.parse(row.result);
    if (!result) {
      const aes = Buffer.from(row.aes, 'hex'), cipher = createCipheriv('aes-128-ecb', aes, null);
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const response = await this.ilink.request('ilink/bot/getuploadurl', { filekey: row.filekey, media_type: 1, to_user_id: to,
        rawsize: bytes.length, rawfilemd5: createHash('md5').update(bytes).digest('hex'), filesize: ciphertext.length, no_need_thumb: true, aeskey: row.aes }, signal);
      if (!response.upload_full_url && !response.upload_param) throw new BridgeError('image-upload-url');
      const url = this.url(response.upload_full_url || this.c.baseUrl + '/upload?encrypted_query_param=' + encodeURIComponent(response.upload_param) + '&filekey=' + row.filekey);
      let uploaded;
      try { uploaded = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: ciphertext, redirect: 'error', signal: signalWithTimeout(signal, this.c.timeoutMs) }); }
      catch { throw new BridgeError('image-upload', '', { retryable: true }); }
      const param = uploaded.headers.get('x-encrypted-param');
      if (!uploaded.ok || !param) throw new BridgeError('image-upload', '', { retryable: uploaded.status >= 500 || uploaded.ok });
      result = { param, aes: aes.toString('base64'), bytes: ciphertext.length };
      this.runtime.db.prepare('UPDATE uploads SET result=? WHERE id=?').run(JSON.stringify(result), id);
    }
    return { msg: { from_user_id: '', to_user_id: to, client_id: clientId, context_token: context, message_type: 2, message_state: 2,
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: result.param, aes_key: result.aes, encrypt_type: 1 }, mid_size: result.bytes } }], ...(runId ? { run_id: runId } : {}) } };
  }
}
