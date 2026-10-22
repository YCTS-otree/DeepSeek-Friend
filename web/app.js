const $ = id => document.getElementById(id);
let state; let qrRevision = -1; let offline = false; let sending = false; let clientError = null;
const errors = {
  'node-not-found': '没有找到 Node.js。请确认 Node 24 或更新版本已加入 PATH。',
  'config-invalid': '配置校验失败，请检查 config.json、环境变量与 docs/operations.md。',
  'dsh-port-in-use': '独立 DSH 的端口已有程序使用。请先在原终端停止 npm run dsh:start，再由此页面启动。启动器不会结束其他程序。',
  'instance-running': 'Bridge 已在另一个终端运行。请先在原终端按 Ctrl+C 停止 npm start，再点击启动服务。',
  'account-running': '此微信账号已被另一个 Bridge 占用，请先停止原实例。',
  'ilink-auth-expired': '微信授权已失效，请点击「重新扫码 / 刷新」。',
  'credential-protection': '当前 Windows 用户无法解密保存的凭证。请使用原 Windows 用户运行；详见 docs/operations.md。',
  'dsh-not-installed': '未安装独立 DSH，请先在项目目录执行 npm run dsh:setup。',
  'dsh-start-timeout': '独立 DSH 启动超时，已停止本次启动的 DSH。请检查配置和本地网络后重试。',
  'dsh-exited': '独立 DSH 已退出，Bridge 已收到停止指令。请检查配置后重新启动。',
  'verification-invalid-or-stale': '验证码格式不正确，或该验证已过期。请查看当前提示后重新输入。',
  'login-timeout': '扫码等待超时，请点击「重新扫码 / 刷新」生成新二维码。',
  'qr-expired': '二维码已多次过期，请重新扫码。',
  'launcher-busy': '正在处理服务操作，请稍候。',
};
const loginLabels = { idle: '尚未连接', refreshing: '正在获取二维码', waiting: '等待扫码', scanned: '等待手机确认', verify: '需要验证码', confirming: '正在验证', ready: '已授权' };
const serviceLabels = { stopped: '已停止', starting: '启动中', ready: '运行中', error: '启动异常' };
function showError(code, persist = false) { if (persist) clientError = code; $('error').textContent = errors[code] ?? `操作未完成（${code}），请查阅 docs/operations.md。`; $('error').hidden = false; }
function render(s) {
  const oldVerify = state?.verifyId; state = s;
  $('version').textContent = `v${s.version}`;
  $('dsh-address').textContent = s.baseUrl.replace(/^https?:\/\//, '');
  for (const service of ['dsh', 'bridge']) {
    const el = $(service + '-state'); el.textContent = serviceLabels[s[service]] ?? '未知'; el.className = 'service-state' + (s[service] === 'ready' ? ' active' : s[service] === 'error' ? ' error' : '');
  }
  const badge = $('login-badge'); badge.textContent = loginLabels[s.login] ?? '等待连接'; badge.className = 'badge' + (s.login === 'ready' ? ' active' : '');
  const verify = s.login === 'verify' && s.verifyId;
  const hasQr = s.hasQr && !verify;
  $('qr').hidden = !hasQr; $('placeholder').hidden = Boolean(hasQr || verify); $('verify-form').hidden = !verify;
  if (hasQr && qrRevision !== s.qrRevision) { $('qr').src = '/api/qr.svg?v=' + s.qrRevision; qrRevision = s.qrRevision; }
  if (!hasQr) { $('qr').removeAttribute('src'); qrRevision = -1; }
  if (verify && oldVerify !== s.verifyId) { $('verify-code').value = ''; $('verify-code').focus(); }
  const copy = s.login === 'ready'
    ? ['微信已连接', '现在可以回到微信发送「你好」。', '授权已保存。后续启动会恢复连接，无需重复扫码。']
    : s.login === 'scanned' ? ['请在手机确认', '扫码成功，等待手机微信授权。', '已扫码，请在手机微信中确认授权。']
      : s.dsh === 'starting' ? ['独立 DSH 正在启动', '准备好后会自动连接微信。', '首次启动可能需要一些时间，请稍候。']
        : s.bridge === 'starting' ? ['正在连接微信', '二维码就绪后会自动显示。', '二维码过期会自动更新，请以当前页面为准。']
          : ['准备好后，启动服务', '二维码会显示在这里，无需在终端扫码。', '凭证保存在本机，已授权后启动会自动恢复连接。'];
  $('placeholder-title').textContent = copy[0]; $('placeholder-text').textContent = copy[1];
  $('login-note').textContent = hasQr && s.login !== 'scanned' ? '请用手机微信扫一扫。过期后页面将自动更新二维码。' : copy[2];
  $('start').disabled = s.busy || (s.dsh === 'ready' && ['ready', 'starting'].includes(s.bridge));
  $('start').firstChild.textContent = s.busy ? '正在处理… ' : '启动服务 ';
  $('stop').disabled = !s.busy && s.dsh === 'stopped' && s.bridge === 'stopped';
  $('relogin').disabled = s.busy || s.dsh !== 'ready'; $('open-dsh').disabled = s.dsh !== 'ready' || s.busy;
  $('connection').textContent = '控制台已连接';
  $('quit').disabled = false;
  $('verify-form').querySelector('button').disabled = false;
  $('error').hidden = !(s.error || clientError); if (s.error || clientError) showError(s.error || clientError);
  $('logs').replaceChildren();
  if (!s.logs.length) { const p = document.createElement('p'); p.className = 'empty-log'; p.textContent = '尚无运行记录。启动服务后将在这里显示状态。'; $('logs').append(p); }
  for (const log of [...s.logs].reverse()) {
    const row = document.createElement('div'); row.className = 'log-row';
    for (const [cls, text] of [['log-time', log.time], ['log-event', log.event + (log.code ? ' · ' + log.code : '')]]) { const span = document.createElement('span'); span.className = cls; span.textContent = text; row.append(span); }
    $('logs').append(row);
  }
}
async function post(path, body) {
  if (!state?.csrf) throw Error('console-disconnected');
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw Error(data.error ?? 'request-failed');
}
async function poll() {
  try { const res = await fetch('/api/state', { cache: 'no-store' }); if (!res.ok) throw Error(); const s = await res.json(); offline = false; if (!sending) render(s); }
  catch { offline = true; $('connection').textContent = '控制台已断开，请重新打开启动器'; document.querySelectorAll('button').forEach(b => b.disabled = true); $('qr').hidden = true; $('qr').removeAttribute('src'); }
  setTimeout(poll, offline ? 3000 : 900);
}
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  button.disabled = true; sending = true;
  try { await post('/api/action', { action: button.dataset.action }); clientError = null; }
  catch (e) { showError(e.message, true); }
  finally { sending = false; }
}));
$('verify-form').addEventListener('submit', async e => {
  e.preventDefault(); sending = true;
  const button = $('verify-form').querySelector('button'); button.disabled = true;
  try { await post('/api/verify', { id: state.verifyId, code: $('verify-code').value.trim() }); $('verify-code').value = ''; clientError = null; }
  catch (err) { showError(err.message, true); }
  finally { sending = false; button.disabled = false; }
});
$('quit').addEventListener('click', async () => {
  try { await post('/api/quit', {}); $('connection').textContent = '启动器正在退出，所管理的服务将停止。'; }
  catch (e) { showError(e.message, true); }
});
poll();
