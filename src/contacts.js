import { BridgeError } from './util.js';
import { clean } from './cognitive/store.js';

export const OWNER_QQ = '3626097226';
export const qqId = value => typeof value === 'number' && Number.isSafeInteger(value) ? qqId(String(value)) : typeof value === 'string' && /^[1-9]\d{4,11}$/.test(value) ? value : null;
export function senderActor(job, account = {}, entry, profile = {}) {
  const channel = job.account.startsWith('qq:') ? 'qq' : 'weixin';
  const trustedOwner = channel === 'qq' ? job.user === OWNER_QQ : job.account === account.accountId && job.user === account.ownerId;
  const displayName = trustedOwner ? 'OTREE' : entry?.alias || profile.remark || profile.nickname || (channel === 'qq' ? 'QQ用户 ' : '微信用户 ') + job.user;
  return { channel, accountId:job.account,userId:job.user,trustedOwner,displayName,sourceLabel:(channel==='qq'?'QQ消息':'微信消息')+' · '+displayName,
    ...(profile.nickname?{nickname:profile.nickname}:{}),...(profile.remark?{remark:profile.remark}:{}),...(entry?{addressBook:entry}:{}) };
}
export class AddressBook {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS address_book(channel TEXT NOT NULL,peer TEXT NOT NULL,alias TEXT NOT NULL,notes TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(channel,peer));`);
    db.exec('CREATE TABLE IF NOT EXISTS contact_profiles(channel TEXT NOT NULL,peer TEXT NOT NULL,nickname TEXT NOT NULL,remark TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(channel,peer))');
    db.prepare('INSERT OR IGNORE INTO address_book VALUES(?,?,?,?,?)').run('qq', OWNER_QQ, 'OTREE', '', Date.now());
    db.prepare('INSERT OR IGNORE INTO address_book VALUES(?,?,?,?,?)').run('qq', '3326487557', 'OTREE的好朋友', '', Date.now());
  }
  list() { return this.db.prepare('SELECT * FROM address_book ORDER BY channel,peer').all().map(r => ({ ...r, trustedOwner: r.channel === 'qq' && r.peer === OWNER_QQ })); }
  edit({ channel, peer, alias, notes = '', ...extra }) {
    if (Object.keys(extra).length || !['qq', 'weixin'].includes(channel) || typeof peer !== 'string' || !peer || peer.length > 200 || clean(peer, 200) !== peer || channel === 'qq' && !qqId(peer)
      || typeof alias !== 'string' || !alias.trim() || alias.length > 80 || clean(alias, 80) !== alias || typeof notes !== 'string' || notes.length > 1000 || clean(notes, 1000) !== notes) throw new BridgeError('contact-invalid');
    this.db.prepare('INSERT INTO address_book VALUES(?,?,?,?,?) ON CONFLICT(channel,peer) DO UPDATE SET alias=excluded.alias,notes=excluded.notes,updated=excluded.updated').run(channel, peer, alias, notes, Date.now());
    return { saved: true, channel, peer, trustedOwner: channel === 'qq' && peer === OWNER_QQ };
  }
  actor(job, account) {
    const channel = job.account.startsWith('qq:') ? 'qq' : 'weixin';
    const entry = this.db.prepare('SELECT alias,notes FROM address_book WHERE channel=? AND peer=?').get(channel, job.user);
    const profile = this.db.prepare('SELECT nickname,remark FROM contact_profiles WHERE channel=? AND peer=?').get(channel,job.user);
    return senderActor(job,account,entry,profile??{});
  }
  observeQQ(peer, profile) {
    if(!qqId(peer))throw new BridgeError('contact-invalid');
    const old=this.db.prepare("SELECT nickname,remark FROM contact_profiles WHERE channel='qq' AND peer=?").get(peer)??{};
    const name=key=>typeof profile[key]==='string'?clean(profile[key],80).replace(/[\r\n]/g,' '):old[key]??'';
    this.db.prepare("INSERT OR REPLACE INTO contact_profiles VALUES('qq',?,?,?,?)").run(peer,name('nickname'),name('remark'),Date.now());
  }
}
