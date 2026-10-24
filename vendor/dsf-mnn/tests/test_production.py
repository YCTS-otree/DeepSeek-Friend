from copy import deepcopy
import json
import pytest
from dsf_mnn.production import ProductionMemory
from dsf_mnn.model import MemoryError

class Counter:
    def count_text(self,text):return len(text.encode())
    def count_messages(self,messages):return self.count_text(json.dumps(messages,ensure_ascii=False))
class Provider:
    model='mock-experienced-facts'
    def __init__(self):self.calls=0;self.fail=False
    def json(self,system,payload,**options):
        self.calls+=1
        if self.fail:raise MemoryError('mock-provider-offline')
        if 'groups' in payload:
            notes=[]
            for group in payload['groups']:
                for event in group['events']:
                    if 'port=' in event['text']:
                        notes.append({'kind':'Fact','key':'project:port','content':event['text'],'importance':.9,'evidence':[{'seq':event['seq'],'quote':event['text']}],'carryover':True,'exact':True,'next_actions':['继续项目']})
            return {'notes':notes[:8],'links':[],'noop':not notes},{'usage':{'prompt_tokens':20,'completion_tokens':10}}
        refs=[n['id'] for n in payload['notes']]
        return {'themes':[{'title':'project','summary':'参数','memory_refs':refs}] if refs else [],'carryover':[{'description':'继续项目','next_actions':['验证参数'],'memory_refs':refs}] if refs else [],'decisions':[],'self_update':None},{'usage':{'prompt_tokens':20,'completion_tokens':10}}

def export(sid='original'):
    result={'schema':'dsf-mnn-dsh-export/1','session_id':sid,'events':[],'projected':[],'surface':[]}
    for role,text in [('system','Core/Self 原样保留'),('user','project port=3099'),('assistant','已记录')]+[('user','普通经历 '+str(i)) for i in range(10)]:add(result,role,text)
    return result
def add(data,role,text):
    seq=len(data['events']);message={'role':role,'content':[{'type':'text','text':text}]}
    kind={'system':'system/message','user':'user/message','assistant':'assistant/message'}[role]
    data['events'].append({'seq':seq,'time':1792400000000+seq*1000,'type':kind,'data':message if role=='user' else {'message':message}})
    data['projected'].append({'seq':seq,'message':message});data['surface'].append(seq)

def test_one_graph_multiple_sessions_and_source_sequence_collisions(tmp_path):
    m=ProductionMemory(tmp_path,provider=Provider(),counter=Counter())
    try:
        a,b=export('a'),export('b');m.capture(b);m.capture(a)
        assert m.store.status(m.scope)['events']==26
        one=m.dreaming(a,day='2026-10-21');two=m.dreaming(b,day='2026-10-22')
        assert one['memoryPersisted'] and two['memoryPersisted']
        assert m.recall('port=3099')['evidence_refs']
        assert len(m.store.db.execute('SELECT * FROM scopes').fetchall())==1
    finally:m.close()

def test_three_days_dreaming_reconstruction_identity_and_idempotency(tmp_path):
    provider=Provider();m=ProductionMemory(tmp_path,provider=provider,counter=Counter());data=export();all_events=[]
    try:
        for day in range(21,24):
            result=m.dreaming(data,day=f'2026-10-{day}')
            calls=provider.calls;assert m.dreaming(data,day=f'2026-10-{day}')==result;assert provider.calls==calls
            assert result['self_update']=='noop';assert result['carryover'];assert result['plan']['session_id']=='original'
            assert result['plan']['system_message']['content'][0]['text']=='Core/Self 原样保留'
            before=deepcopy(data['events']);shadow=set(result['plan']['shadowed_seqs'])
            add(data,'user',result['plan']['checkpoint_text']);data['events'][-1]['data']['source']={'kind':'compact-checkpoint'}
            data['projected'][-1]['message']['source']={'kind':'compact-checkpoint'}
            new=data['surface'].pop();at=next(i for i,n in enumerate(data['surface']) if n in shadow)
            data['surface']=[n for n in data['surface'] if n not in shadow];data['surface'].insert(at,new)
            for i in range(8):add(data,'user','跨日经历 '+str(day)+'-'+str(i))
            assert data['events'][:len(before)]==before
            all_events.append(len(data['events']))
        assert all_events==sorted(all_events);assert m.recall('port=3099')['evidence_refs']
    finally:m.close()

def test_interrupted_dreaming_restarts_without_duplicate_events(tmp_path):
    provider=Provider();provider.fail=True;m=ProductionMemory(tmp_path,provider=provider,counter=Counter());data=export()
    try:
        with pytest.raises(MemoryError,match='mock-provider'):m.dreaming(data,day='2026-10-21')
        count=m.store.status(m.scope)['events'];provider.fail=False
        result=m.dreaming(data,day='2026-10-21');assert result['memoryPersisted'];assert m.store.status(m.scope)['events']==count
        changed=deepcopy(data);changed['events'][1]['data']['content'][0]['text']='篡改'
        with pytest.raises(MemoryError,match='native-source-changed'):m.capture(changed)
    finally:m.close()

def test_idle_extraction_then_rest_uses_distinct_run_without_reextracting(tmp_path):
    provider=Provider();m=ProductionMemory(tmp_path,provider=provider,counter=Counter());data=export()
    try:
        daily=m.dreaming(data,day='2026-10-21',reconstruct=False);calls=provider.calls
        rest=m.dreaming(data,day='2026-10-21',reconstruct=True)
        assert daily['run_id']!=rest['run_id'] and 'plan' in rest
        assert provider.calls==calls and rest['session_id']=='original'
    finally:m.close()

def test_implementation_change_preserves_old_run_and_reuses_durable_chunks(tmp_path,monkeypatch):
    import dsf_mnn.production as production
    provider=Provider();m=ProductionMemory(tmp_path,provider=provider,counter=Counter());data=export()
    try:
        one=m.dreaming(data,day='2026-10-21');calls=provider.calls;old=(tmp_path/'runs'/one['run_id']/'history.json').read_bytes()
        monkeypatch.setattr(production,'implementation_revision',lambda:'new-tested-build')
        two=m.dreaming(data,day='2026-10-21')
        assert one['run_id']!=two['run_id'];assert provider.calls==calls
        assert (tmp_path/'runs'/one['run_id']/'history.json').read_bytes()==old
    finally:m.close()

def test_relocated_store_never_follows_serialized_absolute_history_path(tmp_path):
    import shutil
    old=tmp_path/'old';provider=Provider();m=ProductionMemory(old,provider=provider,counter=Counter());data=export()
    try:
        daily=m.dreaming(data,day='2026-10-21',reconstruct=False)
        body={**daily,'semantic_file':'/untrusted/outside-history.json'}
        m.store.db.execute('UPDATE production_runs SET body=? WHERE id=?',(json.dumps(body),daily['run_id']))
    finally:m.close()
    moved=tmp_path/'moved';shutil.move(old,moved);m=ProductionMemory(moved,provider=provider,counter=Counter())
    try:
        result=m.dreaming(data,day='2026-10-21',reconstruct=True)
        assert result['memoryPersisted'] and result['plan'] and not result['semantic_file'].startswith('/')
    finally:m.close()
