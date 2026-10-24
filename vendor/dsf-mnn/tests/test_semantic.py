import json
from pathlib import Path
import pytest

from dsf_mnn import MemoryStore, Scope, Event
from dsf_mnn.model import MemoryError
from dsf_mnn.semantic import SemanticDreaming, normalize_export, chunk_history, semantic_units
from dsf_mnn.run_lock import dreaming_lock


S = Scope("whale", "operator", "session", "recovery")
class Counter:
    def count_text(self, text): return len(text)


def exported(messages):
    events, projected = [], []
    for seq, message in enumerate(messages):
        kind = {"user": "user/message", "assistant": "assistant/message", "tool": "tool/result", "system": "system/message"}[message["role"]]
        data = message if kind == "user/message" else {"message": message}
        events.append({"seq": seq, "time": 1792800000000 + seq, "type": kind, "data": data})
        projected.append({"seq": seq, "message": message})
    return {"schema": "dsf-mnn-dsh-export/1", "session_id": "session", "events": events, "projected": projected}


def test_chunking_keeps_tool_group_and_exact_fragment_offsets():
    export = exported([
        {"role": "assistant", "content": [{"type": "tool-call", "callId": "c", "name": "test", "arguments": "{}"}]},
        {"role": "tool", "callId": "c", "content": [{"type": "text", "text": "结果" * 1200}]},
        {"role": "user", "content": [{"type": "text", "text": "继续"}]},
    ])
    records = normalize_export(export)
    assert len(semantic_units(export, records)[0]) == 2
    chunks = chunk_history(export, records, Counter(), input_tokens=700)
    fragments = [e for chunk in chunks for group in chunk for e in group["events"] if e["seq"] == 1]
    assert "".join(e["text"] for e in fragments) == records[1]["text"]
    assert all(e["text"] == records[1]["text"][e["fragment_offset"]:e["fragment_end"]] for e in fragments)


def test_unanswered_native_tool_call_refuses_history_plan():
    data = exported([{"role": "assistant", "content": [{"type": "tool-call", "callId": "c", "name": "test", "arguments": "{}"}]}])
    with pytest.raises(MemoryError, match="unfinished"):
        chunk_history(data, normalize_export(data), Counter())


def test_unverified_llm_quote_never_becomes_fact(tmp_path):
    with MemoryStore(tmp_path / "memory.sqlite") as store:
        raw = Event("dsh-event:0", 0, "端口 3099", "2026-10-24T00:00:00Z", "user_statement", "dsh://session/event/0")
        store.add_event(S, raw)
        engine = SemanticDreaming(store, S, None, Counter(), tmp_path / "out")
        result = engine.commit_notes({"notes": [{"kind": "Fact", "key": "port", "content": "端口 3100", "evidence": [{"seq": 0, "quote": "端口 3100"}]}]}, {0: {"text": raw.content, "id": raw.id}}, {0}, 0)
        assert result["rejected"] and not store.nodes(S)


def test_semantic_noop_and_retry_preserve_identity_and_raw_events(tmp_path):
    class Provider:
        def json(self, system, payload, **kwargs):
            return {"notes": [], "links": [], "noop": True}, {"usage": {"prompt_tokens": 1, "completion_tokens": 1}}
    export = exported([{"role": "user", "content": [{"type": "text", "text": "普通问候，无需形成长期记忆"}]}])
    with MemoryStore(tmp_path / "memory.sqlite") as store:
        engine = SemanticDreaming(store, S, Provider(), Counter(), tmp_path / "out")
        one, _ = engine.run(export)
        two, _ = engine.run(export)
        assert one["notes"] == two["notes"] == 0 and two["self_update"] == "noop"
        assert store.status(S)["events"] == 1


def test_provider_failure_preserves_raw_evidence_for_resume(tmp_path):
    class Failed:
        def json(self, *args, **kwargs): raise MemoryError("synthetic-provider-failure")
    export = exported([{"role": "user", "content": [{"type": "text", "text": "关键参数 port=3099"}]}])
    with MemoryStore(tmp_path / "memory.sqlite") as store:
        engine = SemanticDreaming(store, S, Failed(), Counter(), tmp_path / "out")
        with pytest.raises(MemoryError, match="synthetic-provider"):
            engine.run(export)
        assert store.event(S, "dsh-event:0")["content"] == "关键参数 port=3099"
        assert store.watermark(S, "semantic-dreaming") == -1


def test_concurrent_dreaming_is_rejected_and_lock_is_released(tmp_path):
    database = tmp_path / "memory.sqlite"
    with dreaming_lock(database):
        with pytest.raises(MemoryError, match="already-running"):
            with dreaming_lock(database):
                pytest.fail("second writer entered")
    with dreaming_lock(database):
        pass


def test_resume_rejects_changed_chunk_configuration(tmp_path):
    class Failed:
        def json(self, *args, **kwargs): raise MemoryError("synthetic-provider-failure")
    export = exported([{"role": "user", "content": [{"type": "text", "text": "关键参数 port=3099"}]}])
    with MemoryStore(tmp_path / "memory.sqlite") as store:
        engine = SemanticDreaming(store, S, Failed(), Counter(), tmp_path / "out")
        with pytest.raises(MemoryError, match="synthetic-provider"):
            engine.run(export)
        engine.input_tokens = 14000
        with pytest.raises(MemoryError, match="config-or-source-conflict"):
            engine.run(export)


def test_provider_transport_timeout_retains_failure_receipt(tmp_path, monkeypatch):
    import subprocess
    from dsf_mnn.remote import RemoteProvider
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("synthetic-node", 260)
    monkeypatch.setattr(subprocess, "run", timeout)
    provider = RemoteProvider(tmp_path / "dsf", tmp_path / "receipts")
    with pytest.raises(MemoryError, match="transport-timeout"):
        provider.request([{"role": "user", "content": "synthetic only"}])
    receipts = list((tmp_path / "receipts").glob("*.json"))
    assert len(receipts) == 1 and json.loads(receipts[0].read_text(encoding="utf-8"))["success"] is False
