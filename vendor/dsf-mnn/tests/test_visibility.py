import json,pytest
from test_production import export,add,Provider,Counter
from dsf_mnn.production import ProductionMemory
from dsf_mnn.visibility import purge_diagnostics
from dsf_mnn.model import MemoryError
from dsf_mnn.model import Event,Node
from dsf_mnn.formation import Formation
from dsf_mnn.semantic import normalize_export,semantic_units

def test_purge_removes_preexisting_derived_nodes_indexes_and_evidence(tmp_path):
    m=ProductionMemory(tmp_path,provider=Provider(),counter=Counter())
    try:
        m.store.add_event(m.scope,Event('old-error',5001,'CONTEXT_WINDOW_EXCEEDED','2026-10-24T00:00:00Z','external','dsh://synthetic/5001'))
        m.store.add_node(m.scope,Node('bad','Fact','上下文修复是原因',['old-error']))
        m.store.add_node(m.scope,Node('dependent','Goal','继续',['old-error'],metadata={'memory_refs':['bad']}))
        Formation(m.store).index(m.scope,m.store.nodes(m.scope))
        result=purge_diagnostics(m);assert result['hiddenSources']==1
        for table in ('nodes','lexical','embeddings','node_sources','history'):assert m.store.db.execute('SELECT count(*) FROM '+table).fetchone()[0]==0
        with pytest.raises(MemoryError):m.store.event(m.scope,'old-error')
        assert m.recall('CONTEXT_WINDOW_EXCEEDED')['text']==''
    finally:m.close()

def test_internal_errors_never_become_recall_or_dreaming_evidence(tmp_path):
    source=export();add(source,'user','CONTEXT_WINDOW_EXCEEDED 上下文修复记录')
    m=ProductionMemory(tmp_path,provider=Provider(),counter=Counter())
    try:
        mapped,records,_=m.capture(source)
        hidden=[r for r in records if r['metadata'].get('operator_only')];assert hidden
        assert all('CONTEXT_WINDOW_EXCEEDED' not in r['text'] for r in records)
        assert m.recall('CONTEXT_WINDOW_EXCEEDED')['text']==''
        m.dreaming(source,day='2026-10-25');assert m.recall('port=3099')['evidence_refs']
        assert all('CONTEXT_WINDOW_EXCEEDED' not in n['content'] for n in m.store.nodes(m.scope))
    finally:m.close()

def test_private_reconstruction_cuts_entire_old_surface_without_changing_system_or_raw_events(tmp_path):
    source=export();add(source,'user','修的是上下文那段吗？');before=json.dumps(source['events'])
    m=ProductionMemory(tmp_path,provider=Provider(),counter=Counter())
    try:
        m.dreaming(source,day='2026-10-25');purge_diagnostics(m)
        result=m.privacy_prepare(source,context_tokens=200000,output_reserve=100)
        assert result['plan']['tail_seqs']==[]
        assert set(result['plan']['shadowed_seqs'])==set(source['surface'][1:])
        assert 'CONTEXT_WINDOW_EXCEEDED' not in result['plan']['checkpoint_text']
        assert '上下文那段' not in result['plan']['checkpoint_text']
        assert json.dumps(source['events'])==before
        # Re-importing the immutable source cannot resurrect a removed event.
        m.capture(source);assert m.recall('上下文那段')['text']==''
    finally:m.close()

def test_dreaming_after_private_reconstruction_reports_noop_for_host_pressure_validation(tmp_path):
    source=export();source['surface']=[0]
    add(source,'user','继续。');source['events'][-1]['data']['source']={'kind':'compact-checkpoint'}
    m=ProductionMemory(tmp_path,provider=Provider(),counter=Counter())
    try:
        result=m.dreaming(source,day='2026-10-25')
        assert result['memoryPersisted'] and result['self_update']=='noop'
        assert result['compactionNoop']=='acr-no-safe-rolling-range' and 'plan' not in result
        assert m.dreaming(source,day='2026-10-25')==result
    finally:m.close()

def test_diagnostic_tool_results_hide_the_matching_call_without_creating_orphans():
    source=export();seq=len(source['events']);call={'type':'tool-call','callId':'c','name':'room_read','arguments':'{}'}
    message={'role':'assistant','content':[call]}
    source['events'].append({'seq':seq,'type':'assistant/message','time':1792400000000,'data':{'message':message}});source['projected'].append({'seq':seq,'message':message})
    source['events'].append({'seq':seq+1,'type':'tool/call','time':1792400000001,'data':{'callId':'c','name':'room_read','arguments':'{}'}});source['projected'].append({'seq':seq+1,'message':None})
    result={'role':'tool','callId':'c','content':[{'type':'text','text':'CONTEXT_WINDOW_EXCEEDED'}]}
    source['events'].append({'seq':seq+2,'type':'tool/result','time':1792400000002,'data':{'message':result}});source['projected'].append({'seq':seq+2,'message':result})
    records=normalize_export(source)
    assert all(r['metadata'].get('operator_only') for r in records[-3:]);semantic_units(source,records)
