import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { BridgeError, sleep, backoff } from './util.js';
import { loadCredentials } from './security.js';
import { qqId } from './contacts.js';
import { forwardId } from './qq-forward.js';
import { gatewayErrorDetail } from './qq-gateway.js';
import { clean } from './cognitive/store.js';

export function qqSettings(value = {}) {
  if (Object.keys(value).some(k => !['enabled','url'].includes(k))) throw new BridgeError('qq-config-invalid');
  const c = { enabled: false, url: 'ws://127.0.0.1:3001', ...value };
  let u; try { u = new URL(c.url); } catch { throw new BridgeError('qq-config-invalid'); }
  if (typeof c.enabled !== 'boolean' || u.protocol !== 'ws:' || !['127.0.0.1','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new BridgeError('qq-config-invalid');
  return c;
}
export class QQChannel {
  constructor(config, runtime, store, signal, { credentials = () => loadCredentials(config.dataDir, 'qq-connection.json') } = {}) {
    Object.assign(this, { config, runtime, store, signal, credentials }); this.pending = new Map(); this.friends = new Set(); this.groups = new Map(); this.state = 'disabled'; this.account = null;
  }
  settings() { return qqSettings(this.runtime.channelSettings('qq', this.config.qq)); }
  status() { return { settings: this.settings(), state: this.state, account: this.account, friends: this.friends.size, error: this.error ?? null, tokenSaved: Boolean(this.credentials()?.token) }; }
  groupList() { return [...this.groups.values()].map(g=>({...g,enabled:this.groupEnabled(g.id)})); }
  groupEnabled(id) { return this.groups.has(id) && (this.runtime.channelSettings('qq-groups').allowed??[]).includes(id); }
  allowed(account, user) { return this.settings().enabled && account === this.account && (user.startsWith('group:')?this.groupEnabled(user.slice(6)):this.friends.has(user)); }
  async rpc(action, params = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new BridgeError('qq-disconnected', '', { retryable: true });
    const echo = randomUUID(), ambiguous = ['send_private_msg','send_group_msg','add_custom_face'].includes(action);
    return new Promise((resolve, reject) => {
      const fail = (code,detail) => reject(Object.assign(new BridgeError(code), { ambiguous, retryable: !ambiguous, detail }));
      const timer = setTimeout(() => { this.pending.delete(echo); fail('qq-timeout'); }, 6000);
      this.pending.set(echo, { resolve, reject: fail, timer });
      this.ws.send(JSON.stringify({ action, params, echo }), err => { if (err) { clearTimeout(timer); this.pending.delete(echo); fail('qq-disconnected'); } });
    });
  }
  frame(raw) {
    let e; try { e = JSON.parse(raw); } catch { return; }
    if (e.echo && this.pending.has(e.echo)) {
      const p = this.pending.get(e.echo); this.pending.delete(e.echo); clearTimeout(p.timer);
      if (e.status === 'ok' && e.retcode === 0) p.resolve(e.data); else p.reject('qq-action-rejected',gatewayErrorDetail(e.message??e.wording??''));
      return;
    }
    const user = qqId(e.user_id), message = qqId(e.self_id);
    const group=e.message_type==='group'?qqId(e.group_id):null;
    if (this.state !== 'connected' || e.post_type !== 'message' || !['private','group'].includes(e.message_type) || !user || user===message || 'qq:' + message !== this.account || (e.message_type==='group'?!group||!this.groupEnabled(group):!this.friends.has(user))
      || !['string','number'].includes(typeof e.message_id) || !String(e.message_id) || !Array.isArray(e.message)) return;
    if (e.message.some(s => !(s.type === 'text' && typeof s.data?.text === 'string') && !(this.config.media.enabled && s.type === 'image' && typeof s.data?.url === 'string') && !(s.type==='forward' && forwardId(s.data?.id??s.data?.res_id??s.data?.forward_id)) && s.type!=='video' && !(group&&s.type==='at'&&(s.data?.qq==='all'||qqId(s.data?.qq))) && !(group&&['reply','face'].includes(s.type)&&/^-?\d{1,30}$/.test(String(s.data?.id))))) return;
    const forwards=e.message.filter(s=>s.type==='forward');
    const images=e.message.filter(s=>s.type==='image').map(s=>({url:s.data.url}));if(images.length>this.config.media.maxImages)return;
    const text = e.message.filter(s=>['text','at','reply','face'].includes(s.type)).map(s => s.type==='text'?s.data.text:s.type==='at'?'[@'+s.data.qq+']':s.type==='reply'?'[回复消息 '+s.data.id+'；未展开引用]':'[QQ表情 '+s.data.id+']').join('') || (forwards.length?'[QQ转发聊天记录]':images.length?'[QQ图片 × '+images.length+']':'[视频已跳过]'); if (!text.trim() || text.length > this.config.bridge.maxTextChars) return;
    this.runtime.addressBook.observeQQ(user,{nickname:e.sender?.nickname});
    const actor=this.runtime.addressBook.actor({account:this.account,user},{});
    const qqGroup=group?{id:group,name:this.groups.get(group).name}:undefined;
    if(group){actor.qqGroup=qqGroup;actor.audience='qq-group';actor.groupCard=clean(String(e.sender?.card??''),80);actor.sourceLabel='QQ群消息 · '+actor.displayName;}
    const messageId=group?'group:'+group+':'+e.message_id:String(e.message_id);
    this.store.ingestQQ(this.account, user, messageId, text, images, actor, forwards, qqGroup);
    const job = this.store.db.prepare('SELECT * FROM jobs WHERE account=? AND user=? AND message_id=?').get(this.account, user, messageId);
    if (job) { this.runtime.rememberContact(job); if (this.store.active(job.session)) this.runtime.flag(job.session, 'preempt'); }
  }
  async refreshFriends() {
    const rows = await this.rpc('get_friend_list');
    if (!Array.isArray(rows) || rows.some(r => !qqId(r.user_id))) throw new BridgeError('qq-friend-list-invalid');
    this.friends = new Set(rows.map(r => qqId(r.user_id)).filter(id => 'qq:' + id !== this.account));
    for(const row of rows)this.runtime.addressBook.observeQQ(qqId(row.user_id),{nickname:row.nickname,remark:row.remark});
    this.runtime.db.prepare("DELETE FROM contacts WHERE account=? AND user NOT LIKE 'group:%'").run(this.account);
    for (const user of this.friends) {
      const id = this.runtime.contactId({ account: this.account, user });
      this.runtime.db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?)').run(id, this.account, user, 'qq-contact:' + this.account + ':' + user, Date.now());
    }
  }
  async refreshGroups() {
    const rows=await this.rpc('get_group_list');
    if(!Array.isArray(rows)||rows.some(r=>!qqId(r.group_id)))throw new BridgeError('qq-group-list-invalid');
    this.groups=new Map(rows.map(r=>{const id=qqId(r.group_id);return[id,{id,name:clean(String(r.group_name??''),120),members:Number.isSafeInteger(r.member_count)?r.member_count:null}]}));
    this.runtime.saveChannelSettings('qq-groups-known',{account:this.account,groups:[...this.groups.values()]});
    this.syncGroupContacts();
  }
  syncGroupContacts() {
    this.runtime.db.prepare("DELETE FROM contacts WHERE account=? AND user LIKE 'group:%'").run(this.account);
    for(const g of this.groups.values())if(this.groupEnabled(g.id)){
      const user='group:'+g.id,id=this.runtime.contactId({account:this.account,user});
      this.runtime.db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?)').run(id,this.account,user,'qq-group:'+this.account+':'+g.id,Date.now());
    }
  }
  async readForward(id,user,{group}={}) {
    try{return await this.rpc('get_forward_msg',{id});}
    catch(e){
      if(e.code!=='qq-action-rejected'||!/^\d{1,30}$/.test(id))throw e;
      // NapCat numeric IDs rely on a process-local map. Rebuild only from this sender's recent records.
      if(group&&!this.groupEnabled(group))throw e;
      const history=await this.rpc(group?'get_group_msg_history':'get_friend_msg_history',{...(group?{group_id:group}:{user_id:user}),count:20,parse_mult_msg:false});
      const found=history?.messages?.some(m=>String(m.user_id)===user&&(!group||String(m.group_id)===group)&&Array.isArray(m.message)&&m.message.some(s=>s.type==='forward'&&String(s.data?.id)===id));
      if(!found)throw e;
      return this.rpc('get_forward_msg',{id});
    }
  }
  async connect(c) {
    const token = this.credentials()?.token; if (!token) throw new BridgeError('qq-token-required');
    this.state = 'connecting'; this.ws = new WebSocket(c.url, { headers: { Authorization: 'Bearer ' + token }, handshakeTimeout: 5000, maxPayload: 1024 * 1024, followRedirects: false });
    this.ws.on('message', raw => { try { this.frame(raw); } catch { this.error = 'qq-event-storage'; } });
    this.ws.on('error', () => {});
    this.ws.on('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject('qq-disconnected'); } this.pending.clear(); });
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', () => reject(new BridgeError('qq-connect-failed'))); this.ws.once('close', () => reject(new BridgeError('qq-disconnected'))); });
    const login = await this.rpc('get_login_info'); const id = qqId(login?.user_id); if (!id) throw new BridgeError('qq-account-invalid');
    this.account = 'qq:' + id; await this.refreshFriends(); await this.refreshGroups(); this.state = 'connected'; this.error = null; this.runtime.saveChannelSettings('qq-live',{account:this.account});
  }
  async send(body) {
    if (!this.allowed(body.qq.account, body.qq.user)) throw Object.assign(new BridgeError('qq-recipient-unavailable'), { retryable: !body.qq.user.startsWith('group:') });
    const message=body.qq.file?[{type:'image',data:{file:body.qq.file,sub_type:1}}]:[{ type: 'text', data: { text: body.qq.text } }];
    const group=body.qq.user.startsWith('group:');
    const result = await this.rpc(group?'send_group_msg':'send_private_msg', { [group?'group_id':'user_id']: Number(group?body.qq.user.slice(6):body.qq.user), message });
    if (!['number','string'].includes(typeof result?.message_id)) throw Object.assign(new BridgeError('qq-send-unconfirmed'), { ambiguous: true });
    return { message_id: String(result.message_id) };
  }
  disconnect() { this.ws?.terminate(); this.state = this.settings().enabled ? 'disconnected' : 'disabled'; }
  async run() {
    let attempt = 0, lastRefresh = 0, key = '';
    try { while (!this.signal.aborted) {
      const c = this.settings(), nextKey = JSON.stringify(c);
      if (!c.enabled) { if (this.ws) this.disconnect(); this.state = 'disabled'; }
      else try {
        if (key !== nextKey || this.ws?.readyState !== WebSocket.OPEN) { this.disconnect(); await this.connect(c); key = nextKey; lastRefresh = Date.now(); attempt = 0; }
        if (Date.now() - lastRefresh > 30000) { await this.refreshFriends(); await this.refreshGroups(); lastRefresh = Date.now(); }
      } catch (e) { this.error = /^qq-[a-z-]+$/.test(e.code ?? '') ? e.code : 'qq-connection'; this.disconnect(); await sleep(Math.min(backoff(attempt++), 10000), this.signal).catch(() => {}); }
      await sleep(500, this.signal).catch(() => {});
    } } finally { this.disconnect(); }
  }
}
