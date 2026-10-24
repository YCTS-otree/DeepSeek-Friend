import pytest

from dsf_mnn import Event, MemoryStore, Scope
from dsf_mnn.compaction import CognitiveCompaction
from dsf_mnn.formation import Formation
from dsf_mnn.embedding import HashEmbedding
from dsf_mnn.model import MemoryError
from dsf_mnn.tools import MemoryTools


S = Scope("agent", "u", "s", "w")


def test_voluntary_tools_use_same_graph_and_bound_evidence(tmp_path):
    with MemoryStore(tmp_path / "tools.sqlite") as store:
        raw = Event("e", 1, "微信幂等处理", "2026-10-24T01:00:00Z", "tool_verified", "synthetic://1")
        result = Formation(store).ingest(S, [raw])
        tools = MemoryTools(store, S)
        episode = result["episode_ids"][0]
        assert tools.memory_get_episode(episode)["episode"]["source_refs"] == ["e"]
        assert tools.memory_search("微信")["hits"][0]["id"] == episode
        assert "微信" in tools.memory_recall("微信")["text"]
        assert tools.memory_explore("微信")["seeds"]
        assert tools.memory_get_timeline()["timeline"]
        assert tools.memory_get_evidence("e")["event"]["content"] == raw.content
        with pytest.raises(MemoryError, match="budget"):
            MemoryTools(store, S, byte_budget=1).memory_get_evidence("e")


def test_recent_tail_extends_to_complete_tool_pair(tmp_path):
    def raw(i, kind, call=None):
        return Event(str(i), i, kind, "2026-10-24T01:00:00Z", "tool_verified", f"synthetic://{i}", metadata={"kind": kind, "call_id": call})
    with MemoryStore(tmp_path / "tail.sqlite") as store:
        events = [raw(1, "tool_call", "c"), raw(2, "tool_result", "c"), raw(3, "assistant")]
        prepared = CognitiveCompaction(store).prepare(S, events, recent_count=2)
        assert [e["id"] for e in prepared["checkpoint"]["recent_events"]] == ["1", "2", "3"]


def test_prepared_retry_rechecks_index_before_dsh_commit(tmp_path):
    with MemoryStore(tmp_path / "retry.sqlite") as store:
        event = Event("e", 1, "critical", "2026-10-24T01:00:00Z", "tool_verified", "synthetic://1")
        compaction = CognitiveCompaction(store)
        compaction.prepare(S, [event])
        store.rebuild_index(S, HashEmbedding(128))
        with pytest.raises(MemoryError, match="checkpoint-index-unavailable"):
            compaction.prepare(S, [event])
        store.rebuild_index(S, HashEmbedding())
        assert compaction.prepare(S, [event])["state"] == "prepared"
