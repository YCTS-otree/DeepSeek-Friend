import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { BridgeError, readJson, signalWithTimeout, backoff, sleep, requireLoopback } from './util.js';

const wrappers = { 'session/list': '_request', 'session/create': 'request', 'session/prompt': 'request', 'session/cancel': 'request',
  'session/follow': 'request', 'session/page': 'request', 'session/projections': 'request', 'session/updateQueue': 'request', 'session/selectModel': 'request' };
export class DshClient extends EventEmitter {
  constructor(config, { fetchImpl = fetch, Socket = WebSocket } = {}) {
    super(); this.config = config; requireLoopback(config.baseUrl); this.fetch = fetchImpl; this.Socket = Socket;
    this.cookie = config.cookie || ''; this.follows = new Set(); this.streams = new Map(); this.clientId = null; this.waitStreams = new Map();
  }
  async auth(signal) {
    if (this.cookie) return this.cookie;
    if (this.authPromise) return this.authPromise;
    if (!this.config.launchToken) throw new BridgeError('dsh-auth-required', '请提供独立 DSH 启动 URL 中的 DSH_LAUNCH_TOKEN，或 DSH_COOKIE');
    this.authPromise = (async () => {
      const url = new URL('/', this.config.baseUrl); url.searchParams.set('token', this.config.launchToken);
      let r;
      try { r = await this.fetch(url, { redirect: 'manual', signal: signalWithTimeout(signal, this.config.timeoutMs) }); }
      catch { throw new BridgeError('dsh-unavailable', '独立 DSH 尚未启动', { retryable: true }); }
      if (r.status !== 302 && r.status !== 303) throw new BridgeError('dsh-auth-rejected', '独立 DSH 启动凭证失效，请更新环境变量');
      const cookies = r.headers.getSetCookie();
      this.cookie = cookies.map(x => x.split(';')[0]).filter(x => x.startsWith('dsh-auth-')).join('; ');
      if (!this.cookie) throw new BridgeError('dsh-cookie-missing');
      return this.cookie;
    })();
    try { return await this.authPromise; } finally { this.authPromise = null; }
  }
  async rpc(endpoint, args = {}, signal) {
    const cookie = await this.auth(signal); const rpcId = randomUUID();
    const wrapped = Object.hasOwn(wrappers, endpoint) ? { [wrappers[endpoint]]: args } : args;
    const body = { type: 'client-request', rpcId, method: endpoint, payload: { args: wrapped } };
    let r;
    try { r = await this.fetch(new URL('/api/' + endpoint, this.config.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body), redirect: 'error', signal: signalWithTimeout(signal, this.config.timeoutMs) }); }
    catch { throw new BridgeError('dsh-network', 'DSH RPC 网络错误或超时', { retryable: true, ambiguous: true }); }
    if (r.status === 401 || r.status === 403) { this.cookie = ''; throw new BridgeError('dsh-auth-rejected', 'DSH 凭证失效'); }
    if (!r.ok) throw new BridgeError('dsh-http-' + r.status, 'DSH RPC HTTP 失败', { retryable: r.status >= 500, ambiguous: true });
    const response = await readJson(r);
    if (response.type !== 'server-response' || response.rpcId !== rpcId || typeof response.result?.ok !== 'boolean') throw new BridgeError('dsh-protocol');
    if (!response.result.ok) throw new BridgeError(response.result.error?.code ?? 'dsh-rpc-failed');
    return response.result.value;
  }
  async check(signal) {
    const roster = await this.rpc('agentPresets/list', {}, signal);
    const preset = roster?.presets?.find(p => p.id === this.config.agentPreset && !p.broken);
    if (!preset) throw new BridgeError('dsh-preset-missing', '独立 DSH 中缺少指定的可用 Preset');
    return { preset: preset.id };
  }
  follow(session) { this.follows.add(session); if (this.socket?.readyState === WebSocket.OPEN) this.openFollow(session); }
  unfollow(session) {
    this.follows.delete(session);
    for (const [streamId, sid] of this.streams) if (sid === session) {
      this.streams.delete(streamId);
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId }));
    }
  }
  openFollow(session) {
    if ([...this.streams.values()].includes(session)) return;
    const streamId = randomUUID(); this.streams.set(streamId, session);
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: {
      address: { kind: 'session', sessionId: session }, maxMessages: 200 } } } }));
  }
  holdQuestion(session, callId, id) {
    if (this.waitStreams.has(id) || this.socket?.readyState !== WebSocket.OPEN || !callId) return;
    const streamId = randomUUID(); this.waitStreams.set(id, streamId);
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'userQuestions/attachWait', payload: { args: { agentId: session, callId } } }));
  }
  releaseQuestion(id) {
    const streamId = this.waitStreams.get(id); this.waitStreams.delete(id);
    if (streamId && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId }));
  }
  async run(signal) {
    let attempt = 0;
    while (!signal.aborted) {
      try { await this.connect(signal); attempt = 0; }
      catch (e) { if (!signal.aborted) this.emit('diagnostic', e.code ?? 'dsh-stream'); }
      this.clientId = null; this.emit('disconnected');
      if (!signal.aborted) await sleep(backoff(attempt++), signal).catch(() => {});
    }
  }
  async connect(signal) {
    const cookie = await this.auth(signal);
    if (signal.aborted) return;
    const url = new URL('/api/remote.mux', this.config.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.streams.clear(); this.waitStreams.clear(); this.clientId = null;
    const socket = new this.Socket(url, { headers: { cookie }, handshakeTimeout: this.config.timeoutMs, maxPayload: 8 * 1024 * 1024, followRedirects: false });
    this.socket = socket; const eventStream = randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => socket.terminate(), this.config.timeoutMs);
      const abort = () => socket.terminate();
      signal.addEventListener('abort', abort, { once: true });
      socket.on('open', () => {
        clearTimeout(timer);
        socket.send(JSON.stringify({ type: 'open', streamId: eventStream, endpoint: '$events', payload: { args: {} } }));
        for (const session of this.follows) this.openFollow(session);
      });
      socket.on('message', (raw, binary) => {
        try {
          if (binary) throw new BridgeError('dsh-binary-frame');
          const frame = JSON.parse(raw.toString());
          if (typeof frame.streamId !== 'string') throw new BridgeError('dsh-frame');
          if (frame.type === 'error' || frame.type === 'end') {
            const waiting = [...this.waitStreams.entries()].find(([, stream]) => stream === frame.streamId);
            if (waiting) { this.waitStreams.delete(waiting[0]); return; }
            if (frame.streamId !== eventStream && !this.streams.has(frame.streamId)) return;
            const sid = this.streams.get(frame.streamId);
            if (sid && frame.error?.code === 'session/not-found') {
              this.follows.delete(sid); this.streams.delete(frame.streamId); this.emit('missing', sid); return;
            }
            throw new BridgeError(frame.error?.code ?? 'dsh-stream-ended');
          }
          if (frame.type !== 'item') return;
          if (frame.streamId === eventStream) {
            const v = frame.value;
            if (v.type === 'ready') { this.clientId = v.clientId; this.emit('connected'); }
            else if (v.type === 'waterfall' && this.clientId) this.emit('request', { ...v, clientId: this.clientId });
            else if (v.type === 'cancel') this.emit('cancelRequest', v);
            else if (v.type === 'emit') this.emit('remote', v);
          } else {
            const sid = this.streams.get(frame.streamId);
            if (sid) this.emit('session', sid, frame.value);
          }
        } catch (e) { this.emit('diagnostic', e.code ?? 'dsh-frame-invalid'); socket.terminate(); }
      });
      socket.on('error', () => reject(new BridgeError('dsh-stream-network', 'DSH WebSocket 失败', { retryable: true })));
      socket.on('unexpected-response', (_request, response) => { if (response.statusCode === 401) this.cookie = ''; response.resume(); socket.terminate(); });
      socket.once('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); });
    });
  }
  async result(request, value, signal) {
    if (!this.clientId || request.client_id !== this.clientId) throw new BridgeError('pending-stale');
    return this.rpc('$events/result', { clientId: request.client_id, eventId: request.event_id, outcome: { kind: 'result', value } }, signal);
  }
}
