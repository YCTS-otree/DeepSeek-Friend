import { setTimeout as delay } from 'node:timers/promises';

export const VERSION = '1.13.2';
export class BridgeError extends Error {
  constructor(code, message = code, { retryable = false, ambiguous = false } = {}) {
    super(message); this.code = code; this.retryable = retryable; this.ambiguous = ambiguous;
  }
}
export const sleep = (ms, signal) => delay(ms, undefined, { signal });
export const backoff = (attempt, random = Math.random) => Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) + Math.floor(random() * 250);
export function log(event, fields = {}) {
  // Only emit selected operational metadata. Never log remote bodies, user text or errors' messages/stacks.
  const safe = {};
  for (const key of ['code', 'attempt', 'count', 'state', 'job', 'id', 'version']) {
    if (fields[key] !== undefined) safe[key] = fields[key];
  }
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...safe }) + '\n');
}
export function signalWithTimeout(signal, ms) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}
export async function readJson(response, limit = 8 * 1024 * 1024, reviver) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw new BridgeError('response-too-large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'), reviver);
}
export function requireLoopback(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new BridgeError('dsh-url', 'DSH 地址必须是无路径、无凭证的本机回环 HTTP(S) 地址');
  return u;
}
