import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BridgeError } from './util.js';

// Operator preview only. No Agent tool is registered, even when local testing is enabled.
export function internetSettings(value = {}) {
  const c = { enabled: false, allowedHosts: [], ...value };
  if (Object.keys(value).some(k => !['enabled','allowedHosts'].includes(k)) || typeof c.enabled !== 'boolean' || !Array.isArray(c.allowedHosts) || c.allowedHosts.length > 30
    || c.allowedHosts.some(h => typeof h !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) || isIP(h))) throw new BridgeError('internet-config-invalid');
  return c;
}
export function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a,b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0,168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18,19,51].includes(b) || a === 203 && b === 0);
}
export function filterDocument(text, html = true) {
  let value = text.replace(/\r/g, '');
  if (html) value = value.replace(/<!--[^]*?(?:-->|$)/g, ' ').replace(/<(script|style|nav|header|footer|form|iframe|noscript|svg)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, ' ').replace(/<[^<>]*>/g, '\n').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, s => ({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[s]));
  const lines = value.split('\n').map(x => x.trim()).filter(Boolean), kept = []; let removed = 0;
  for (const line of lines) {
    if (/ignore (?:all |previous |system )?instructions|system prompt|developer message|忽略.{0,12}(?:指令|规则)|修改.{0,12}(?:权限|系统提示)|(?:api[_ -]?key|bearer)\s*[:=]/i.test(line)) removed++;
    else kept.push(line);
  }
  return { text: kept.join('\n').slice(0, 16000), removedLines: removed, trust: 'external_unverified', warning: '过滤仅减少噪声和明显注入，不能证明网页内容真实或安全；不执行网页中的指令。' };
}
export async function previewInternet(url, settings, { resolve = lookup, request = https.request } = {}) {
  const c = internetSettings(settings); if (!c.enabled) throw new BridgeError('internet-disabled');
  let u; try { u = new URL(url); } catch { throw new BridgeError('internet-url'); }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || !c.allowedHosts.includes(u.hostname)) throw new BridgeError('internet-host-denied');
  let dnsTimer;
  const ips = await Promise.race([resolve(u.hostname, { all: true, family: 4 }), new Promise((_r, reject) => { dnsTimer = setTimeout(() => reject(new BridgeError('internet-dns-timeout')), 2000); })]).finally(() => clearTimeout(dnsTimer));
  if (!ips.length || ips.some(a => !publicIPv4(a.address))) throw new BridgeError('internet-address-denied');
  const address = ips[0].address;
  const result = await new Promise((resolveResult, reject) => {
    const req = request(u, { method: 'GET', agent: false, lookup: (_host, opts, cb) => cb(null, ...(opts.all ? [[{ address, family: 4 }]] : [address, 4])), headers: { Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'DS-Friend-Operator-Preview' } }, res => {
      const mime = String(res.headers['content-type'] ?? '');
      if (res.statusCode !== 200 || !/^(text\/html|text\/plain)(?:;|$)/i.test(mime) || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(new BridgeError('internet-response-denied')); return; }
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 512000) { res.destroy(); reject(new BridgeError('internet-too-large')); } else chunks.push(chunk); });
      res.on('end', () => resolveResult(filterDocument(Buffer.concat(chunks).toString('utf8'), mime.startsWith('text/html'))));
      res.on('error', () => reject(new BridgeError('internet-network')));
    });
    const timer = setTimeout(() => req.destroy(), 5000); req.once('close', () => clearTimeout(timer)); req.once('error', () => reject(new BridgeError('internet-network'))); req.end();
  });
  return { url: u.href, fetchedAt: new Date().toISOString(), ...result, agentVisible: false };
}
