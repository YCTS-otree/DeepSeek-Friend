"""Bounded voluntary recall API. Authorization is bound by the host, not tool arguments."""
from .model import MemoryError, canonical
from .recall import Recall, RecallBudget


class MemoryTools:
    def __init__(self, store, scope, provider=None, *, byte_budget=8192):
        if byte_budget <= 0:
            raise MemoryError("invalid-tool-budget")
        self.store, self.scope = store, scope
        self.recall = Recall(store, provider)
        self.byte_budget = byte_budget

    def _bounded(self, value):
        if len(canonical(value).encode("utf-8")) > self.byte_budget:
            raise MemoryError("tool-result-budget-exceeded-use-narrower-query")
        return value

    def memory_recall(self, query):
        return self.recall.context(self.scope, query, byte_budget=self.byte_budget)

    def memory_search(self, query):
        result = self.recall.search(self.scope, query)
        rows = [{"id": h["node"]["id"], "type": h["node"]["type"], "summary": h["node"]["summary"] or h["node"]["content"][:240],
                 "source_refs": h["node"]["source_refs"], "relevance": h["relevance"], "evidence_confidence": h["evidence_confidence"],
                 "temporal_validity": h["temporal_validity"], "path": h["path"]} for h in result["hits"]]
        return self._bounded({"untrusted_memory_data": True, "hits": rows})

    def memory_get_episode(self, node_id):
        node = self.store.node(self.scope, node_id)
        if node["type"] != "Episode":
            raise MemoryError("episode-required")
        return self._bounded({"untrusted_memory_data": True, "episode": node})

    def memory_get_evidence(self, event_id):
        return self._bounded({"untrusted_memory_data": True, "event": self.store.event(self.scope, event_id)})

    def memory_get_related(self, node_id, *, relations=None):
        edges = self.store.neighbors(self.scope, node_id, limit=16, relations=relations)
        return self._bounded({"untrusted_memory_data": True, "edges": edges})

    def memory_trace_relation(self, source_id, target_id, *, max_hops=2):
        if not 0 <= max_hops <= 4:
            raise MemoryError("invalid-trace-depth")
        self.store.node(self.scope, source_id)
        self.store.node(self.scope, target_id)
        frontier, seen = [(source_id, [])], {source_id}
        for _ in range(max_hops):
            following = []
            for node_id, path in frontier:
                for edge in self.store.neighbors(self.scope, node_id, limit=16):
                    candidate = path + [edge]
                    if edge["target_id"] == target_id:
                        return self._bounded({"path": candidate, "untrusted_memory_data": True})
                    if edge["target_id"] not in seen and len(seen) < 64:
                        seen.add(edge["target_id"])
                        following.append((edge["target_id"], candidate))
            frontier = following
        return {"path": [], "state": "no-path-within-budget"}

    def memory_get_timeline(self, *, after=None, before=None):
        rows = [{"id": n["id"], "observed_at": n["observed_at"], "valid_from": n["valid_from"], "valid_to": n["valid_to"], "status": n["status"], "source_refs": n["source_refs"]}
                for n in self.store.nodes(self.scope) if n["observed_at"] and (after is None or n["observed_at"] >= after) and (before is None or n["observed_at"] <= before)]
        return self._bounded({"timeline": sorted(rows, key=lambda n: (n["observed_at"], n["id"]))[:32]})

    def memory_explore(self, query, *, max_hops=2):
        result = self.recall.search(self.scope, query, strategy="ppr", budget=RecallBudget(max_hops=max_hops, max_nodes=64))
        return self._bounded({"seeds": result["seeds"], "paths": [{"id": h["node"]["id"], "path": h["path"]} for h in result["hits"]], "truncated": result["truncated"]})
