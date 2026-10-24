from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from dsf_mnn import Event, MemoryStore, Node, Scope
from dsf_mnn.association import AssociationCue, SpontaneousAssociation
from dsf_mnn.compaction import CognitiveCompaction
from dsf_mnn.embedding import EmbeddingSpace, HashEmbedding, tokenize
from dsf_mnn.formation import Formation
from dsf_mnn.lifecycle import Dreaming, GoalState, SelfProjection
from dsf_mnn.model import MemoryError, canonical, digest
from dsf_mnn.recall import Recall, RecallBudget
from dsf_mnn.snapshot import validate_snapshot
from dsf_mnn.transfer import export_scope, import_scope


SCOPE = Scope("whale", "user-a", "session-a", "workspace-a")
TIME = "2026-10-23T10:00:00+08:00"


@pytest.fixture
def store(tmp_path):
    with MemoryStore(tmp_path / "memory.sqlite") as value:
        yield value


def event(i=1, content="微信桥接重复消息需要幂等", **kwargs):
    return Event(f"event-{i}", i, content, kwargs.pop("observed_at", TIME), kwargs.pop("source_kind", "tool_verified"), f"synthetic://session-a/{i}", **kwargs)


def memory(store, i=1, content="微信桥接重复消息需要幂等", *, scope=SCOPE, kind="Fact", **kwargs):
    raw = event(i, content)
    store.add_event(scope, raw)
    node = Node(f"node-{i}", kind, content, [raw.id], observed_at=TIME, **kwargs)
    store.add_node(scope, node)
    Formation(store).index(scope, [store.node(scope, node.id)])
    return node.id


def test_T01_fact_and_evidence_retrievable(store):
    node_id = memory(store)
    result = Recall(store).search(SCOPE, "微信幂等")
    assert result["hits"][0]["node"]["id"] == node_id
    assert result["hits"][0]["evidence"][0]["id"] == "event-1"
    assert store.event(SCOPE, "event-1")["content"] == "微信桥接重复消息需要幂等"


def test_chinese_technical_fts_two_characters(store):
    memory(store)
    assert store.lexical(SCOPE, "幂等")[0][0] == "node-1"
    assert "dsh" in tokenize("中文DSH Compaction")


def test_episode_joins_ten_messages_and_retries(store):
    inputs = [event(i, f"排查 Bug 的步骤 {i}", topic="one-bug") for i in range(1, 11)]
    result = Formation(store).ingest(SCOPE, inputs)
    assert len(result["episode_ids"]) == 1
    episode = store.node(SCOPE, result["episode_ids"][0])
    assert len(episode["source_refs"]) == 10
    assert Formation(store).ingest(SCOPE, inputs)["episode_ids"] == []
    assert store.status(SCOPE)["events"] == 10


def test_event_collision_does_not_overwrite(store):
    raw = event()
    store.add_event(SCOPE, raw)
    with pytest.raises(MemoryError, match="event-idempotency-conflict"):
        store.add_event(SCOPE, replace(raw, content="different"))
    assert store.event(SCOPE, raw.id)["content"] == raw.content


def test_sequence_collision_rolls_back_whole_ingest(store):
    with pytest.raises(MemoryError, match="event-sequence-conflict"):
        Formation(store).ingest(SCOPE, [event(), replace(event(2), seq=1)])
    assert store.status(SCOPE)["events"] == 0


def test_T02_aware_time_and_future_filter(store):
    memory(store, valid_from="2026-10-24T09:00:00+08:00")
    result = Recall(store).search(SCOPE, "微信", at="2026-10-24T00:00:00Z")
    assert not result["hits"] and result["filtered"][0]["reason"] == "future"
    assert Recall(store).search(SCOPE, "微信", at="2026-10-24T02:00:00Z")["hits"]
    with pytest.raises(MemoryError, match="timezone-required"):
        event(observed_at="2026-10-24T00:00:00").to_dict()


@pytest.mark.parametrize("strategy", ["bfs", "ppr"])
def test_T03_T04_T13_multi_hop_explanations(store, strategy):
    a = memory(store, 1, "anchoruniqueword")
    b = memory(store, 2, "middle event")
    c = memory(store, 3, "idempotency design")
    store.add_edge(SCOPE, a, b, "related_to", ["event-1", "event-2"], weight=1, confidence=1)
    store.add_edge(SCOPE, b, c, "learned_from", ["event-2", "event-3"], weight=1, confidence=1)
    result = Recall(store).search(SCOPE, "anchoruniqueword", strategy=strategy, k=3, budget=RecallBudget(seeds=1))
    hit = next(h for h in result["hits"] if h["node"]["id"] == c)
    assert [p["relation_type"] for p in hit["path"]] == ["related_to", "learned_from"]
    assert hit["evidence_confidence"] == .5 and hit["temporal_validity"] == "current"
    if strategy == "ppr":
        assert sum(h["relevance"] for h in result["hits"]) == pytest.approx(1)


def test_direction_and_relation_filter(store):
    a, b = memory(store, 1, "anchoruniqueword"), memory(store, 2, "middle event")
    store.add_edge(SCOPE, a, b, "supports", ["event-1"])
    assert not store.neighbors(SCOPE, b)
    result = Recall(store).search(SCOPE, "anchoruniqueword", strategy="ppr", k=3, budget=RecallBudget(seeds=1), relations={"part_of"})
    assert result["visited"] == 1


def test_T05_T06_supersession_current_and_history(store):
    old, new = event(1, "服务端口 3099"), event(2, "服务端口 3100", observed_at="2026-10-24T02:00:00Z")
    store.add_event(SCOPE, old)
    store.add_event(SCOPE, new)
    f = Formation(store)
    old_id = f.fact(SCOPE, old.content, [old.id], fact_key="port", valid_from="2026-10-23T00:00:00Z")
    new_id = f.fact(SCOPE, new.content, [new.id], fact_key="port", valid_from="2026-10-24T02:00:00Z")
    f.supersede(SCOPE, old_id, new_id, expected_version=1)
    result = Recall(store).search(SCOPE, "服务端口", at="2026-10-24T03:00:00Z")
    assert [h["node"]["id"] for h in result["hits"]] == [new_id]
    assert old_id in [x["id"] for x in result["filtered"]]
    historical = Recall(store).search(SCOPE, "服务端口", at="2026-10-24T03:00:00Z", include_history=True)
    assert old_id in [h["node"]["id"] for h in historical["hits"]]
    assert store.event(SCOPE, old.id)["content"] == old.content


def test_inference_cannot_retire_verified_fact(store):
    store.add_event(SCOPE, event(1))
    store.add_event(SCOPE, event(2, source_kind="hypothesis"))
    f = Formation(store)
    old_id = f.fact(SCOPE, "old", ["event-1"], fact_key="x", valid_from="2026-10-20T00:00:00Z")
    new_id = f.fact(SCOPE, "guess", ["event-2"], fact_key="x", valid_from="2026-10-24T00:00:00Z")
    with pytest.raises(MemoryError, match="reliable-new"):
        f.supersede(SCOPE, old_id, new_id, expected_version=1)


def test_version_history_undo_and_optimistic_lock(store):
    node_id = memory(store)
    changed = store.evolve(SCOPE, node_id, 1, {"summary": "更正解释"}, ["event-1"], "new-evidence")
    assert changed["version"] == 2
    with pytest.raises(MemoryError, match="version-conflict"):
        store.evolve(SCOPE, node_id, 1, {"summary": "stale"}, ["event-1"], "stale")
    undone = store.undo(SCOPE, node_id, 1, 2, "undo-wrong-explanation")
    assert undone["version"] == 3 and undone["summary"] == ""
    assert len(store.history(SCOPE, node_id)) == 3
    assert store.status(SCOPE)["embeddings"] == 0  # changed text invalidates old vector


def test_T12_scope_blocks_nodes_evidence_edges_and_lexical_statistics(store):
    node_id = memory(store)
    other = replace(SCOPE, user_id="user-b")
    before = store.lexical(SCOPE, "微信幂等")
    foreign = memory(store, 1, "微信 " * 100, scope=other)
    assert store.lexical(SCOPE, "微信幂等") == before
    assert not Recall(store).search(replace(SCOPE, workspace_id="elsewhere"), "微信")["hits"]
    with pytest.raises(MemoryError):
        store.event(other, "missing")
    with pytest.raises(MemoryError):
        store.add_node(other, Node("leak", "Fact", "leak", ["missing"]))
    private_a = memory(store, 2, "A only")
    with pytest.raises(MemoryError):
        store.add_edge(other, foreign, private_a, "related_to", ["event-1"])
    assert store.neighbors(SCOPE, node_id) == []


def test_ppr_dangling_cycles_and_hub_budget_T14(store):
    root = memory(store, 1, "uniqueanchor")
    for i in range(2, 30):
        node_id = memory(store, i, f"unrelated {i}")
        store.add_edge(SCOPE, root, node_id, "related_to", ["event-1"], weight=1)
        store.add_edge(SCOPE, node_id, root, "related_to", [f"event-{i}"], weight=1)
    budget = RecallBudget(seeds=1, max_nodes=5, fanout=3, iterations=15)
    result = Recall(store).search(SCOPE, "uniqueanchor", strategy="ppr", budget=budget, k=10)
    assert result["visited"] <= 5 and len(result["hits"]) <= 5
    assert sum(h["relevance"] for h in result["hits"]) == pytest.approx(1)


def test_operation_budget_and_context_bytes(store):
    memory(store)
    result = Recall(store).search(SCOPE, "微信", budget=RecallBudget(max_operations=1))
    assert result["truncated"] == "operations" and result["operations"] <= 1
    assert Recall(store).context(SCOPE, "微信", byte_budget=2)["text"] == ""


def test_embedding_spaces_do_not_mix_and_rebuild(store):
    node_id = memory(store)
    different = HashEmbedding(128)
    assert store.vectors(SCOPE, different.space) == []
    assert store.rebuild_index(SCOPE, different) == 1
    assert store.vectors(SCOPE, HashEmbedding().space) == []
    assert store.vectors(SCOPE, different.space)[0][0] == node_id
    assert Recall(store, different).search(SCOPE, "微信")["hits"]


def test_corrupt_index_rebuild_without_extraction(store):
    memory(store)
    store.db.execute("UPDATE embeddings SET vector=x'00'")
    with pytest.raises(MemoryError, match="corrupt-embedding"):
        store.vectors(SCOPE, HashEmbedding().space)
    store.rebuild_index(SCOPE, HashEmbedding())
    assert Recall(store).search(SCOPE, "微信")["hits"]


def test_provider_failure_rolls_back_events_and_watermark(store):
    class Failed:
        space = HashEmbedding().space
        def embed(self, texts):
            raise RuntimeError("synthetic-provider-failure")
    with pytest.raises(RuntimeError):
        Formation(store, Failed()).ingest(SCOPE, [event()])
    assert store.status(SCOPE)["events"] == 0
    assert store.watermark(SCOPE, "formation") == -1


def test_T07_checkpoint_evidence_and_exact_state(store):
    inputs = [event(1, "端口必须为 3099", source_kind="user_statement", metadata={"exact_parameters": {"port": 3099, "path": "src/bridge.js"}, "task_state": {"next": "验证幂等"}}), event(2, "操作完成")]
    engine = CognitiveCompaction(store)
    prepared = engine.prepare(SCOPE, inputs)
    checkpoint = prepared["checkpoint"]
    assert checkpoint["exact_parameters"]["event-1"]["port"] == 3099
    assert checkpoint["critical_evidence"][0]["content"] == inputs[0].content
    assert checkpoint["recent_messages_preserved"]
    for ref in checkpoint["long_memory_refs"]:
        assert store.node(SCOPE, ref)["source_refs"]
    assert engine.prepare(SCOPE, inputs) == prepared
    ack = engine.acknowledge(SCOPE, prepared["receipt_id"], session_id=SCOPE.session_id, compaction_id="compact-1", snapshot_digest=prepared["snapshot_digest"])
    assert ack["state"] == "dsh-committed"


def test_checkpoint_budget_fails_before_history_loss(store):
    with pytest.raises(MemoryError, match="checkpoint-budget"):
        CognitiveCompaction(store).prepare(SCOPE, [event()], checkpoint_bytes=1)
    assert store.status(SCOPE)["events"] == 0


def test_unfinished_tool_and_invalid_snapshot_rejected(store):
    call = event(1, metadata={"kind": "tool_call", "call_id": "call-1"})
    with pytest.raises(MemoryError, match="unfinished-tool"):
        CognitiveCompaction(store).prepare(SCOPE, [call])
    with pytest.raises(MemoryError, match="snapshot-digest"):
        validate_snapshot({"schema": "dsf-mnn-snapshot/1", "session_id": SCOPE.session_id, "events": [event().to_dict()], "digest": "wrong"}, SCOPE)
    result = event(2, metadata={"kind": "tool_result", "call_id": "call-1"})
    assert CognitiveCompaction(store).prepare(SCOPE, [call, result])["state"] == "prepared"


def test_T08_dreaming_goal_carryover_and_noop_T10(store):
    Formation(store).ingest(SCOPE, [event()])
    GoalState(store).create(SCOPE, "goal-1", "继续排查幂等", ["event-1"], next_actions=["测试超时"])
    d = Dreaming(store)
    assert d.tick(SCOPE, at="2026-10-24T03:00:00+08:00", idle=False)["state"] == "deferred"
    first = d.tick(SCOPE, at="2026-10-24T03:00:00+08:00", idle=True)
    assert first["carryover_refs"] == ["goal-1"] and first["self_reflection"] == "noop"
    assert d.tick(SCOPE, at="2026-10-24T04:00:00+08:00", idle=True) == first
    next_day = d.tick(SCOPE, at="2026-10-25T03:00:00+08:00", idle=True)
    assert next_day["state"] == "noop" and next_day["carryover_refs"] == ["goal-1"]
    assert SelfProjection(store).current(SCOPE) is None


def test_daily_idle_watermark_and_fixed_snapshot(store):
    store.add_event(SCOPE, event())
    daily = Dreaming(store)
    assert daily.daily(SCOPE, at="2026-10-23T10:14:00+08:00", last_interaction=TIME, idle=True)["state"] == "deferred"
    assert daily.daily(SCOPE, at="2026-10-23T10:16:00+08:00", last_interaction=TIME, idle=True)["state"] == "completed"
    assert daily.daily(SCOPE, at="2026-10-23T10:17:00+08:00", last_interaction=TIME, idle=True)["state"] == "noop"
    store.add_event(SCOPE, event(2))
    assert Formation(store).ingest(SCOPE, [], through=1)["episode_ids"] == []
    assert Formation(store).ingest(SCOPE, [], through=2)["episode_ids"]


def test_dreaming_concurrent_process_connections(tmp_path):
    database = tmp_path / "parallel.sqlite"
    with MemoryStore(database) as s:
        Formation(s).ingest(SCOPE, [event()])
    def run():
        with MemoryStore(database) as s:
            return Dreaming(s).tick(SCOPE, at="2026-10-24T04:00:00+08:00", idle=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        left, right = list(pool.map(lambda _: run(), range(2)))
    assert left == right
    with MemoryStore(database) as s:
        assert s.status(SCOPE)["metrics"]["dreaming_runs"] == 1


def test_T09_self_projection_evidence_noop_and_privilege_rejection(store):
    projection = SelfProjection(store)
    assert projection.update(SCOPE, {}, [], reason="nothing") == {"state": "noop"}
    with pytest.raises(MemoryError, match="fields-rejected"):
        projection.update(SCOPE, {"permissions": ["all"]}, [], reason="bad")
    raw1 = event(1, metadata={"agent_experience": True})
    raw2 = event(2, observed_at="2026-10-24T10:00:00+08:00", metadata={"agent_experience": True})
    store.add_event(SCOPE, raw1)
    store.add_event(SCOPE, raw2)
    with pytest.raises(MemoryError, match="independent-days"):
        projection.update(SCOPE, {"traits": ["checks evidence"]}, [raw1.id], reason="one day")
    result = projection.update(SCOPE, {"traits": ["checks evidence"]}, [raw1.id, raw2.id], reason="verified repeated actions")
    assert result["version"] == 1
    assert projection.update(SCOPE, {"open_questions": ["more evidence?"]}, [raw2.id], expected_version=1, reason="review")["version"] == 2


def test_self_rejects_creative_external_and_unconfirmed_data(store):
    for i, kind in enumerate(["creative", "external", "reflection", "user_statement"], 1):
        raw = event(i, source_kind=kind, metadata={"agent_experience": True})
        store.add_event(SCOPE, raw)
        with pytest.raises(MemoryError, match="experienced-verified"):
            SelfProjection(store).update(SCOPE, {"narrative": ["made up"]}, [raw.id], reason="test")


def test_T11_backup_restore_restart_and_json_migration(store, tmp_path):
    node_id = memory(store)
    store.evolve(SCOPE, node_id, 1, {"metadata": {"layer": "long_term"}}, ["event-1"], "test")
    backup, restored = tmp_path / "backup.sqlite", tmp_path / "restored.sqlite"
    assert store.backup(backup)["verified"]
    with pytest.raises(MemoryError, match="target-exists"):
        store.backup(backup)
    MemoryStore.restore(backup, restored)
    with MemoryStore(restored) as other:
        assert Recall(other).search(SCOPE, "微信")["hits"]
    package = export_scope(store, SCOPE)
    with MemoryStore(tmp_path / "import.sqlite") as imported:
        imported_scope = import_scope(imported, package, HashEmbedding())
        assert imported.node(imported_scope, node_id) == store.node(SCOPE, node_id)
        assert imported.history(SCOPE, node_id) == store.history(SCOPE, node_id)
        with pytest.raises(MemoryError, match="empty-scope"):
            import_scope(imported, package, HashEmbedding())


def test_json_import_tampering_fails(store, tmp_path):
    memory(store)
    package = export_scope(store, SCOPE)
    package["body"]["events"][0]["content"] = "tampered"
    with MemoryStore(tmp_path / "new.sqlite") as target:
        with pytest.raises(MemoryError, match="integrity"):
            import_scope(target, package, HashEmbedding())


def test_interrupted_write_recovers_WAL(tmp_path):
    database = tmp_path / "crash.sqlite"
    with MemoryStore(database) as s:
        memory(s)
    script = """
import os,sys
from dsf_mnn import MemoryStore,Scope
s=MemoryStore(sys.argv[1])
s.db.execute('BEGIN IMMEDIATE')
s.db.execute('DELETE FROM nodes')
os._exit(9)
"""
    result = subprocess.run([sys.executable, "-c", script, str(database)], capture_output=True)
    assert result.returncode == 9
    with MemoryStore(database) as s:
        assert Recall(s).search(SCOPE, "微信")["hits"]
        assert s.db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_forget_propagates_to_history_index_receipts_and_self(store):
    node_id = memory(store)
    raw2 = event(2, metadata={"agent_experience": True})
    store.add_event(SCOPE, raw2)
    store.evolve(SCOPE, node_id, 1, {"summary": "new evidence"}, [raw2.id], "evolution")
    SelfProjection(store).update(SCOPE, {"narrative": ["learned"]}, [raw2.id], reason="verified experience")
    store.save_receipt(SCOPE, "test", "test", "digest", {"text": "copy"})
    assert store.forget_event(SCOPE, raw2.id) == 2
    assert store.status(SCOPE)["nodes"] == 0
    assert store.status(SCOPE)["embeddings"] == 0
    assert store.status(SCOPE)["receipts"] == 0
    assert store.lexical(SCOPE, "微信") == []


def test_association_cheap_noop_and_idempotency(store):
    store.add_event(SCOPE, event())
    association = SpontaneousAssociation(store, Recall(store))
    cue = AssociationCue("plain", "hello", ("event-1",), "input")
    result = association.consider(SCOPE, cue)
    assert result["state"] == "noop" and not result["explored"]
    assert association.consider(SCOPE, cue) == result
    assert store.status(SCOPE)["metrics"]["association_deep_calls"] == 0


def test_association_proposes_then_validates_same_graph(store):
    anchor = memory(store, 1, "微信消息超时幂等处理")
    target = memory(store, 2, "项目经历：微信超时需要幂等")
    a = SpontaneousAssociation(store, Recall(store))
    cue = AssociationCue("tool-cue", "微信消息超时幂等处理", ("event-1",), "tool_result", anchor)
    result = a.consider(SCOPE, cue, budget=RecallBudget(seeds=3, deadline_ms=3000))
    assert result["state"] == "proposed" and result["explored"]
    assert store.status(SCOPE)["edges"] == 0
    with pytest.raises(MemoryError, match="not-validated"):
        a.accept(SCOPE, cue.id, 0, validator=lambda p, e: False)
    edge = a.accept(SCOPE, cue.id, 0, validator=lambda p, e: all(x["source_kind"] == "tool_verified" for x in e))
    assert edge["relation_type"] == "related_to" and edge["inference"]
    assert store.neighbors(SCOPE, anchor)[0]["target_id"] == target


def test_association_rejects_stale_and_foreign_cue(store):
    anchor = memory(store, 1, "微信超时幂等")
    target = memory(store, 2, "微信幂等设计")
    a = SpontaneousAssociation(store, Recall(store))
    cue = AssociationCue("stale", "微信超时幂等", ("event-1",), "reading", anchor)
    assert a.consider(SCOPE, cue, budget=RecallBudget(deadline_ms=3000))["proposals"]
    store.evolve(SCOPE, target, 1, {"confidence": .6}, ["event-2"], "new evidence")
    with pytest.raises(MemoryError, match="stale-proposal"):
        a.accept(SCOPE, cue.id, 0, validator=lambda *_: True)
    with pytest.raises(MemoryError, match="evidence-unavailable"):
        a.consider(replace(SCOPE, user_id="other"), cue)


def test_unknown_schema_rejected_without_migration(tmp_path):
    database = tmp_path / "future.sqlite"
    with MemoryStore(database) as s:
        s.db.execute("UPDATE meta SET value='999' WHERE key='schema_version'")
    with pytest.raises(MemoryError, match="unsupported-schema"):
        MemoryStore(database)
