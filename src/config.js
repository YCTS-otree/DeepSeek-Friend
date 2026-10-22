import fs from 'node:fs';
import path from 'node:path';
import { BridgeError, requireLoopback } from './util.js';
import { cognitiveConfig } from './cognitive/config.js';

export function loadConfig(file = process.env.BRIDGE_CONFIG ?? 'config.json', env = process.env) {
  let input = {};
  if (fs.existsSync(file)) input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = path.resolve(path.dirname(file));
  const c = {
    dataDir: path.resolve(root, env.BRIDGE_DATA_DIR ?? input.dataDir ?? 'data'),
    dsh: {
      baseUrl: env.DSH_BASE_URL ?? input.dsh?.baseUrl ?? 'http://127.0.0.1:3088',
      agentPreset: input.dsh?.agentPreset ?? 'weixin',
      cwd: path.resolve(root, input.dsh?.cwd ?? 'data/workspaces'),
      timeoutMs: input.dsh?.timeoutMs ?? 15_000,
      turnTimeoutMs: input.dsh?.turnTimeoutMs ?? 600_000,
      launchToken: env.DSH_LAUNCH_TOKEN ?? '', cookie: env.DSH_COOKIE ?? '',
    },
    weixin: {
      enabled: input.weixin?.enabled ?? true,
      apiBaseUrl: input.weixin?.apiBaseUrl ?? 'https://ilinkai.weixin.qq.com',
      allowedHosts: input.weixin?.allowedHosts ?? ['ilinkai.weixin.qq.com'],
      appId: input.weixin?.appId ?? 'bot',
      clientVersion: input.weixin?.clientVersion ?? '2.4.10',
      allowedUsers: env.WEIXIN_ALLOWED_USERS?.split(',').filter(Boolean) ?? input.weixin?.allowedUsers ?? [],
      timeoutMs: input.weixin?.timeoutMs ?? 15_000,
      pollTimeoutMs: input.weixin?.pollTimeoutMs ?? 35_000,
    },
    bridge: { maxTextChars: input.bridge?.maxTextChars ?? 16_000, maxReplyChars: input.bridge?.maxReplyChars ?? 2000,
      concurrency: input.bridge?.concurrency ?? 4, approvalTimeoutMs: input.bridge?.approvalTimeoutMs ?? 300_000,
      allowApprovals: input.bridge?.allowApprovals ?? false },
    cognitive: cognitiveConfig(input.cognitive),
  };
  const u = requireLoopback(c.dsh.baseUrl);
  if (u.port === '3080') throw new BridgeError('working-dsh-refused', '3080 是工作 DSH 端口；请使用独立实例（默认 3088）');
  if (typeof c.dsh.agentPreset !== 'string' || !/^[A-Za-z0-9_-]+$/.test(c.dsh.agentPreset)) throw new BridgeError('preset-required');
  const api = new URL(c.weixin.apiBaseUrl);
  if (!Array.isArray(c.weixin.allowedHosts) || c.weixin.allowedHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host))) throw new BridgeError('allowed-hosts');
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash || api.pathname !== '/' || api.port
      || !c.weixin.allowedHosts.includes(api.hostname)) throw new BridgeError('weixin-url', 'iLink 必须使用显式允许的 HTTPS 域名');
  const { allowApprovals, ...numbers } = c.bridge;
  for (const [name, value] of Object.entries({ ...numbers, dshTimeout: c.dsh.timeoutMs, turnTimeout: c.dsh.turnTimeoutMs,
    wxTimeout: c.weixin.timeoutMs, pollTimeout: c.weixin.pollTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new BridgeError('config-number', `无效配置: ${name}`);
  }
  if (c.bridge.concurrency > 32 || c.bridge.maxReplyChars > 4000 || c.bridge.maxTextChars > 100_000) throw new BridgeError('config-range');
  if (!Array.isArray(c.weixin.allowedUsers) || c.weixin.allowedUsers.some(x => typeof x !== 'string' || !x.trim())) throw new BridgeError('allowed-users');
  if (typeof c.weixin.enabled !== 'boolean' || typeof allowApprovals !== 'boolean'
    || typeof c.weixin.clientVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(c.weixin.clientVersion)
    || c.weixin.clientVersion.split('.').some(x => Number(x) > 255) || typeof c.weixin.appId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(c.weixin.appId)) throw new BridgeError('config-types');
  return c;
}
