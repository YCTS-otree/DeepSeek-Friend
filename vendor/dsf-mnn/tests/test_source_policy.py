import sqlite3,pytest
from contextlib import closing
from test_production import export,Provider,Counter
from dsf_mnn.production import ProductionMemory
from dsf_mnn.model import MemoryError

def registry(path):
    with closing(sqlite3.connect(path)) as db:
        db.executescript("CREATE TABLE meta(key PRIMARY KEY,value);INSERT INTO meta VALUES('mnn-generation','epoch-a');CREATE TABLE chat_sessions(session PRIMARY KEY,kind,archived);INSERT INTO chat_sessions VALUES('active','conversation',0),('archive','conversation',1),('test','test',0);");db.commit()

def test_rejected_sources_never_allocate_native_sources_or_events(tmp_path):
    file=tmp_path/'bridge.sqlite';registry(file);m=ProductionMemory(tmp_path/'memory',provider=Provider(),counter=Counter(),registry=file,generation='epoch-a')
    try:
        for sid in ['archive','test','unknown']:
            with pytest.raises(MemoryError,match='source-inactive'):m.capture(export(sid))
        assert m.store.db.execute('SELECT count(*) FROM native_sources').fetchone()[0]==0
        assert m.store.db.execute('SELECT count(*) FROM events').fetchone()[0]==0
        m.capture(export('active'));assert m.store.db.execute('SELECT count(*) FROM events').fetchone()[0]>0
        with closing(sqlite3.connect(file)) as db:db.execute("UPDATE meta SET value='epoch-b'");db.commit()
        with pytest.raises(MemoryError,match='generation-mismatch'):m.capture(export('active'))
    finally:m.close()

def test_source_archived_during_llm_call_cannot_commit_generated_notes(tmp_path):
    file=tmp_path/'bridge.sqlite';registry(file);provider=Provider();call=provider.json
    def changed(*args,**kwargs):
        result=call(*args,**kwargs)
        with closing(sqlite3.connect(file)) as db:db.execute("UPDATE chat_sessions SET archived=1 WHERE session='active'");db.commit()
        return result
    provider.json=changed;m=ProductionMemory(tmp_path/'memory',provider=provider,counter=Counter(),registry=file,generation='epoch-a')
    try:
        with pytest.raises(MemoryError,match='source-inactive'):m.dreaming(export('active'),day='2026-10-25')
        assert m.store.db.execute('SELECT count(*) FROM nodes').fetchone()[0]==0
    finally:m.close()

def test_old_graph_cannot_be_relabelled_as_a_new_generation(tmp_path):
    file=tmp_path/'bridge.sqlite';registry(file);m=ProductionMemory(tmp_path/'memory',provider=Provider(),counter=Counter());m.capture(export('active'));m.close()
    with pytest.raises(MemoryError,match='generation-mismatch'):ProductionMemory(tmp_path/'memory',registry=file,generation='epoch-a')
