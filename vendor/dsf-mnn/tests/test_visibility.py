import json,pytest
from test_production import export,add,Provider,Counter
from dsf_mnn.production import ProductionMemory
from dsf_mnn.visibility import purge_diagnostics
from dsf_mnn.model import MemoryError
from dsf_mnn.model import Event,Node
from dsf_mnn.formation import Formation

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
