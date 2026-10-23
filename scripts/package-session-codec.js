import fs from 'node:fs';
import zlib from 'node:zlib';
// Standard Zstandard frame boundaries; DSH writes one header frame then event batches.
function decodeFrames(bytes) {
  let offset=0,total=0;const decoded=[];
  while(offset<bytes.length){
    const start=offset;
    if(bytes.readUInt32LE(offset)!==0xfd2fb528)throw Error('frame-magic');
    const descriptor=bytes[offset+4],single=Boolean(descriptor&32),size=descriptor>>>6;
    if(descriptor&24)throw Error('frame-reserved');
    offset+=5+(single?0:1)+[0,1,2,4][descriptor&3]+(size?2**size:single?1:0);
    let last=false;
    while(!last){
      const block=bytes.readUIntLE(offset,3),kind=(block>>>1)&3;last=Boolean(block&1);
      if(kind===3)throw Error('frame-block');
      offset+=3+(kind===1?1:block>>>3);
      if(offset>bytes.length)throw Error('frame-incomplete');
    }
    if(descriptor&4)offset+=4;
    if(offset>bytes.length)throw Error('frame-checksum-missing');
    const result=zlib.zstdDecompressSync(bytes.subarray(start,offset),{maxOutputLength:512*1024*1024});
    total+=result.length;if(total>1024*1024*1024)throw Error('session-too-large');decoded.push(result);
  }
  return Buffer.concat(decoded);
}
const [mode,source,dest]=process.argv.slice(2);
try {
  if(mode==='decode')fs.writeFileSync(dest,decodeFrames(fs.readFileSync(source)));
  else if(mode==='encode'){
    const bytes=fs.readFileSync(source),newline=bytes.indexOf(10);
    if(newline<0)throw Error('missing-header');
    const options={params:{[zlib.constants.ZSTD_c_checksumFlag]:1}};
    const frames=[zlib.zstdCompressSync(bytes.subarray(0,newline+1),options)];
    if(newline+1<bytes.length)frames.push(zlib.zstdCompressSync(bytes.subarray(newline+1),options));
    fs.writeFileSync(dest,Buffer.concat(frames));
  }else throw Error('invalid-mode');
}catch{process.exitCode=1;}
