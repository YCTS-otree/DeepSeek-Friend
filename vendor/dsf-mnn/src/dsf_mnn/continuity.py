"""Bounded, source-backed conversation continuity; never a personality script."""
import json,re
from .model import canonical, MemoryError

INTERNAL={'runtime-context','friend-continuation','mnn-runtime','compaction','compact-checkpoint','mnn-continuity-context'}
SEND_TOOLS={'weixin_send_message','qq_send_message','contact_send_message'}

def recent_dialogue(export,records,counter,*,token_budget=8192,max_turns=24):
    if not 256<=token_budget<=32768 or not 1<=max_turns<=64:raise MemoryError('continuity-budget-invalid')
    by_seq={r['seq']:r for r in records};projected={p['seq']:p['message'] for p in export['projected']}
    groups=[];current=None;calls={}
    def finish():
        nonlocal current
        if current and not current['hidden'] and any(m['role']=='assistant' for m in current['messages']):groups.append(current['messages'])
        current=None
    def item(raw,role,text,refs=None):
        r=by_seq[raw['seq']]
        return {'source_ref':r['id'],'source_seq':r['seq'],'native_seq':r['metadata']['native_seq'],
                'observed_at':r['observed_at'],'role':role,'text':text,**({'tool_source_refs':refs} if refs else {})}
    for raw in export['events']:
        kind=raw['type'];r=by_seq[raw['seq']];m=projected.get(raw['seq'])
        source=(m or {}).get('source',{}).get('kind')
        if kind=='user/message' and source not in INTERNAL and not r['metadata'].get('generated_context') and not r['text'].startswith('Current runtime context.'):
            text=r['text']
            if r['metadata'].get('has_media'):
                text='\n'.join(b.get('text','') for b in (m or {}).get('content',[]) if b.get('type')=='text')+'\n[该消息另有媒体，原件保留于来源记录]'
            text=re.sub(r'\bsk-[A-Za-z0-9_-]{16,128}\b','[credential-redacted]',text)
            finish();current={'hidden':bool(r['metadata'].get('operator_only')),'private':False,'messages':[item(raw,'user',text)]};calls={}
        elif kind=='assistant/message' and current:
            if r['metadata'].get('operator_only'):current['hidden']=True
            # Only actual text, never reasoning, tool arguments or private notes.
            text='\n'.join(b.get('text','') for b in (m or {}).get('content',[]) if b.get('type')=='text').strip()
            text=re.sub(r'\bsk-[A-Za-z0-9_-]{16,128}\b','[credential-redacted]',text)
            if text and not current['private']:current['messages'].append(item(raw,'assistant',text))
        elif kind=='tool/call' and current and raw['data'].get('name')=='private_note':current['private']=True
        elif kind=='tool/call' and current and raw['data'].get('name') in SEND_TOOLS:
            if r['metadata'].get('operator_only'):current['hidden']=True
            try:args=raw['data']['arguments'];args=json.loads(args) if isinstance(args,str) else args
            except (ValueError,TypeError):continue
            if isinstance(args,dict) and isinstance(args.get('text'),str):calls[raw['data']['callId']]=(raw,args['text'],args.get('recipient'))
        elif kind=='tool/result' and current and m:
            call_id=m.get('callId') or m.get('source',{}).get('callId');call=calls.pop(call_id,None)
            if call and not m.get('isError') and not m.get('error'):
                if r['metadata'].get('operator_only'):current['hidden']=True
                else:
                    try:outcome=json.loads(r['text'])
                    except (ValueError,TypeError):continue
                    if not isinstance(outcome,dict) or outcome.get('state')!='queued':continue
                    text=re.sub(r'\bsk-[A-Za-z0-9_-]{16,128}\b','[credential-redacted]',call[1])
                    row=item(call[0],'assistant',text,[r['id']]);row.update(recipient_ref=call[2],delivery_status='queued-not-confirmed');current['messages'].append(row)
        elif kind=='turn/end':
            if raw['data'].get('reason',{}).get('kind')=='error':current=None
            finish()
    finish()
    chosen=[]
    for group in reversed(groups):
        if len(chosen)>=max_turns:break
        candidate=[group]+chosen
        if counter.count_text(canonical(candidate))>token_budget:break
        chosen=candidate
    return chosen
