from __future__ import annotations

from dataclasses import asdict, dataclass
import time

from .embedding import tokenize
from .model import MemoryError, digest
from .recall import RecallBudget


@dataclass(frozen=True)
class AssociationCue:
    id: str
    content: str
    source_refs: tuple[str, ...]
    trigger: str  # input, tool_result, reading, goal, dreaming
    anchor_id: str | None = None


class SpontaneousAssociation:
    """One memory graph, cheap lexical gate, explicit proposals, no external actions."""

    def __init__(self, store, recall, *, minimum_overlap=2):
        self.store, self.recall = store, recall
        self.minimum_overlap = minimum_overlap

    def consider(self, scope, cue: AssociationCue, *, budget=None):
        if cue.trigger not in {"input", "tool_result", "reading", "goal", "dreaming"} or not cue.id:
            raise MemoryError("invalid-association-cue")
        budget = budget or RecallBudget(seeds=3, max_nodes=32, max_hops=2, iterations=12, max_operations=200000, deadline_ms=100, context_bytes=2048)
        start = time.perf_counter()
        fingerprint = digest([asdict(cue), asdict(budget)])
        receipt_id = "association:" + cue.id
        with self.store.transaction():
            old = self.store.receipt(scope, receipt_id)
            if old:
                if old["digest"] != fingerprint:
                    raise MemoryError("association-idempotency-conflict")
                return old["body"]
            self.store._sources(scope, list(cue.source_refs))
            anchor = self.store.node(scope, cue.anchor_id) if cue.anchor_id else None
            if anchor and not set(cue.source_refs) <= set(anchor["source_refs"]):
                raise MemoryError("cue-anchor-evidence-mismatch")
            if len(cue.content.encode("utf-8")) > 16384:
                raise MemoryError("association-cue-too-large")
            terms = set(tokenize(cue.content))
            candidates = self.recall.search(scope, cue.content, strategy="lexical", k=min(10, budget.seeds), budget=budget)
            valuable = [h for h in candidates["hits"] if h["node"]["id"] != cue.anchor_id and len(terms & set(tokenize(h["node"]["content"]))) >= self.minimum_overlap
                        and set(h["node"]["source_refs"]) - set(cue.source_refs)]
            remaining_ms = budget.deadline_ms - (time.perf_counter() - start) * 1000
            proposals = []
            reason = "no-valuable-cue"
            exploration = None
            remaining_operations = budget.max_operations - candidates["operations"]
            if valuable and remaining_ms > 0 and remaining_operations > 0 and budget.context_bytes > 0 and not candidates["truncated"]:
                deep_budget = RecallBudget(**{**asdict(budget), "deadline_ms": remaining_ms, "max_operations": remaining_operations})
                exploration = self.recall.search(scope, cue.content, strategy="ppr", k=min(10, budget.seeds * 2), budget=deep_budget)
                used_bytes = 0
                for hit in exploration["hits"]:
                    target = hit["node"]
                    if target["id"] == cue.anchor_id or not (set(target["source_refs"]) - set(cue.source_refs)):
                        continue
                    proposal = {"source_id": cue.anchor_id, "target_id": target["id"], "relation_type": "related_to", "inference": True,
                                "evidence_refs": list(dict.fromkeys(list(cue.source_refs) + target["source_refs"])), "status": "proposed",
                                "reason": "potential-association-requires-verification", "target_version": target["version"],
                                "source_version": anchor["version"] if anchor else None}
                    from .model import canonical
                    size = len(canonical(proposal).encode("utf-8"))
                    if used_bytes + size <= budget.context_bytes:
                        proposals.append(proposal)
                        used_bytes += size
                reason = "candidates-require-validation" if proposals else "budget-or-no-new-connection"
            elif valuable:
                reason = "budget-exhausted"
            result = {"state": "proposed" if proposals else "noop", "reason": reason, "proposals": proposals,
                      "explored": exploration is not None, "trigger": cue.trigger,
                      "operations": candidates["operations"] + (exploration["operations"] if exploration else 0), "truncated": (exploration or candidates)["truncated"]}
            self.store.count(scope, "association_cues")
            self.store.count(scope, "association_deep_calls", int(exploration is not None))
            return self.store.save_receipt(scope, receipt_id, "association", fingerprint, result)

    def accept(self, scope, cue_id, index, *, validator):
        """validator is a trusted application callback, never a model-supplied Boolean."""
        with self.store.transaction():
            receipt = self.store.receipt(scope, "association:" + cue_id)
            if not receipt or receipt["kind"] != "association" or not 0 <= index < len(receipt["body"]["proposals"]):
                raise MemoryError("association-proposal-unavailable")
            proposal = receipt["body"]["proposals"][index]
            if not proposal["source_id"]:
                raise MemoryError("persisted-anchor-required")
            source = self.store.node(scope, proposal["source_id"])
            target = self.store.node(scope, proposal["target_id"])
            if source["version"] != proposal["source_version"] or target["version"] != proposal["target_version"]:
                raise MemoryError("association-stale-proposal")
            evidence = [self.store.event(scope, r) for r in proposal["evidence_refs"]]
            if validator(proposal, evidence) is not True:
                raise MemoryError("association-evidence-not-validated")
            return self.store.add_edge(scope, source["id"], target["id"], "related_to", proposal["evidence_refs"], inference=True)
