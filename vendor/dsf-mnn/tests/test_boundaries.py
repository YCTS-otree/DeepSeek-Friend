from dataclasses import replace
import pytest

from dsf_mnn import Event, MemoryStore, Node, Scope
from dsf_mnn.association import AssociationCue, SpontaneousAssociation
from dsf_mnn.embedding import HashEmbedding
from dsf_mnn.formation import Formation
from dsf_mnn.model import MemoryError
from dsf_mnn.recall import Recall, RecallBudget


S = Scope("agent", "u", "s", "w")


def raw(seq, text):
    return Event(str(seq), seq, text, "2026-10-24T00:00:00Z", "tool_verified", f"synthetic://{seq}")


def test_late_unseen_event_and_future_watermark_rejected(tmp_path):
    with MemoryStore(tmp_path / "late.sqlite") as store:
        Formation(store).ingest(S, [raw(2, "processed")])
        with pytest.raises(MemoryError, match="late-event"):
            Formation(store).ingest(S, [raw(1, "late unseen")])
        with pytest.raises(MemoryError, match="beyond-durable"):
            Formation(store).ingest(S, [], through=100)
        assert store.watermark(S, "formation") == 2


def test_zero_weight_edge_is_not_an_association(tmp_path):
    with MemoryStore(tmp_path / "zero.sqlite") as store:
        for i, text in [(1, "uniqueanchor"), (2, "unrelatedtarget")]:
            store.add_event(S, raw(i, text))
            store.add_node(S, Node(str(i), "Fact", text, [str(i)]))
        store.rebuild_index(S, HashEmbedding())
        store.add_edge(S, "1", "2", "related_to", ["1"], weight=0)
        result = Recall(store).search(S, "uniqueanchor", strategy="ppr", k=10, budget=RecallBudget(seeds=1))
        assert result["visited"] == 1


def test_association_total_compute_and_no_automatic_edges(tmp_path):
    with MemoryStore(tmp_path / "budget.sqlite") as store:
        formation = Formation(store)
        formation.ingest(S, [raw(1, "微信消息超时幂等"), raw(2, "微信消息幂等经验")])
        result = SpontaneousAssociation(store, Recall(store)).consider(S, AssociationCue("budget", "微信消息超时幂等", ("1",), "goal"), budget=RecallBudget(max_operations=1))
        assert result["state"] == "noop" and result["operations"] <= 1
        assert store.status(S)["edges"] == 0


def test_current_projection_cites_new_evolution_evidence(tmp_path):
    with MemoryStore(tmp_path / "sources.sqlite") as store:
        store.add_event(S, raw(1, "first"))
        store.add_event(S, raw(2, "new evidence"))
        store.add_node(S, Node("n", "Fact", "original", ["1"]))
        updated = store.evolve(S, "n", 1, {"summary": "new explanation"}, ["2"], "new evidence")
        assert updated["source_refs"] == ["1", "2"]
        assert store.event(S, "1")["content"] == "first"
