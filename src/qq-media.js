import fs from 'node:fs';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { publicIPv4 } from './internet.js';
import { BridgeError } from './util.js';
import { clean } from './cognitive/store.js';

const hosts = new Set(['multimedia.nt.qq.com.cn','multimedia.nt.qq.com','gchat.qpic.cn','c2cpicdw.qpic.cn','p.qpic.cn','qpic.cn','pic.qpic.cn','imgcache.qq.com','gxh.vip.qq.com']);
export function qqImageUrl(value) {
  let u; try { u = new URL(value); } catch { throw new BridgeError('qq-image-url'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !hosts.has(u.hostname)) throw new BridgeError('qq-image-host');
  return u;
}
export async function qqImageBytes(value, signal, { resolve = lookup, request = https.request, maxBytes = 8*1024*1024, timeoutMs = 10000 } = {}) {
  const u=qqImageUrl(value);let timer;
  const addresses=await Promise.race([resolve(u.hostname,{all:true,family:4}),new Promise((_r,reject)=>{timer=setTimeout(()=>reject(new BridgeError('qq-image-dns-timeout')),2000);})]).finally(()=>clearTimeout(timer));
  if (!addresses.length || addresses.some(a=>!publicIPv4(a.address))) throw new BridgeError('qq-image-address');
  return new Promise((resolveResult,reject)=>{
    const req=request(u,{agent:false,signal,lookup:(_h,o,cb)=>cb(null,...(o.all?[[{address:addresses[0].address,family:4}]]:[addresses[0].address,4]))},res=>{
      if(res.statusCode!==200 || Number(res.headers['content-length'])>maxBytes){res.destroy();reject(new BridgeError('qq-image-response'));return;}
      const chunks=[];let size=0,ended=false;
      res.on('data',b=>{size+=b.length;if(size>maxBytes){res.destroy();reject(new BridgeError('qq-image-size'));}else chunks.push(b);});
      res.on('error',()=>reject(new BridgeError('qq-image-network')));
      res.on('aborted',()=>reject(new BridgeError('qq-image-network')));
      res.on('close',()=>{if(!ended)reject(new BridgeError('qq-image-network'));});
      res.on('end',()=>{ended=true;resolveResult(Buffer.concat(chunks));});
    });
    const timer=setTimeout(()=>{req.destroy();reject(new BridgeError('qq-image-timeout'));},timeoutMs);req.once('close',()=>clearTimeout(timer));req.on('error',()=>reject(new BridgeError('qq-image-network')));req.end();
  });
}
export class QQMedia {
  constructor(runtime, qq, media, signal, { download=qqImageBytes }={}) { Object.assign(this,{runtime,qq,media,signal,download}); this.lastRefresh=0; this.lastError=null; runtime.db.exec("UPDATE qq_media_actions SET state='unknown' WHERE state='running'"); }
  async refresh() {
    if(this.qq.state!=='connected')return;
    const rows=await this.qq.rpc('fetch_custom_face_detail',{count:100});if(!Array.isArray(rows))throw new BridgeError('qq-sticker-list');
    const db=this.runtime.db; db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE qq_favorites SET available=0 WHERE account=?').run(this.qq.account);
      for(const item of rows.slice(0,100)){
        if(typeof item.resId!=='string'||typeof item.url!=='string')continue;
        try{qqImageUrl(item.url);}catch{continue;}
        const id='qqfav-'+createHash('sha256').update(this.qq.account+'\0'+item.resId).digest('hex').slice(0,32);
        db.prepare('INSERT INTO qq_favorites(id,account,resid,url,description,available) VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET url=excluded.url,description=excluded.description,available=1').run(id,this.qq.account,item.resId,item.url,clean(item.desc??item.modifyWord??'',500));
      }
      db.exec('COMMIT');this.lastRefresh=Date.now();this.lastError=null;
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  async receive(item) { const bytes=await this.download(item.url,this.signal);return this.media.save(bytes); }
  async tick() {
    if(this.qq.state!=='connected')return;
    if(Date.now()-this.lastRefresh>60000){try{await this.refresh();}catch{this.lastRefresh=Date.now();this.lastError='qq-sticker-list-unavailable';}}
    const favorite=this.runtime.db.prepare('SELECT * FROM qq_favorites WHERE account=? AND available=1 AND image IS NULL AND requested>0 ORDER BY requested LIMIT 1').get(this.qq.account);
    if(favorite){
      try{const saved=await this.receive({url:favorite.url});this.runtime.db.prepare('UPDATE qq_favorites SET image=?,error=NULL,requested=0 WHERE id=?').run(saved.id,favorite.id);}
      catch(e){this.runtime.db.prepare('UPDATE qq_favorites SET requested=0,error=? WHERE id=?').run(e.code??'qq-image-download',favorite.id);}
    }
    const action=this.runtime.db.prepare("SELECT * FROM qq_media_actions WHERE state='pending' AND account=? ORDER BY created LIMIT 1").get(this.qq.account);if(!action)return;
    this.runtime.db.prepare("UPDATE qq_media_actions SET state='running' WHERE id=? AND state='pending'").run(action.id);
    try {
      const {row}=this.media.image(action.image);
      await this.qq.rpc('add_custom_face',{file:row.file});
      this.runtime.db.prepare("UPDATE qq_media_actions SET state='done' WHERE id=?").run(action.id);this.lastRefresh=0;
    }catch(e){this.runtime.db.prepare('UPDATE qq_media_actions SET state=?,error=? WHERE id=?').run(e.ambiguous?'unknown':'failed',e.code??'qq-sticker-add',action.id);}
  }
  sendImage(id) { const {bytes}=this.media.image(id);return 'base64://'+bytes.toString('base64'); }
}
