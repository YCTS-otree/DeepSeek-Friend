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

const controller = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { log('bridge.stopping'); controller.abort(); });

async function doLogin(config, old) {
  const client = new IlinkClient(config.weixin);
  const result = await login(client, {
    signal: controller.signal, existing: old,
    display: content => { process.stdout.write('请用手机微信扫描二维码并确认授权（二维码仅用于当前登录）：\n'); qrcode.generate(content, { small: true }); process.stdout.write(content + '\n'); },
    notice: text => process.stdout.write(text + '\n'),
    verify: async signal => {
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
    await new Engine(c, store, dsh, client, credentials, controller.signal).run();
  } finally { controller.abort(); if (unlockAccount) await unlockAccount(); store?.close(); release(); }
}
main().catch(e => {
  if (!controller.signal.aborted || e.name !== 'AbortError') {
    const messages = {
      'dsh-auth-required': '请先运行 npm run dsh:start，再设置独立实例的 DSH_LAUNCH_TOKEN。',
      'dsh-auth-rejected': '独立 DSH 凭证失效，请更新 DSH_LAUNCH_TOKEN 或 DSH_COOKIE。',
      'ilink-auth-expired': '微信授权失效，轮询已停止。请运行 npm run login。',
      'instance-running': '该 data 目录已有实例运行；本地维护命令请先停止 Bridge。',
      'account-running': '该微信账号已被另一个 Bridge 实例占用。',
    };
    log('bridge.failed', { code: e.code ?? 'internal' });
    console.error(messages[e.code] ?? '启动或运行失败，请按错误码查阅 docs/operations.md。'); process.exitCode = 1;
  }
});
