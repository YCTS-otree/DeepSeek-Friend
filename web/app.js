const $ = id => document.getElementById(id);
let state; let qqQrRevision = -1; let qrRevision = -1; let offline = false; let sending = false; let clientError = null;
const errors = {
  'dsf-maintenance-busy': '正在归档或恢复，请等待本次操作完成。',
  'dsf-confirmation-too-early': '本次确认尚未满 3 秒，请继续等待。',
  'dsf-confirmation-stale': '确认已过期或已被使用，请重新选择备份开始确认。',
  'dsf-confirmation-target-changed': '备份文件已发生变化，回滚已停止，请重新校验。',
  'dsf-app-version-mismatch': '备份版本与当前程序不一致，请先使用对应 Release，不能强行跨版本回滚。',
  'dsf-component-migration-required': '所选组件需要迁移，或上下文与桥接状态没有成组选择。请查看组件兼容报告并调整选择。',
  'dsf-component-selection-invalid': '请选择至少一个可恢复组件。',
  'dsf-verification-failed': '备份完整性校验失败，不能用于回滚。',
  'dsf-operation-failed': '归档或恢复失败，已停止操作。请检查状态，不要盲目重复回滚。',
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
  'session-busy': '当前仍有任务、审批或待发送消息。请先等其结束；结果不明的任务需在本机核对后处理。',
  'session-active-archive': '先新建或切换到其他会话，当前会话才会归档。',
  'session-result-unknown': '会话操作结果暂未确认，请刷新列表核对，避免重复新建。',
  'bridge-not-ready': '请先启动服务，再发送测试消息或唤醒她。',
  'test-worker-busy': '测试空间正在整理记忆，请等这次后台任务结束再清空。',
  'test-clear-dsh-running': 'DSH 正在单独运行。请由此启动器启动 Bridge 后清空，或先停止独立 DSH，以保证测试任务已停止。',
  'test-session-required': '这项操作仅适用于独立测试会话。',
  'session-not-current': '请先切换到这个会话，再发送测试消息或唤醒。',
  'runtime-settings-invalid': '请检查单次输出上限、思考档位和间隔；运行没有累计预算上限。',
  'interaction-disabled': '此配置关闭了交互扩展。请启用 interaction.enabled 并重启独立 DSH/Bridge。',
  'qq-gateway-not-installed': '尚未安装 QQ Bot，请在项目目录执行 npm run qq:setup。',
  'qq-gateway-port-in-use': 'QQ Bot 端口已有服务使用。请先停止原实例，启动器不会接管其他服务。',
  'qq-gateway-account-in-use': '机器人 QQ 已在桌面客户端登录，网关无法重复登录。请退出该机器人账号的桌面 QQ，再刷新二维码；其他 QQ 账号无需退出。',
  'qq-gateway-onebot-config': 'QQ 已登录，但 OneBot 通道配置尚未成功，正在重试。',
  'qq-gateway-quick-login-save': 'QQ 已登录；自动登录信息暂未保存，本次消息连接仍可继续。',
};
const loginLabels = { idle: '尚未连接', refreshing: '正在获取二维码', waiting: '等待扫码', scanned: '等待手机确认', verify: '需要验证码', confirming: '正在验证', ready: '已授权' };
const serviceLabels = { stopped: '已停止', starting: '启动中', ready: '运行中', error: '启动异常' };
function showError(code, persist = false) { if (persist) clientError = code; $('error').textContent = errors[code] ?? `操作未完成（${code}），请查阅 docs/operations.md。`; $('error').hidden = false; }
function render(s) {
  const oldVerify = state?.verifyId; state = s;
  const qqLabels = {waiting_qrcode:'等待手机 QQ 扫码',generating_qrcode:'正在生成 QQ 二维码',qrcode_scanned:'已扫码，请在手机确认',account_in_use:'机器人账号正在其他桌面 QQ 登录',initializing:'正在初始化 QQ',ready:'QQ 已登录',offline:'QQ 已离线',reconnecting:'QQ 正在重连',starting:'QQ Bot 启动中',idle:'QQ Bot 尚未启动',error:'QQ Bot 启动异常'};
  const qqPhase = s.qqLogin;
  $('qq-login-status').textContent = (qqLabels[qqPhase] ?? 'QQ Bot 尚未启动') + (s.qqAccount ? ' · QQ ' + s.qqAccount : '') + (s.qqError ? ' · ' + (errors[s.qqError] ?? s.qqError) : '');
  $('qq-error-detail').textContent = s.qqErrorDetail ?? ''; $('qq-error-detail').hidden = !s.qqErrorDetail;
  $('qq-login-badge').textContent = qqPhase === 'ready' ? '已登录' : qqPhase === 'account_in_use' ? '账号占用' : ['qrcode_scanned','initializing'].includes(qqPhase) ? '等待登录' : s.qqGateway === 'ready' ? '等待扫码' : '尚未启动';
  $('qq-login-badge').className = 'badge' + (qqPhase === 'ready' ? ' active' : '');
  const qqHasQr = s.qqHasQr && !['ready','account_in_use'].includes(qqPhase);
  $('qq-placeholder').hidden = Boolean(qqHasQr);
  $('qq-placeholder-title').textContent = qqPhase === 'ready' ? 'QQ 已连接' : qqPhase === 'account_in_use' ? '请先退出机器人账号的桌面 QQ' : qqPhase === 'qrcode_scanned' ? '等待手机确认' : qqPhase === 'initializing' ? 'QQ 正在初始化' : '用手机 QQ 扫码';
  $('qq-placeholder-text').textContent = qqPhase === 'ready' ? '授权成功，消息通道自动连接。' : qqPhase === 'account_in_use' ? '退出后点击刷新二维码，其他 QQ 账号无需退出。' : ['qrcode_scanned','initializing'].includes(qqPhase) ? '网页按网关实时状态更新。' : '启动 QQ Bot 后，二维码会显示在这里。';
  $('qq-qr').hidden = !qqHasQr;
  if(qqHasQr && qqQrRevision!==s.qqQrRevision){$('qq-qr').src='/api/qq-qr.svg?v='+s.qqQrRevision;qqQrRevision=s.qqQrRevision;}
  if(!qqHasQr){$('qq-qr').removeAttribute('src');qqQrRevision=-1;}
  $('qq-gateway-start').disabled=s.busy || s.qqGateway==='ready';
  $('qq-gateway-refresh').disabled=s.busy || qqPhase === 'ready' || !['ready','starting'].includes(s.qqGateway);
  $('qq-gateway-stop').disabled=s.busy || !['ready','starting'].includes(s.qqGateway);

  $('version').textContent = `v${s.version}`;
  $('dsh-address').textContent = s.baseUrl.replace(/^https?:\/\//, '');
  for (const service of ['dsh', 'bridge']) {
    const el = $(service + '-state'); el.textContent = serviceLabels[s[service]] ?? '未知'; el.className = 'service-state' + (s[service] === 'ready' ? ' active' : s[service] === 'error' ? ' error' : '');
  }
  const qqBot = $('qq-gateway-state'); qqBot.textContent = s.qqGateway === 'ready' ? qqPhase === 'ready' ? '运行中 · 已登录' : '运行中 · 待登录' : serviceLabels[s.qqGateway] ?? '已停止'; qqBot.className = 'service-state' + (s.qqGateway === 'ready' ? ' active' : s.qqGateway === 'error' ? ' error' : '');
  if (s.bridge !== 'ready' || qqPhase !== 'ready') { $('qq-bridge-state').textContent = s.bridge !== 'ready' ? '等待 Bridge 启动' : '等待 QQ 登录'; $('qq-bridge-state').className = 'service-state'; }
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
  $('start').disabled = s.busy || (s.dsh === 'ready' && ['ready', 'starting'].includes(s.bridge) && ['ready', 'starting'].includes(s.qqGateway));
  $('start').firstChild.textContent = s.busy ? '正在处理… ' : '一键启动全部 ';
  $('stop').disabled = !s.busy && s.dsh === 'stopped' && s.bridge === 'stopped' && ['stopped','error'].includes(s.qqGateway ?? 'stopped');
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
  return data;
}
async function poll() {
  try { const res = await fetch('/api/state', { cache: 'no-store' }); if (!res.ok) throw Error(); const s = await res.json(); offline = false; if (!sending) render(s); }
  catch { offline = true; $('connection').textContent = '控制台已断开，请重新打开启动器'; document.querySelectorAll('button').forEach(b => b.disabled = true); for (const id of ['qr','qq-qr']) { $(id).hidden = true; $(id).removeAttribute('src'); } }
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

let sessions = [], selectedSession = null, historyEntries = [], sessionLoading = false, sessionRefreshAt = 0;
async function sessionRequest(action, args = {}) {
  const result=await post('/api/sessions',{action,args});
  return result.archiveOperation?(await waitArchiveOperation(result.archiveOperation)).value:result;
}
function selectSession(id) {
  if (selectedSession === id) return;
  selectedSession = id; historyEntries = []; renderHistory(); $('older-history').hidden = true;
  thoughtEntries = []; $('thought-records').replaceChildren(); $('older-thoughts').hidden = true;
  promptData = null; $('prompt-content').textContent = '正在读取所选会话…'; void refreshActivePanel();
}
function renderSessions() {
  $('session-list').replaceChildren();
  for (const s of sessions) {
    const b = document.createElement('button'); b.className = 'session-item' + (s.session === selectedSession ? ' selected' : '');
    b.textContent = `${s.kind === 'test' ? '测试 · ' : ''}${s.archived ? '归档' : '当前'} · ${s.title} (${s.messages})`;
    b.addEventListener('click', async () => { selectSession(s.session); renderSessions(); await loadHistory(); });
    $('session-list').append(b);
  }
  const selected = sessions.find(s => s.session === selectedSession);
  $('history-title').textContent = selected ? selected.title : '暂无会话，首次微信消息会建立会话';
  $('switch-session').disabled = !selected?.archived;
  $('test-controls').hidden = selected?.kind !== 'test';
  $('context-note').textContent = selected?.kind === 'test' ? '测试空间 · 不影响微信当前会话' : '微信与 QQ 共用当前正式会话';
  const picker = $('context-session'); picker.replaceChildren();
  for (const s of sessions) { const option = document.createElement('option'); option.value = s.session; option.textContent = (s.kind === 'test' ? '测试 · ' : '') + (s.archived ? '归档 · ' : '当前 · ') + s.title; picker.append(option); }
  picker.value = selectedSession ?? '';
}
function renderHistory() {
  const el = $('chat-history'); el.replaceChildren();
  for (const entry of historyEntries) {
    const row = document.createElement('article'); row.className = 'chat-entry ' + entry.role;
    const head = document.createElement('div'); head.className = 'chat-entry-head';
    const who = entry.role === 'assistant' ? '小鲸鱼' : entry.role === 'bridge' ? '连接提示' : entry.actor.displayName || entry.actor.userId || '用户';
    head.textContent = who + (entry.role === 'user' && entry.actor.channel ? ' · ' + entry.actor.channel + ' / ' + entry.actor.userId + (entry.actor.trustedOwner ? ' · 可信 OTREE' : ' · 未认证为 OTREE') : '') + (entry.actor.qqGroup?' · 群 '+entry.actor.qqGroup.name+' / '+entry.actor.qqGroup.id:'') + ' · ' + new Date(entry.created).toLocaleString();
    const body = document.createElement('p'); body.textContent = entry.text; row.append(head, body); el.append(row);
  }
}
async function loadHistory(older = false) {
  if (!selectedSession) return;
  const id = selectedSession;
  try {
    const data = await sessionRequest('history', { session: id, ...(older && historyEntries.length ? { before: historyEntries[0].n } : {}) });
    if (id !== selectedSession) return;
    const next = older ? [...data.entries, ...historyEntries] : historyEntries.length > 100
      ? [...new Map([...historyEntries, ...data.entries].map(e => [e.n, e])).values()].sort((a, b) => a.n - b.n) : data.entries;
    const changed = JSON.stringify(historyEntries) !== JSON.stringify(next); historyEntries = next;
    if (older || historyEntries.length <= 100) $('older-history').hidden = !data.hasMore;
    if (changed) renderHistory();
  } catch (e) { $('session-status').textContent = errors[e.message] ?? `记录读取失败（${e.message}）`; }
}
async function refreshSessions() {
  if (!state?.csrf || sessionLoading) return;
  sessionLoading = true;
  try {
    const data = await sessionRequest('list'); sessions = data.sessions;
    if (!sessions.some(s => s.session === selectedSession)) selectSession(sessions.find(s => !s.archived && s.kind !== 'test')?.session ?? sessions[0]?.session);
    renderSessions(); await loadHistory(); $('session-status').textContent = '只在这里切换会话。聊天记录是本机持久记录，不代表微信投递已确认。';
    if (!$('room-path').dataset?.loaded) {
      const room = await sessionRequest('room-info'); $('room-path').textContent = room.location;
      if ($('room-path').dataset) $('room-path').dataset.loaded = 'true';
      $('copy-room').disabled = false; $('room-status').textContent = room.exists ? '已创建 · 重启与切换会话后保留' : '首次启动独立 DSH 并加载插件后创建';
    }
  } catch (e) { $('session-status').textContent = errors[e.message] ?? `会话读取失败（${e.message}）`; }
  finally { sessionLoading = false; }
}
$('refresh-sessions').addEventListener('click', refreshSessions);
$('older-history').addEventListener('click', () => loadHistory(true));
$('new-session-form').addEventListener('submit', async e => {
  e.preventDefault(); const button = e.currentTarget.querySelector('button'); button.disabled = true;
  try { const data = await sessionRequest('create', { title: $('session-title').value, kind: $('session-kind').value }); selectSession(data.session); $('session-title').value = ''; await refreshSessions(); }
  catch (err) { $('session-status').textContent = errors[err.message] ?? `操作失败（${err.message}）`; }
  finally { button.disabled = false; }
});
$('switch-session').addEventListener('click', async () => {
  $('switch-session').disabled = true;
  try { await sessionRequest('switch', { session: selectedSession }); await refreshSessions(); }
  catch (e) { $('session-status').textContent = errors[e.message] ?? `切换失败（${e.message}）`; }
});
setInterval(() => { if (!offline && Date.now() - sessionRefreshAt > 5000) { sessionRefreshAt = Date.now(); void refreshSessions(); } }, 1000);
$('copy-room').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('room-path').textContent); $('room-status').textContent = '地址已复制'; }
  catch { $('room-status').textContent = '请手动选择上方地址复制'; }
});

let currentPage = 'overview', settingsDirty = false, promptData = null, thoughtEntries = [], panelLoading = false;
function failNotice(id, e) { $(id).textContent = errors[e.message] ?? `操作未完成（${e.message}）`; }
function route() {
  const name = typeof location === 'undefined' ? 'overview' : location.hash.slice(1);
  currentPage = ['overview', 'sessions', 'controls', 'thoughts', 'identity', 'channels', 'internet', 'archives'].includes(name) ? name : 'overview';
  const titles = { channels: ['连接不同渠道，记住是谁。', '微信和 QQ 共用会话；备注与可信账号分开。'], internet: ['先过滤，再判断。', '互联网仅供操作者测试，默认关闭且不对 Agent 展示。'], archives: ['给连续的历史，留一份归档。', '校验、保存，以及出问题时的可控回滚。'], overview: ['微信与 QQ，一起连接她。', '一键启动服务，分别用手机微信和 QQ 扫码授权。'], sessions: ['每段相遇，都有记录。', '正式会话归档保留；测试会话独立运行，可以清空。'], controls: ['给她自由，也保留掌控。', '切换思考深度，允许持续运行，或随时暂停与唤醒。'], thoughts: ['思考、安静和下一次醒来。', '查看本机私有记录，以及她为自己设置的小闹钟。'], identity: ['她的自我，和她的小房间。', '查看真实 Prompt 装配、历史 SYS 备份和持久空间。'] };
  $('intro-title').textContent = titles[currentPage][0]; $('intro-description').textContent = titles[currentPage][1];
  for (const el of document.querySelectorAll('[data-page]')) el.hidden = el.dataset.page !== currentPage;
  for (const link of document.querySelectorAll('.console-nav a')) { const active = link.getAttribute('href') === '#' + currentPage; link.setAttribute('aria-current', active ? 'page' : 'false'); }
  void refreshActivePanel();
}
async function loadRuntime() {
  const data = await sessionRequest('runtime-status');
  if (!settingsDirty) { $('reasoning').value = data.settings.reasoningEffort; $('max-tokens').value = data.settings.maxTokens;
    $('continue-delay').value = data.settings.continueDelayMs; $('continuous').checked = data.settings.continuous; $('paused').checked = data.settings.paused; }
  $('runtime-jobs').textContent = JSON.stringify({ model: data.settings.name, paused: data.settings.paused, tasks: data.jobs, contexts: data.contexts, deliveries: data.deliveries }, null, 2);
}
function showPrompt() {
  if (!promptData) return;
  const name = $('prompt-source').value || 'core', value = promptData[name];
  $('prompt-content').textContent = name === 'assembled' ? value?.text ?? '该会话尚未记录实际装配。运行一次后可查看。'
    : typeof value === 'string' ? value : value ? JSON.stringify(value, null, 2) : '尚未初始化 Self Model；首次执行时载入 v0.1.0。';
}
async function loadPrompts() {
  const id = selectedSession, data = await sessionRequest('prompts', { session: id }); if (id !== selectedSession) return;
  promptData = data; showPrompt();
  const room = await sessionRequest('room-info'); $('room-path').textContent = room.location; $('copy-room').disabled = false;
  $('room-status').textContent = room.exists ? '已创建 · 重启与切换会话后保留' : '首次启动并加载认知插件后创建';
}
async function loadThoughts(older = false) {
  if (!selectedSession) { $('thought-records').textContent = '请选择要查看的会话。'; return; }
  const id = selectedSession, data = await sessionRequest('thoughts', { session: id, ...(older && thoughtEntries.length ? { before: thoughtEntries[0].n } : {}) });
  if (id !== selectedSession) return;
  const next = older ? [...data.entries, ...thoughtEntries] : thoughtEntries.length > 30 ? [...new Map([...thoughtEntries, ...data.entries].map(e => [e.n, e])).values()].sort((a, b) => a.n - b.n) : data.entries;
  if (JSON.stringify(next) !== JSON.stringify(thoughtEntries)) {
    thoughtEntries = next; $('thought-records').replaceChildren();
    for (const entry of thoughtEntries) { const article = document.createElement('article'); article.className = 'thought-entry';
      const title = document.createElement('strong'); title.textContent = ({ reasoning: '思考', note: '私有笔记', usage: '本次用量' }[entry.kind] ?? entry.kind) + ' · ' + new Date(entry.created).toLocaleString();
      const pre = document.createElement('pre'); pre.className = 'record-view'; pre.textContent = entry.text; article.append(title, pre); $('thought-records').append(article); }
  }
  if (older || thoughtEntries.length <= 30) $('older-thoughts').hidden = !data.hasMore;
}
async function loadAlarms() {
  $('alarm-records').replaceChildren(); if (!selectedSession) return;
  const id = selectedSession, data = await sessionRequest('alarms', { session: id }); if (id !== selectedSession) return;
  for (const a of data.alarms) { const row = document.createElement('div'); row.className = 'alarm-row'; const label = document.createElement('span');
    label.textContent = new Date(a.due).toLocaleString() + ' · ' + ({ scheduled: '等待响铃', fired: '已唤醒', cancelled: '已取消' }[a.state] ?? a.state) + (a.note ? ' · ' + a.note : ''); row.append(label);
    if (a.state === 'scheduled') { const button = document.createElement('button'); button.className = 'text-button'; button.textContent = '取消'; button.addEventListener('click', async () => { try { await sessionRequest('alarm-cancel', { session: a.session, id: a.id }); await loadAlarms(); } catch (e) { failNotice('mind-notice', e); } }); row.append(button); }
    $('alarm-records').append(row); }
}
async function refreshActivePanel() {
  if (!state?.csrf || panelLoading) return; panelLoading = true;
  try { if (currentPage === 'overview' && state.bridge === 'ready') await loadChannelStatus(); if (currentPage === 'controls') await loadRuntime(); if (currentPage === 'thoughts') { await loadThoughts(); await loadAlarms(); } if (currentPage === 'identity') await loadPrompts(); if (['channels','internet'].includes(currentPage)) await loadChannels(); if (currentPage === 'archives') await loadArchives(); }
  catch (e) { failNotice(['channels','internet','archives'].includes(currentPage) ? currentPage === 'channels' ? 'channels-notice' : currentPage === 'archives' ? 'archive-notice' : 'internet-notice' : currentPage === 'identity' ? 'prompt-notice' : currentPage === 'thoughts' ? 'mind-notice' : 'runtime-notice', e); }
  finally { panelLoading = false; }
}
$('context-session').addEventListener('change', async () => { selectSession($('context-session').value); renderSessions(); await loadHistory(); });
$('settings-form').addEventListener('input', () => { settingsDirty = true; });
$('settings-form').addEventListener('submit', async e => { e.preventDefault(); try { await sessionRequest('runtime-configure', { reasoningEffort: $('reasoning').value, maxTokens: Number($('max-tokens').value), continueDelayMs: Number($('continue-delay').value), continuous: $('continuous').checked, paused: $('paused').checked }); settingsDirty = false; $('runtime-notice').textContent = '已保存，下一次模型请求即生效。'; await loadRuntime(); } catch (err) { failNotice('runtime-notice', err); } });
$('stop-thinking').addEventListener('click', async () => { try { if (!selectedSession) throw Error('session-not-current'); await sessionRequest('runtime-stop', { session: selectedSession }); $('runtime-notice').textContent = '已请求停止，原上下文和记录保留。'; await loadRuntime(); } catch (e) { failNotice('runtime-notice', e); } });
$('wake-thinking').addEventListener('click', async () => { try { if (!selectedSession) throw Error('session-not-current'); await sessionRequest('runtime-configure', { paused: false }); await sessionRequest('runtime-wake', { session: selectedSession }); settingsDirty = false; $('runtime-notice').textContent = '已恢复并排队唤醒所选会话。'; await loadRuntime(); } catch (e) { failNotice('runtime-notice', e); } });
$('test-chat-form').addEventListener('submit', async e => { e.preventDefault(); try { await sessionRequest('test-send', { session: selectedSession, text: $('test-text').value }); $('test-text').value = ''; await refreshSessions(); } catch (err) { failNotice('session-status', err); } });
$('clear-tests').addEventListener('click', async () => { if (!confirm('清空全部测试会话、测试思考及测试记忆？正式会话和正式记忆保持保留。DSH 原始日志不会在此物理删除。')) return;
  try { const result = await sessionRequest('test-clear', { confirm: true }); selectedSession = null; historyEntries = []; thoughtEntries = []; renderHistory(); await refreshSessions(); $('session-status').textContent = result.upstream; } catch (e) { failNotice('session-status', e); } });
$('refresh-prompts').addEventListener('click', () => refreshActivePanel()); $('prompt-source').addEventListener('change', showPrompt);
$('refresh-thoughts').addEventListener('click', () => refreshActivePanel()); $('older-thoughts').addEventListener('click', () => { void loadThoughts(true).catch(e => failNotice('mind-notice', e)); });
$('alarm-form').addEventListener('submit', async e => { e.preventDefault(); try { await sessionRequest('alarm-create', { session: selectedSession, at: new Date($('alarm-at').value).toISOString(), note: $('alarm-note').value }); $('alarm-note').value = ''; $('mind-notice').textContent = '闹钟已保存。'; await loadAlarms(); } catch (err) { failNotice('mind-notice', err); } });
if (typeof window !== 'undefined') { window.addEventListener('hashchange', route); route(); }
setInterval(() => { if (!offline) void refreshActivePanel(); }, 5000);

let channelDirty = false;
async function loadChannelStatus() {
  const data = await sessionRequest('channels-status');
  const labels = {connected:'已连接',disabled:'未启用',connecting:'正在连接',disconnected:'连接中断',error:'连接异常'};
  $('qq-bridge-state').textContent = state?.bridge !== 'ready' ? '等待 Bridge 启动' : data.qq.state === 'disabled' && state?.qqLogin !== 'ready' ? '等待 QQ 登录' : labels[data.qq.state] ?? data.qq.state;
  $('qq-bridge-state').className = 'service-state' + (data.qq.state === 'connected' ? ' active' : data.qq.state === 'error' ? ' error' : '');
  $('qq-status').textContent = '状态：' + data.qq.state + ' · 账号：' + (data.qq.account ?? '未连接') + ' · 好友：' + (data.qq.friends ?? 0) + ' · ' + (data.qq.tokenSaved ? 'Token 已安全保存' : '尚未保存 Token') + (data.qq.error ? ' · ' + data.qq.error : '');
  return data;
}
async function loadChannels() {
  const data = await loadChannelStatus();
  await loadQQGroups();
  if (!channelDirty) { $('qq-url').value = data.qq.settings.url; $('qq-enabled').checked = data.qq.settings.enabled; $('internet-enabled').checked = data.internet.enabled; $('internet-hosts').value = data.internet.allowedHosts.join(', '); }
  const contacts = await sessionRequest('contacts-list'); $('contacts-list').replaceChildren();
  for (const c of contacts.entries) { const row = document.createElement('div'); row.className = 'alarm-row'; const text = document.createElement('span'); text.textContent = c.channel + ' · ' + c.peer + ' · ' + c.alias + (c.trustedOwner ? ' · 代码核验为 OTREE' : ' · 备注不代表认证'); const edit = document.createElement('button'); edit.className = 'text-button'; edit.textContent = '编辑'; edit.addEventListener('click', () => { $('contact-channel').value = c.channel; $('contact-peer').value = c.peer; $('contact-alias').value = c.alias; $('contact-notes').value = c.notes; }); row.append(text, edit); $('contacts-list').append(row); }
}
async function loadQQGroups(refresh=false) {
  const data=await sessionRequest('qq-groups-list',{refresh});
  $('qq-groups-list').replaceChildren();
  for(const group of data.groups){
    const row=document.createElement('div');row.className='alarm-row';
    const label=document.createElement('span');label.textContent=group.name+' · '+group.id+(group.members===null?'':' · '+group.members+' 人')+' · '+(group.enabled?'已启用':'已停用');
    const toggle=document.createElement('button');toggle.type='button';toggle.className='text-button';toggle.textContent=group.enabled?'停用':'启用';toggle.disabled=!data.connected;
    toggle.addEventListener('click',async()=>{toggle.disabled=true;try{await sessionRequest('qq-group-configure',{groupId:group.id,enabled:!group.enabled});$('qq-groups-notice').textContent=group.name+(group.enabled?' 已停用，聊天历史保留。':' 已启用，新消息进入当前会话。');await loadQQGroups();}catch(e){failNotice('qq-groups-notice',e);toggle.disabled=!data.connected;}});
    row.append(label,toggle);$('qq-groups-list').append(row);
  }
  if(!data.connected)$('qq-groups-notice').textContent='QQ 未连接，显示上次群列表；连接后可修改。';
  else if(!data.groups.length)$('qq-groups-notice').textContent='尚未加入群聊；加入后刷新列表。';
}
$('qq-groups-refresh').addEventListener('click',()=>{void loadQQGroups(true).catch(e=>failNotice('qq-groups-notice',e));});
for (const id of ['qq-form','internet-form']) $(id).addEventListener('input', () => { channelDirty = true; });
$('qq-form').addEventListener('submit', async e => { e.preventDefault(); try { await sessionRequest('qq-configure', { enabled: $('qq-enabled').checked, url: $('qq-url').value, ...($('qq-token').value ? { token: $('qq-token').value } : {}) }); $('qq-token').value = ''; channelDirty = false; $('channels-notice').textContent = '已保存；服务运行时自动连接。'; await loadChannels(); } catch (err) { failNotice('channels-notice', err); } });
$('contacts-form').addEventListener('submit', async e => { e.preventDefault(); try { await sessionRequest('contacts-edit', { channel: $('contact-channel').value, peer: $('contact-peer').value, alias: $('contact-alias').value, notes: $('contact-notes').value }); $('channels-notice').textContent = '备注已保存，后续消息按真实账号匹配。'; await loadChannels(); } catch (err) { failNotice('channels-notice', err); } });
$('internet-form').addEventListener('submit', async e => { e.preventDefault(); try { await sessionRequest('internet-configure', { enabled: $('internet-enabled').checked, allowedHosts: $('internet-hosts').value.split(',').map(x => x.trim()).filter(Boolean) }); channelDirty = false; $('internet-notice').textContent = '边界已保存，Agent 仍没有互联网接口。'; await loadChannels(); } catch (err) { failNotice('internet-notice', err); } });
$('internet-preview-form').addEventListener('submit', async e => { e.preventDefault(); $('internet-result').textContent = ''; try { const data = await sessionRequest('internet-preview', { url: $('internet-url').value }); $('internet-result').textContent = data.text; $('internet-notice').textContent = data.warning + ' 移除 ' + data.removedLines + ' 行。'; } catch (err) { failNotice('internet-notice', err); } });
let archivePlan=null,archiveReadyAt=0,archiveConfirmPending=false;
let archiveComponentInputs=[],archiveSelectionName=null;
async function openArchiveComponents(name){
  if(archivePlan){await archiveRequest('restore-cancel',{id:archivePlan.id});archivePlan=null;$('archive-confirmation').hidden=true;}
  const info=await archiveRequest('restore-options',{name});archiveSelectionName=name;archiveComponentInputs=[];
  $('archive-components').replaceChildren();$('archive-component-selection').hidden=false;
  $('archive-component-name').textContent=name+' · 创建程序 '+info.appVersion+'（仅作来源记录）';
  const rows=info.compatibility.components,pair=['dsh_context','bridge_state'],pairReady=pair.every(id=>rows.some(r=>r.id===id&&r.canRestore));
  for(const row of rows){
    const label=document.createElement('label');label.className='check archive-component';const box=document.createElement('input');box.type='checkbox';box.value=row.id;
    box.disabled=!row.canRestore||(pair.includes(row.id)&&!pairReady);box.checked=!box.disabled;
    const text=document.createElement('span');text.textContent=row.label+' · '+row.source.format+'/'+row.source.version+' → '+row.target.format+'/'+row.target.version+' · '+(row.status==='compatible'?'兼容':row.canRestore?'恢复时迁移：'+row.migrations.map(m=>m==='legacy-v1-component-metadata'?'旧版组件格式识别':m).join(' → '):row.reason||'需要迁移器，暂未提供');
    if(box.disabled&&row.canRestore)text.textContent+='；依赖的上下文/桥接组件暂不可恢复';
    const entry={box,row};archiveComponentInputs.push(entry);
    box.addEventListener('change',()=>{if(['dsh_context','bridge_state'].includes(row.id))for(const peer of archiveComponentInputs)if(['dsh_context','bridge_state'].includes(peer.row.id)&&!peer.box.disabled)peer.box.checked=box.checked;});
    label.append(box,text);$('archive-components').append(label);
  }
}
function archiveAge(value,now=Date.now()){
  const stamp=Date.parse(value);if(!Number.isFinite(stamp))return '时间未知';
  const minutes=Math.floor(Math.max(0,now-stamp)/60000);if(minutes<1)return '刚刚';
  const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
  return days?days+'天'+(hours?hours+'小时':'')+'前':hours?hours+'小时'+(minutes%60?minutes%60+'分钟':'')+'前':minutes+'分钟前';
}
const archiveRequest=(action,args={})=>post('/api/archives',{action,args});
async function waitArchiveOperation(id){
  for(;;){const op=await archiveRequest('status',{id});$('archive-operation').textContent=op.progress+(op.result?.archive?' · '+op.result.archive:'')+(op.result?.beforeArchive?' · 回滚前归档：'+op.result.beforeArchive:'');
    if(op.state==='done')return op.result;
    if(op.state==='failed'){if(op.result?.restored)$('archive-operation').textContent+=' · 数据已恢复，请检查服务启动状态。';throw Error(op.error);}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
}
function archiveCountdown(){
  if(!archivePlan)return;
  const remaining=Math.max(0,archiveReadyAt-Date.now());$('archive-confirm').disabled=archiveConfirmPending||remaining>0;
  $('archive-confirm').textContent='确认回滚（'+archivePlan.step+'/3）'+(remaining?' · 请等待 '+Math.ceil(remaining/1000)+' 秒':'');
}
function showArchivePlan(plan){
  archivePlan=plan;archiveReadyAt=Date.now()+Math.max(3000,plan.waitMs);archiveConfirmPending=false;
  $('archive-confirmation').hidden=false;$('archive-confirm-title').textContent='回滚确认 '+plan.step+' / 3';
  const warnings=['第一次确认：仅替换所选组件，未选内容保持。请核对目标与恢复范围。','第二次确认：服务将暂停，所选组件在归档之后的变化会从当前状态移走。请再次确认时间点和迁移步骤。','第三次确认：执行前必须先保存并校验当前状态的 DSF；保存失败立即停止。确认后开始实际回滚。'];
  $('archive-confirm-warning').textContent=plan.name+(plan.createdAt?'\n归档时间：'+new Date(plan.createdAt).toLocaleString():'')+'\n恢复范围：'+(plan.componentLabels??plan.components??[]).join('、')+'\n迁移：'+((plan.migrations??[]).join('、')||'无需迁移')+'\n'+warnings[plan.step-1];archiveCountdown();
}
async function loadArchives() {
  const data=await archiveRequest('list');$('archive-list').replaceChildren();$('archive-trash').replaceChildren();
  function button(label,handler){const b=document.createElement('button');b.type='button';b.className='text-button';b.textContent=label;b.addEventListener('click',async()=>{b.disabled=true;try{await handler();}catch(e){failNotice('archive-notice',e);}finally{b.disabled=false;}});return b;}
  for(const [key,target] of [['files','archive-list'],['trash','archive-trash']])for(const file of data[key]){
    const row=document.createElement('div');row.className='archive-entry';const title=document.createElement('p');title.className='chat-note';title.textContent=(file.label?file.label+' · ':'')+file.name+' · '+Math.ceil(file.bytes/1024)+' KB · '+archiveAge(file.createdAt)+'（'+new Date(file.createdAt).toLocaleString()+'） · '+(file.invalid?'文件损坏或格式异常':file.appVersion+' · '+file.reason+(file.compatible?' · 全部组件兼容':' · 可按组件选择/迁移'));
    const actions=document.createElement('div');actions.className='archive-actions';row.append(title,actions);
    if(key==='trash')actions.append(button('还原备份',async()=>{await archiveRequest('untrash',{name:file.name});await loadArchives();}));
    else{
      const download=document.createElement('a');download.className='text-button';download.textContent='下载';download.href='/api/archive-download?name='+encodeURIComponent(file.name);download.download=file.name;
      const restore=button('选择组件回滚',async()=>openArchiveComponents(file.name));restore.disabled=!(file.selectable??file.compatible)||file.invalid;
      actions.append(download,button('完整校验',async()=>{$('archive-inspection').textContent=JSON.stringify(await archiveRequest('inspect',{name:file.name}),null,2);}),button('备注',async()=>{$('archive-label-name').value=file.name;$('archive-label').value=file.label??'';$('archive-label-form').hidden=false;}),restore,button('移入回收站',async()=>{await archiveRequest('trash',{name:file.name});if(archivePlan?.name===file.name){archivePlan=null;$('archive-confirmation').hidden=true;}await loadArchives();}));
    }
    $(target).append(row);
  }
  $('archive-notice').textContent=data.location+(data.files.length?'':' · 暂无归档');
  if(data.compressing)$('archive-operation').textContent='空闲单线程压缩：'+data.compressing;
  else if(data.operation)$('archive-operation').textContent=data.operation.progress+(data.operation.error?' · '+data.operation.error:'')+(data.operation.result?.beforeArchive?' · 回滚前归档：'+data.operation.result.beforeArchive:'');
}
setInterval(archiveCountdown,100);
$('archive-create').addEventListener('click',async()=>{$('archive-create').disabled=true;try{const op=await archiveRequest('create');await waitArchiveOperation(op.archiveOperation);await loadArchives();}catch(e){failNotice('archive-notice',e);}finally{$('archive-create').disabled=false;}});
$('archive-confirm').addEventListener('click',async()=>{
  if(!archivePlan||archiveConfirmPending||Date.now()<archiveReadyAt)return;archiveConfirmPending=true;archiveCountdown();
  try{const result=await archiveRequest('restore-confirm',archivePlan);if(result.archiveOperation){archivePlan=null;$('archive-confirmation').hidden=true;await waitArchiveOperation(result.archiveOperation);await loadArchives();}else showArchivePlan(result);}
  catch(e){archiveConfirmPending=false;archiveReadyAt=Date.now()+3000;archiveCountdown();failNotice('archive-notice',e);}
});
$('archive-cancel').addEventListener('click',async()=>{if(!archivePlan||archiveConfirmPending)return;try{await archiveRequest('restore-cancel',{id:archivePlan.id});archivePlan=null;$('archive-confirmation').hidden=true;}catch(e){failNotice('archive-notice',e);}});
$('archive-components-confirm').addEventListener('click',async()=>{try{const components=archiveComponentInputs.filter(v=>v.box.checked&&!v.box.disabled).map(v=>v.row.id);const plan=await archiveRequest('restore-begin',{name:archiveSelectionName,components});$('archive-component-selection').hidden=true;showArchivePlan(plan);}catch(e){failNotice('archive-notice',e);}});
$('archive-components-cancel').addEventListener('click',()=>{$('archive-component-selection').hidden=true;archiveSelectionName=null;archiveComponentInputs=[];});
$('archive-label-form').addEventListener('submit',async e=>{e.preventDefault();try{await archiveRequest('label',{name:$('archive-label-name').value,label:$('archive-label').value});$('archive-label-form').hidden=true;await loadArchives();}catch(err){failNotice('archive-notice',err);}});
$('refresh-archives').addEventListener('click', () => { void loadArchives().catch(e => failNotice('archive-notice', e)); });
