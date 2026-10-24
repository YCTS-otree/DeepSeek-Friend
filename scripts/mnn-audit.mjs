// Read-only native reopen audit. Report counts and invariants, never conversation text.
import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createNativeKernel} from '../vendor/dsf-mnn/adapters/dsh/native-kernel.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),run=path.resolve(process.argv[2]);
if(!run.startsWith(path.join(root,'.research/mnn-v120')+path.sep))throw Error('mnn-audit-isolated-directory-required');
const report=JSON.parse(await fs.readFile(path.join(run,'report.json'),'utf8'));
const before=JSON.parse(await fs.readFile(path.join(run,'round-0-before.json'),'utf8'));
const kernel=await createNativeKernel(path.join(root,'.runtime/node_modules'),path.join(run,'sessions'));
const handle=await kernel.persistence.open(before.session_id,'read');
try{
 const {events}=await handle.read(),calls=new Set(),results=new Set(),inbox={'next-turn':[],'next-step':[]};
 for(const event of events){const d=event.data;
  if(event.type==='tool/call')calls.add(d.callId);
  if(event.type==='tool/result')results.add(d.message.callId??d.message.source?.callId);
  if(event.type==='agent/inbox/spliced')inbox[d.target].splice(d.start,d.removedCount??0,...d.inserted);
 }
 const audit={session_id:before.session_id,prefix_equal:isDeepStrictEqual(events.slice(0,before.events.length),before.events),
  native_reopen:true,tool_calls:calls.size,tool_results:results.size,paired:[...calls].every(id=>results.has(id)),
  pending_inputs:inbox['next-turn'].length+inbox['next-step'].length,last_turn:events.filter(e=>e.type==='turn/end').at(-1)?.data.reason.kind,compactions:events.filter(e=>e.type==='compaction/summary').length};
 audit.success=report.success&&audit.prefix_equal&&audit.paired&&audit.pending_inputs===0&&audit.last_turn==='completed'&&audit.compactions>=3;
 await fs.writeFile(path.join(run,'reopen-audit.json'),JSON.stringify(audit,null,2),{flag:'wx'});console.log(JSON.stringify(audit));if(!audit.success)process.exitCode=2;
}finally{await handle.close();await kernel.ctx.fiber.dispose();}
