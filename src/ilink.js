import { randomBytes } from 'node:crypto';
import { BridgeError, readJson, signalWithTimeout, VERSION } from './util.js';

const idFields = new Set(['message_id', 'msg_id', 'svr_id']);
// Node 24 JSON reviver source preserves uint64 identifiers before Number rounding.
export function parseIlink(text) {
  return JSON.parse(text, (key, value, context) => idFields.has(key) && typeof value === 'number' ? context.source : value);
}
export class IlinkClient {
  constructor(config, credentials = {}, fetchImpl = fetch) {
    this.config = config; this.credentials = credentials; this.fetch = fetchImpl;
    this.baseUrl = credentials.baseUrl ?? config.apiBaseUrl;
    this.validateHost(this.baseUrl);
    this.pollTimeout = config.pollTimeoutMs;
  }
  validateHost(value) {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/' || !this.config.allowedHosts.includes(u.hostname)) throw new BridgeError('ilink-host-rejected');
    return u.origin;
  }
  async request(endpoint, body, signal, { baseUrl = this.baseUrl, timeout = this.config.timeoutMs, auth = true, baseInfo = true } = {}) {
    this.validateHost(baseUrl);
    const parts = this.config.clientVersion.split('.').map(Number);
    const headers = { 'iLink-App-Id': this.config.appId, 'iLink-App-ClientVersion': String((parts[0] << 16) | (parts[1] << 8) | parts[2]) };
    if (body !== undefined) {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
      if (auth && this.credentials.botToken) headers.Authorization = `Bearer ${this.credentials.botToken}`;
    }
    let response;
    try {
      response = await this.fetch(new URL(endpoint, this.validateHost(baseUrl) + '/'), { method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify({ ...body, ...(baseInfo ? { base_info: { channel_version: this.config.clientVersion, bot_agent: `DeepSeek.Friend/${VERSION}` } } : {}) }),
        signal: signalWithTimeout(signal, timeout), redirect: 'error' });
    } catch { throw new BridgeError('ilink-network', 'iLink 网络错误或请求超时', { retryable: true, ambiguous: true }); }
    if (response.status === 401 || response.status === 403) throw new BridgeError('ilink-auth-expired', '微信授权失效，请运行 npm run login');
    if (response.status === 429) throw new BridgeError('ilink-rate-limit', 'iLink 限流', { retryable: true });
    if (!response.ok) throw new BridgeError(`ilink-http-${response.status}`, 'iLink HTTP 失败', { retryable: response.status >= 500, ambiguous: response.status >= 500 });
    let data;
    try {
      data = await readJson(response, 8 * 1024 * 1024, (key, value, context) => idFields.has(key) && typeof value === 'number' ? context.source : value);
    } catch { throw new BridgeError('ilink-response-invalid', 'iLink 响应无效', { ambiguous: true }); }
    if (data.ret === -14 || data.errcode === -14) throw new BridgeError('ilink-auth-expired', '微信授权失效，请重新扫码');
    if ((data.ret !== undefined && data.ret !== 0) || (data.errcode !== undefined && data.errcode !== 0)) throw new BridgeError('ilink-api-rejected', 'iLink 拒绝请求');
    return data;
  }
  updates(cursor, signal) { return this.request('ilink/bot/getupdates', { get_updates_buf: cursor }, signal, { timeout: this.pollTimeout }); }
  send(body, signal) { return this.request('ilink/bot/sendmessage', body, signal); }
  getConfig(user, context, signal) { return this.request('ilink/bot/getconfig', { ilink_user_id: user, context_token: context }, signal); }
  typing(user, ticket, status, signal) { return this.request('ilink/bot/sendtyping', { ilink_user_id: user, typing_ticket: ticket, status }, signal); }
}
export function textMessage(to, text, context, clientId, runId) {
  if (!to || !context || !clientId || !text) throw new BridgeError('reply-context-required');
  return { msg: { from_user_id: '', to_user_id: to, client_id: clientId, context_token: context,
    message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text } }], ...(runId ? { run_id: runId } : {}) } };
}
