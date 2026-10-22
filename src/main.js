import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './config.js';
import { secureDirectory, saveCredentials, loadCredentials } from './security.js';
import { dataLock, accountLock } from './lock.js';
import { Store } from './store.js';
import { IlinkClient } from './ilink.js';
import { DshClient } from './dsh.js';
import { Engine } from './engine.js';
import { login } from './auth.js';
import { BridgeError, VERSION, log } from './util.js';
import { LauncherIO } from './launcher-io.js';

const controller = new AbortController();
let stoppingRequested = false;
const stop = () => { stoppingRequested = true; controller.abort(); };
const ui = process.env.BRIDGE_LAUNCHER === '1' ? new LauncherIO({ shutdown: stop }) : null;
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { log('bridge.stopping'); stop(); });

async function doLogin(config, old) {
  const client = new IlinkClient(config.weixin);
  const result = await login(client, {
    signal: controller.signal, existing: old,
    display: content => { if (ui) return ui.qr(content); process.stdout.write('请用手机微信扫描二维码并确认授权（二维码仅用于当前登录）：\n'); qrcode.generate(content, { small: true }); process.stdout.write(content + '\n'); },
    notice: text => { if (!ui) process.stdout.write(text + '\n'); },
    status: state => ui?.emit('ui.login', { state }),
    verify: async signal => {
      if (ui) return ui.verify(signal);
      if (!process.stdin.isTTY) throw new BridgeError('verification-needs-tty', '请输入手机验证码，需交互式终端');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const code = (await rl.question('输入手机微信显示的数字：', { signal })).trim();
        if (!/^\d{1,12}$/.test(code)) throw new BridgeError('verification-code-invalid');
        return code;
      } finally { rl.close(); }
    },
  });
  if (old && old.accountId !== result.accountId) log('weixin.account-changed');
  saveCredentials(config.dataDir, result); log('weixin.login-success'); return result;
}
async function main() {
  const command = process.argv[2] ?? 'start'; const c = loadConfig();
  if (command === 'help' || command === '--help') {
    console.log('DeepSeek:Friend ' + VERSION + '\nstart | login | doctor | status | outbox retry|discard <id>\n配置：config.json 或 BRIDGE_CONFIG；详细部署步骤见 README.md'); return;
  }
  if (command === 'status') {
    const file = path.join(c.dataDir, 'bridge.sqlite');
    if (!fs.existsSync(file)) { console.log('Bridge 尚未建立消息数据库。'); return; }
    const read = new Store(file, { readOnly: true });
    try { console.log(JSON.stringify(read.stats(), null, 2)); } finally { read.close(); }
    return;
  }
  secureDirectory(c.dataDir);
  const release = dataLock(c.dataDir); let unlockAccount; let store;
  try {
    const account = loadCredentials(c.dataDir);
    if (command === 'login') { if (account) unlockAccount = await accountLock(account.accountId); await doLogin(c, account); return; }
    if (command === 'status' || command === 'outbox') {
      store = new Store(path.join(c.dataDir, 'bridge.sqlite'));
      if (command === 'status') { console.log(JSON.stringify(store.stats(), null, 2)); return; }
      const [, , , action, id] = process.argv;
      if (!['retry', 'discard'].includes(action) || !id) throw new BridgeError('usage', '用法：node src/main.js outbox retry|discard <id>，请先停止 Bridge');
      const changes = store.db.prepare("UPDATE outbox SET state=?,retry_at=0 WHERE id=? AND state IN ('unknown','failed')").run(action === 'retry' ? 'pending' : 'discarded', id).changes;
      if (!changes) throw new BridgeError('outbox-not-found');
      log('outbox.' + action, { id }); return;
    }
    if (!c.dsh.launchToken && !c.dsh.cookie) {
      const saved = loadCredentials(c.dataDir, 'dsh-connection.json');
      if (saved?.baseUrl === c.dsh.baseUrl) c.dsh.cookie = saved.cookie;
    }
    const dsh = new DshClient(c.dsh);
    if (command === 'doctor') {
      let ok = true;
      try { await dsh.check(controller.signal); console.log('独立 DSH: 鉴权与 Preset 检查通过；会话/模型能力仍需验收'); }
      catch (e) { ok = false; console.log('独立 DSH: ' + (e.code ?? 'unavailable')); }
      console.log('微信凭证: ' + (account ? '已保存（未进行远程验证）' : '未登录'));
      console.log('工作 DSH 3080: 禁止连接；当前目标: ' + c.dsh.baseUrl);
      if (!ok) process.exitCode = 1; return;
    }
    if (command !== 'start') throw new BridgeError('command-unknown');
    if (!c.weixin.enabled) throw new BridgeError('weixin-disabled');
    fs.mkdirSync(c.dsh.cwd, { recursive: true });
    // Verify DSH before asking the user to scan; no changes to its global configuration.
    await dsh.check(controller.signal);
    const credentials = account ?? await doLogin(c, null);
    if (!credentials.ownerId) throw new BridgeError('weixin-owner-missing');
    unlockAccount = await accountLock(credentials.accountId);
    const client = new IlinkClient(c.weixin, credentials);
    store = new Store(path.join(c.dataDir, 'bridge.sqlite'));
    log('bridge.started', { version: VERSION });
    const engine = new Engine(c, store, dsh, client, credentials, controller.signal);
    if (ui) ui.sessions = (action, args) => {
      if (['create', 'switch', 'archive'].includes(action) && (engine.busy.size || engine.chains.size)) throw new BridgeError('session-busy');
      const result = store.sessionControl(action, args);
      if (['create', 'switch'].includes(action)) dsh.follow(result.session);
      return result;
    };
    await engine.run();
  } finally { controller.abort(); if (unlockAccount) await unlockAccount(); store?.close(); release(); }
}
main().catch(e => {
  if (!stoppingRequested) {
    const messages = {
      'dsh-auth-required': '请先在另一个终端运行 npm run dsh:start，等待 dsh.independent-ready，再运行 npm start。',
      'dsh-auth-rejected': '独立 DSH 连接凭证失效。请先重启 npm run dsh:start，再重启 Bridge；显式环境凭证也需检查。',
      'dsh-network': '无法连接独立 DSH。请先在另一个终端运行 npm run dsh:start，等待 dsh.independent-ready，再启动 Bridge。',
      'dsh-unavailable': '独立 DSH 尚未就绪。请先启动独立 DSH 并等待 dsh.independent-ready。',
      'ilink-auth-expired': '微信授权失效，轮询已停止。请运行 npm run login。',
      'instance-running': '该 data 目录已有实例运行；本地维护命令请先停止 Bridge。',
      'account-running': '该微信账号已被另一个 Bridge 实例占用。',
      'data-directory-access': '无法访问运行目录，请检查该目录的所有者及当前 Windows 用户权限。',
      'data-acl-access-denied': '运行目录 ACL 拒绝访问。请由原目录所有者恢复当前 Windows 用户的权限；不需要放开 Everyone 权限。',
      'data-acl-verify': '运行目录权限校验失败，已停止以保护凭证。',
      'data-acl-tool-failed': 'Windows ACL 检查失败，请确认 Windows PowerShell 可用。',
      'credential-protection': '当前 Windows 用户无法解密原用户的凭证。请先运行 npm run dsh:start 刷新独立 DSH 连接；微信凭证需要使用原用户或重新扫码。',
    };
    log('bridge.failed', { code: e.code ?? 'internal' });
    console.error(messages[e.code] ?? '启动或运行失败，请按错误码查阅 docs/operations.md。'); process.exitCode = 1;
  }
}).finally(() => ui?.close());
