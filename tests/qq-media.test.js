import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {qqImageUrl,qqImageBytes} from '../src/qq-media.js';
const url='https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=SYNTHETIC&rkey=SYNTHETIC';
const resolve=async()=>[{address:'8.8.8.8',family:4}];
function transport(status,bytes,{abort=false,contentLength=bytes.length}={}) {
  return (target,options,callback)=>{
    assert.equal(target.hostname,'multimedia.nt.qq.com.cn');assert.equal(options.agent,false);
    options.lookup(target.hostname,{all:true},(error,rows)=>{assert.equal(error,null);assert.deepEqual(rows,[{address:'8.8.8.8',family:4}]);});
    const req=new EventEmitter();req.destroy=()=>req.emit('close');req.end=()=>{const res=new PassThrough();res.statusCode=status;res.headers={'content-length':String(contentLength)};res.on('error',()=>{});callback(res);
      if(abort){res.write(bytes);res.emit('aborted');res.destroy();}else res.end(bytes);res.once('close',()=>req.emit('close'));
    };return req;
  };
}
test('official NT QQ image CDN is accepted exactly, with public DNS pinned to the TLS connection',async()=>{
  assert.equal(qqImageUrl(url).hostname,'multimedia.nt.qq.com.cn');
  const bytes=Buffer.from('synthetic-image-bytes');assert.deepEqual(await qqImageBytes(url,undefined,{resolve,request:transport(200,bytes)}),bytes);
  for(const bad of ['http://multimedia.nt.qq.com.cn/x','https://multimedia.nt.qq.com.cn.evil.example/x','https://127.0.0.1/x','https://multimedia.nt.qq.com.cn:8443/x'])assert.throws(()=>qqImageUrl(bad));
  await assert.rejects(qqImageBytes(url,undefined,{resolve:async()=>[{address:'127.0.0.1',family:4}]}),{code:'qq-image-address'});
});
test('QQ image redirects, oversized responses and broken bodies fail instead of leaving submission stuck',async()=>{
  await assert.rejects(qqImageBytes(url,undefined,{resolve,request:transport(302,Buffer.alloc(0))}),{code:'qq-image-response'});
  await assert.rejects(qqImageBytes(url,undefined,{resolve,request:transport(200,Buffer.alloc(8)),maxBytes:4}),{code:'qq-image-response'});
  await assert.rejects(qqImageBytes(url,undefined,{resolve,request:transport(200,Buffer.alloc(8),{contentLength:0}),maxBytes:4}),{code:'qq-image-size'});
  await assert.rejects(qqImageBytes(url,undefined,{resolve,request:transport(200,Buffer.alloc(8),{abort:true})}),{code:'qq-image-network'});
  const request=()=>{const req=new EventEmitter();req.end=()=>{};req.destroy=()=>req.emit('close');return req;};
  await assert.rejects(qqImageBytes(url,undefined,{resolve,request,timeoutMs:10}),{code:'qq-image-timeout'});
});
