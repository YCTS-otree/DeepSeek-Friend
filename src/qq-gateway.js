import { createHash } from 'node:crypto';
import { BridgeError, readJson } from './util.js';
import { qrSvg } from './launcher-io.js';

export const GATEWAY = { version: '4.18.41', webPort: 6101, wsPort: 3001,
  url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.Windows.Node.zip',
  sha256: '51fbb10e7bcd56b0c2a6de86c37811e7518330e48a137ac689ab1e4d8627d3f0' };
export function oneBotConfiguration(token) {
  return { network: { httpServers: [], httpSseServers: [], httpClients: [], websocketClients: [], plugins: [],
    websocketServers: [{ name: 'DeepSeekFriend', enable: true, host: '127.0.0.1', port: GATEWAY.wsPort, messagePostFormat: 'array', reportSelfMessage: false, token, enableForcePushEvent: true, debug: false, heartInterval: 30000 }] } };
}
export function gatewayErrorDetail(value) {
  if(typeof value!=='string')return '';
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[PRIVATE KEY REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi,'[URL REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+/=.-]+/gi,'[AUTH REDACTED]')
    .replace(/((?:["']?(?:bot_token|access_token|token|cookie|credential|password|passwordMd5|authorization)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,'$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[API KEY REDACTED]').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,2000);
}
export function loginView(data) {
  const known = ['waiting_qrcode','generating_qrcode','qrcode_scanned','initializing','ready','offline','reconnecting'];
  const online = data?.isLogin === true && data?.coreReady === true;
  const error=String(data?.loginError??'');
  const issue=/已登录.{0,20}(?:无法|不能)重复登录|already.{0,20}logged\s*in/i.test(error)?'account_in_use':null;
  const phase = online ? 'ready' : issue ?? (known.includes(data?.loginPhase) ? data.loginPhase : 'starting');
  let svg = null;
  if (!online && typeof data?.qrcodeurl === 'string' && data.qrcodeurl.length < 2048 && data.qrcodeurl) {
    let u; try { u = new URL(data.qrcodeurl); } catch { throw new BridgeError('qq-gateway-qr-invalid'); }
    if (!['https:','http:'].includes(u.protocol) || u.username || u.password || u.port || !(u.hostname === 'qq.com' || u.hostname.endsWith('.qq.com'))) throw new BridgeError('qq-gateway-qr-invalid');
    if (!['qrcode_scanned','initializing','reconnecting','account_in_use'].includes(phase)) svg = qrSvg(data.qrcodeurl);
  }
  return { phase, online, svg, loginError: Boolean(error), errorDetail:gatewayErrorDetail(error) };
}
export class NapCatApi {
  constructor(token, { fetcher = fetch } = {}) { this.token = token; this.fetcher = fetcher; this.credential = null; }
  async request(route, body = {}, authenticated = true) {
    if (!/^\/(auth\/login|QQLogin\/(CheckLoginStatus|RefreshQRcode|GetQQLoginInfo|SetQuickLoginQQ)|OB11Config\/SetConfig)$/.test(route)) throw new BridgeError('qq-gateway-api-denied');
    if (authenticated && !this.credential) await this.login();
    let response;
    try { response = await this.fetcher('http://127.0.0.1:' + GATEWAY.webPort + '/api' + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + this.credential } : {}) }, body: JSON.stringify(body) }); }
    catch(e) { throw Object.assign(new BridgeError('qq-gateway-network', '', { retryable: true }),{detail:gatewayErrorDetail(e.message)}); }
    const result = await readJson(response, 100000);
    if (!response.ok || result.code !== 0) { this.credential = null; throw Object.assign(new BridgeError(!response.ok?'qq-gateway-http':'qq-gateway-api'),{detail:gatewayErrorDetail(result.message??result.msg??'HTTP '+response.status)}); }
    return result.data;
  }
  async login() {
    const data = await this.request('/auth/login', { hash: createHash('sha256').update(this.token + '.napcat').digest('hex') }, false);
    if (typeof data?.Credential !== 'string' || data.require2FA) throw new BridgeError('qq-gateway-auth');
    this.credential = data.Credential;
  }
  async status() { return loginView(await this.request('/QQLogin/CheckLoginStatus')); }
  async refresh() { await this.request('/QQLogin/RefreshQRcode'); }
  async configure(token) { await this.request('/OB11Config/SetConfig', { config: JSON.stringify(oneBotConfiguration(token)) }); }
}
