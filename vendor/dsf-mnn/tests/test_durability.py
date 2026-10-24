import json
import pytest
import dsf_mnn.semantic as semantic
import dsf_mnn.atomic_io as io
from dsf_mnn.production import ProductionMemory
from test_production import export,add,Provider,Counter

def test_consolidation_unknown_refs_get_bounded_repair_and_never_commit(tmp_path):
    class RepairProvider(Provider):
        def __init__(self,always=False):super().__init__();self.bad=0;self.always=always
        def json(self,system,payload,**options):
            if 'notes' in payload and (self.always or self.bad==0):
                self.calls+=1;self.bad+=1
                return {'themes':[],'carryover':[{'description':'unsupported','memory_refs':['invented-id']}],'decisions':[]},{}
            return super().json(system,payload,**options)
    provider=RepairProvider();memory=ProductionMemory(tmp_path/'recover',provider=provider,counter=Counter())
    try:
        result=memory.dreaming(export(),day='2026-10-21');assert result['memoryPersisted'] and provider.bad==1
        assert not any(n['content']=='unsupported' for n in memory.store.nodes(memory.scope))
    finally:memory.close()
    provider=RepairProvider(always=True);memory=ProductionMemory(tmp_path/'fail',provider=provider,counter=Counter())
    try:
        with pytest.raises(semantic.MemoryError,match='consolidation-unknown-memory-ref'):memory.dreaming(export(),day='2026-10-21')
        assert provider.bad==3
        assert not any(n['content']=='unsupported' for n in memory.store.nodes(memory.scope))
    finally:memory.close()

def test_json_replace_failure_preserves_previous_receipt(tmp_path,monkeypatch):
    file=tmp_path/'receipt.json';io.atomic_json(file,{'before':True})
    def fail(*_):raise OSError('synthetic replace interruption')
    monkeypatch.setattr(io.os,'replace',fail)
    with pytest.raises(OSError):io.atomic_json(file,{'after':True})
    assert json.loads(file.read_text())=={'before':True}
    assert not list(tmp_path.glob('*.tmp'))

def test_committed_chunk_survives_receipt_write_crash_without_second_llm_extraction(tmp_path,monkeypatch):
    provider=Provider();memory=ProductionMemory(tmp_path,provider=provider,counter=Counter());source=export()
    original=semantic.atomic_json
    def fail_chunk(file,value):
        if file.name.startswith('chunk-'):raise OSError('synthetic crash after memory commit')
        return original(file,value)
    try:
        monkeypatch.setattr(semantic,'atomic_json',fail_chunk)
        with pytest.raises(OSError):memory.dreaming(source,day='2026-10-21')
        count=memory.store.status(memory.scope)['nodes'];calls=provider.calls
        monkeypatch.setattr(semantic,'atomic_json',original)
        result=memory.dreaming(source,day='2026-10-21')
        # Only consolidation is called; the committed extraction is not replayed.
        assert provider.calls==calls+1 and result['memoryPersisted']
        assert memory.store.status(memory.scope)['nodes']>=count
    finally:memory.close()

def test_repeated_semantic_fact_is_deduplicated_without_negative_metric(tmp_path):
    memory=ProductionMemory(tmp_path,provider=Provider(),counter=Counter());source=export()
    try:
        memory.dreaming(source,day='2026-10-21')
        add(source,'user','project port=3099')
        memory.dreaming(source,day='2026-10-22')
        facts=[n for n in memory.store.nodes(memory.scope) if n['type']=='Fact']
        assert len(facts)==1 and len(facts[0]['source_refs'])==2
    finally:memory.close()
