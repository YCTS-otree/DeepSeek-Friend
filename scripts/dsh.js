import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { secureDirectory, saveCredentials } from '../src/security.js';
import { DshClient } from '../src/dsh.js';
import { log } from '../src/util.js';
import { profileArguments, apiKeyEnvironment } from './runtime-options.js';
import { LauncherIO } from '../src/launcher-io.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = path.join(root, '.runtime');
const expectedVersion = '0.2.0-rc.2';
const installed = path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
const command = process.argv[2] ?? 'start';
async function main() {
  if (command === 'setup') {
    fs.mkdirSync(runtime, { recursive: true });
    const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error('npm-cli-not-found; run npm install --prefix .runtime @deepseek-ai/dsh@' + expectedVersion);
    if (path.dirname(runtime) !== path.resolve(root) || path.basename(runtime) !== '.runtime') throw new Error('runtime-path-invalid');
    fs.copyFileSync(path.join(root, 'dsh/runtime-package.json'), path.join(runtime, 'package.json'));
    fs.copyFileSync(path.join(root, 'dsh/runtime-package-lock.json'), path.join(runtime, 'package-lock.json'));
    const result = spawnSync(process.execPath, [npmCli, 'ci', '--prefix', runtime, '--cache', path.join(root, '.research/npm-cache'),
      '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error('dsh-install-failed');
    console.log('独立 DSH 已安装。运行 npm run dsh:start -- --open 配置模型。'); return;
  }
  if (command !== 'start') throw new Error('usage: node scripts/dsh.js setup|start [--open]');
  if (!fs.existsSync(installed)) throw new Error('dsh-not-installed; run npm run dsh:setup');
  if (JSON.parse(fs.readFileSync(installed, 'utf8')).version !== expectedVersion) throw new Error('dsh-version-mismatch');
  const c = loadConfig(); const home = path.join(runtime, 'home');
  // A second wrapper must never adopt or overwrite the credentials of an occupied port.
  const { createServer } = await import('node:net');
  await new Promise((resolve, reject) => {
    const probe = createServer(); probe.once('error', () => reject(Object.assign(new Error(), { code: 'dsh-port-in-use' })));
    probe.listen(Number(new URL(c.dsh.baseUrl).port), '127.0.0.1', () => probe.close(resolve));
  });
  secureDirectory(home); secureDirectory(c.dataDir); fs.mkdirSync(c.dsh.cwd, { recursive: true });
  const overlay = path.join(runtime, 'weixin-resolved.patch.yml');
  fs.writeFileSync(overlay, fs.readFileSync(path.join(root, 'dsh/weixin.patch.yml'), 'utf8')
    .replaceAll('__WEIXIN_POLICY__', JSON.stringify(pathToFileURL(path.join(root, 'dsh/weixin-policy.js')).href)));
  fs.writeFileSync(overlay, fs.readFileSync(overlay, 'utf8')
    .replaceAll('__COGNITIVE_PLUGIN__', JSON.stringify(pathToFileURL(path.join(root, 'dsh/cognitive.js')).href)));
  const credentials = apiKeyEnvironment(root);
  const env = { ...credentials.env, DSH_HOME: home };
  env.DS_FRIEND_COGNITIVE = JSON.stringify({ dir: path.join(c.dataDir, 'cognitive'), interaction: c.interaction.enabled, config: { ...c.cognitive, provider: 'deepseek-official', model: 'deepseek-flash' } });
  if (credentials.loaded) log('dsh.api-key-loaded');
  delete env.DSH_WEB_URL; delete env.DSH_LAUNCH_TOKEN; delete env.DSH_COOKIE;
  const child = spawn(process.execPath, [path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    ...profileArguments(home), '--patch', overlay,
    '--host', '127.0.0.1', '--port', new URL(c.dsh.baseUrl).port, '--no-open'],
  { cwd: c.dsh.cwd, env, stdio: [process.env.BRIDGE_LAUNCHER === '1' ? 'ignore' : 'inherit', 'pipe', 'pipe'], windowsHide: true });
  let launchUrl; let stopping = false;
  const stop = () => { stopping = true; child.kill(); };
  const open = async () => {
    if (!launchUrl) return;
    const opener = await import(pathToFileURL(path.join(runtime, 'node_modules/open/index.js')).href);
    await opener.default(launchUrl);
  };
  const ui = process.env.BRIDGE_LAUNCHER === '1' ? new LauncherIO({ shutdown: stop, open }) : null;
  let authenticated = false; let text = ''; let connecting = false;
  async function inspect(chunk) {
    text = (text + chunk.toString()).slice(-16_000);
    if (authenticated || connecting) return;
    const match = text.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=([A-Za-z0-9_-]+)/);
    if (!match) return;
    connecting = true;
    try {
      const client = new DshClient({ ...c.dsh, launchToken: match[1], cookie: '' });
      await client.auth();
      saveCredentials(c.dataDir, { baseUrl: c.dsh.baseUrl, cookie: client.cookie }, 'dsh-connection.json');
      authenticated = true; text = ''; log('dsh.independent-ready', { version: expectedVersion });
      launchUrl = new URL('/?token=' + encodeURIComponent(match[1]), c.dsh.baseUrl).href;
      if (process.argv.includes('--open')) {
        // Open directly; never print the credential-bearing URL to terminal output or log files.
        await open();
      }
    } catch (e) { log('dsh.connection-failed', { code: e.code ?? 'auth' }); }
    finally { connecting = false; }
  }
  child.stdout.on('data', chunk => { inspect(chunk).catch(() => log('dsh.launch-output-error')); });
  child.stderr.on('data', chunk => { inspect(chunk).catch(() => log('dsh.launch-output-error')); });
  // DSH diagnostics can contain credentials; expose only an operational marker.
  const warning = setTimeout(() => { if (!authenticated) log('dsh.startup-pending', { code: 'no-auth-url-yet' }); }, 30_000);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, stop);
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { clearTimeout(warning); text = ''; launchUrl = null; if (code && !signal && !stopping) { log('dsh.exited', { code: 'exit-' + code }); process.exitCode = code; } resolve(); });
  });
  ui?.close();
}
main().catch(e => {
  const known = ['dsh-not-installed', 'dsh-version-mismatch', 'npm-cli-not-found', 'dsh-install-failed', 'runtime-path-invalid'];
  const prefix = typeof e.message === 'string' ? e.message.split(';')[0] : '';
  const code = typeof e.code === 'string' && /^[a-z0-9_/-]{1,80}$/i.test(e.code) ? e.code : known.includes(prefix) ? prefix : 'startup-failed';
  log('dsh.failed', { code });
  if (code === 'data-acl-access-denied' || code === 'data-directory-access') console.error('独立 DSH 运行目录权限不足，请由原目录所有者修复当前 Windows 用户的访问权。');
  console.error('独立 DSH 启动/安装失败。检查 API Key 文件、.runtime 安装版本、3088 端口以及 docs/operations.md。'); process.exitCode = 1;
});
