import { BridgeError, sleep, backoff } from './util.js';

// UI callbacks keep login testable; QR contents and verification codes never enter logs.
export async function login(client, { display, verify, notice = () => {}, status = () => {}, existing = null, signal, timeoutMs = 480_000 }) {
  const initial = client.config.apiBaseUrl; let base = initial; let qr; let code; let refreshes = 0; let failures = 0;
  const deadline = Date.now() + timeoutMs;
  async function refresh() {
    if (++refreshes > 4) throw new BridgeError('qr-expired', '二维码多次失效，请稍后重新登录');
    status('refreshing'); base = initial; code = undefined;
    qr = await client.request('ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: existing?.botToken ? [existing.botToken] : [] }, signal, { baseUrl: initial, auth: false, baseInfo: false });
    if (typeof qr.qrcode !== 'string' || !qr.qrcode || qr.qrcode.length > 4096
      || typeof qr.qrcode_img_content !== 'string' || !qr.qrcode_img_content || qr.qrcode_img_content.length > 4096
      || /[\x00-\x1f\x7f]/.test(qr.qrcode_img_content)) throw new BridgeError('qr-invalid');
    await display(qr.qrcode_img_content);
    status('waiting');
  }
  await refresh();
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let result;
    try {
      result = await client.request(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}${code ? '&verify_code=' + encodeURIComponent(code) : ''}`, undefined, signal,
        { baseUrl: base, timeout: 35_000, auth: false }); failures = 0;
    } catch (e) {
      if (!e.retryable || signal?.aborted) throw e;
      await sleep(backoff(failures++), signal); continue;
    }
    switch (result.status) {
      case 'confirmed':
        status('confirming');
        if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) throw new BridgeError('login-identity-missing', '服务端未返回完整账号和扫码用户身份，拒绝开放访问');
        client.validateHost(result.baseurl ?? base);
        return { botToken: result.bot_token, accountId: result.ilink_bot_id, ownerId: result.ilink_user_id, baseUrl: result.baseurl ?? base };
      case 'need_verifycode': status('verify'); code = await verify(signal); status('confirming'); break;
      case 'scaned': code = undefined; status('scanned'); notice('已扫码，请在手机确认'); break;
      case 'expired': case 'verify_code_blocked': notice('二维码失效或验证码被限制，正在刷新'); await refresh(); break;
      case 'scaned_but_redirect':
        if (!result.redirect_host) throw new BridgeError('login-redirect-missing');
        base = client.validateHost('https://' + result.redirect_host); break;
      case 'binded_redirect':
        if (existing?.botToken && existing?.accountId) return existing;
        throw new BridgeError('already-bound-no-credentials', '已绑定但本地无凭证，请在微信解除绑定后重试');
      case 'wait': break;
      default: throw new BridgeError('login-status-unknown');
    }
    await sleep(1000, signal);
  }
  throw new BridgeError('login-timeout', '扫码登录超时');
}
