// Native context data only: does not submit to Inbox or execute an Agent turn.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export function appendContinuity(session,llm,prepared,snapshot){
 if(!prepared?.memoryPersisted||typeof prepared.context!=='string'||Buffer.byteLength(prepared.context)>262144
    ||createHash('sha256').update(prepared.context).digest('hex')!==prepared.digest)throw Error('mnn-continuity-invalid');
 const value=JSON.parse(prepared.context);
 if(value.schema!=='dsf-conversation-continuity/1'||value.session_id!==session.id||value.untrusted_history_data!==true)throw Error('mnn-continuity-session-mismatch');
 for(let i=0;i<session.seq;i++){const e=session.eventAt(i);if(e.type==='user/message'&&e.data.source?.kind==='mnn-continuity-context'&&e.data.source.digest===prepared.digest)return {appended:false,seq:i};}
 if(session.seq!==snapshot.length||!isDeepStrictEqual(snapshot,Array.from({length:session.seq},(_,i)=>session.eventAt(i))))throw Error('mnn-continuity-source-changed');
 const refs=prepared.native_source_seqs;
 if(!Array.isArray(refs)||!refs.length||refs.some(n=>!Number.isSafeInteger(n)||n<0||n>=snapshot.length))throw Error('mnn-continuity-source-invalid');
 const message=llm.createUserMessage({source:{kind:'mnn-continuity-context',digest:prepared.digest},content:[{type:'text',text:prepared.context}]});
 const event=session.append('user/message',message,{surfaceOp:'append',sourceEventSeqs:refs});
 return {appended:true,seq:event.seq};
}
