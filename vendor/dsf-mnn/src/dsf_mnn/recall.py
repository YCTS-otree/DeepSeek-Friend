from __future__ import annotations

from dataclasses import dataclass
import math
import time

from .embedding import HashEmbedding, normalize
from .model import MemoryError, now, timestamp


@dataclass(frozen=True)
class RecallBudget:
    seeds: int = 8
    max_nodes: int = 128
    max_hops: int = 2
    fanout: int = 16
    iterations: int = 30
    deadline_ms: float = 1000
    max_operations: int = 10000000
    context_bytes: int = 4096

    def __post_init__(self):
        if not (1 <= self.seeds <= self.max_nodes <= 2048 and 0 <= self.max_hops <= 8 and 1 <= self.fanout <= 128 and 1 <= self.iterations <= 200):
            raise MemoryError("invalid-recall-budget")
        if not math.isfinite(self.deadline_ms) or not 0 < self.deadline_ms <= 60000 or not 0 < self.max_operations <= 1000000000 or self.context_bytes < 0:
            raise MemoryError("invalid-recall-budget")


class Meter:
    def __init__(self, budget):
        self.start = time.perf_counter()
        self.budget = budget
        self.operations = 0
        self.reason = None

    def spend(self, amount=1):
        if self.reason:
            return False
        if self.operations + amount > self.budget.max_operations:
            self.reason = "operations"
        elif (time.perf_counter() - self.start) * 1000 >= self.budget.deadline_ms:
            self.reason = "deadline"
        if self.reason:
            return False
        self.operations += amount
        return True


def validity(node, at):
    if node["valid_from"] and node["valid_from"] > at:
        return "future"
    if node["valid_to"] and node["valid_to"] <= at:
        return "expired"
    return "current" if node["status"] == "active" else node["status"]


class Recall:
    def __init__(self, store, provider=None):
        self.store, self.provider = store, provider or HashEmbedding()

    def search(self, scope, query, *, strategy="hybrid", k=5, budget=None, at=None, include_history=False, min_confidence=0,
               relations=None, alpha=.65):
        if strategy not in {"vector", "hybrid", "bfs", "ppr", "lexical"} or not 1 <= k <= 100 or not 0 <= alpha < 1 or not 0 <= min_confidence <= 1:
            raise MemoryError("invalid-recall-options")
        if not isinstance(query, str) or len(query.encode("utf-8")) > 65536:
            raise MemoryError("query-too-large")
        budget = budget or RecallBudget()
        meter = Meter(budget)
        at = timestamp(at or now())
        # Authorization is applied by SQL before any corpus/vector/adjacency is exposed.
        nodes = {n["id"]: n for n in self.store.nodes(scope)}
        filtered = [{"id": n["id"], "reason": validity(n, at)} for n in nodes.values() if validity(n, at) != "current"]
        allowed = {i: n for i, n in nodes.items() if n["confidence"] >= min_confidence and (include_history or validity(n, at) == "current")}
        if not query.strip() or not allowed:
            return {"hits": [], "seeds": [], "filtered": filtered, "operations": 0, "truncated": None, "latency_ms": (time.perf_counter() - meter.start) * 1000}
        vectors = []
        if strategy != "lexical":
            query_vector = normalize(self.provider.embed([query])[0], self.provider.space.dimension)
            for node_id, vector in self.store.vectors(scope, self.provider.space):
                if node_id not in allowed:
                    continue
                if not meter.spend(len(vector)):
                    break
                score = sum(x * y for x, y in zip(query_vector, vector))
                if score > 0:
                    vectors.append((node_id, score))
            vectors.sort(key=lambda row: (-row[1], row[0]))
        lexical = [] if strategy == "vector" or meter.reason else self.store.lexical(scope, query, max(32, budget.seeds * 4), allowed_ids=allowed, meter=meter)
        scores = {}
        lists = [vectors] if strategy == "vector" else [lexical] if strategy == "lexical" else [vectors, lexical]
        for ranking in lists:
            for rank, (node_id, _) in enumerate(ranking[:budget.seeds * 4], 1):
                scores[node_id] = scores.get(node_id, 0) + 1 / (60 + rank)
        seeds = sorted(scores, key=lambda i: (-scores[i], i))[:budget.seeds]
        total = sum(scores[i] for i in seeds)
        reset = {i: scores[i] / total for i in seeds} if total else {}
        active = dict(reset)
        paths = {i: [] for i in seeds}
        adjacency = {}
        visited = set(seeds)
        frontier = list(seeds)
        if strategy in {"bfs", "ppr"}:
            for _ in range(budget.max_hops):
                following = []
                for node_id in frontier:
                    adjacency[node_id] = []
                    for edge in self.store.neighbors(scope, node_id, limit=budget.fanout, relations=relations):
                        if not meter.spend():
                            break
                        target = edge["target_id"]
                        if target not in allowed:
                            continue
                        # Contradictions/supersession are historical evidence, not positive reinforcement.
                        if edge["relation_type"] in {"contradicts", "supersedes"} and not include_history:
                            continue
                        weight = edge["weight"] * edge["confidence"]
                        if weight <= 0:
                            continue
                        if target not in visited:
                            if len(visited) >= budget.max_nodes:
                                continue
                            visited.add(target)
                            following.append(target)
                            paths[target] = paths[node_id] + [{"source_id": node_id, "target_id": target, "relation_type": edge["relation_type"], "inference": edge["inference"], "evidence_refs": edge["evidence_refs"]}]
                        if weight > 0:
                            adjacency[node_id].append((target, weight))
                            if strategy == "bfs":
                                active[target] = max(active.get(target, 0), active.get(node_id, 0) * alpha * weight)
                frontier = following
                if not frontier or meter.reason:
                    break
            if strategy == "ppr" and reset:
                for _ in range(budget.iterations):
                    new = {i: (1 - alpha) * reset.get(i, 0) for i in visited}
                    dangling = 0.0
                    for source in visited:
                        neighbors = adjacency.get(source, [])
                        denom = sum(w for _, w in neighbors)
                        if not denom:
                            dangling += active.get(source, 0)
                            continue
                        for target, weight in neighbors:
                            if not meter.spend():
                                break
                            new[target] += alpha * active.get(source, 0) * weight / denom
                    if meter.reason:
                        break
                    for node_id, weight in reset.items():
                        new[node_id] += alpha * dangling * weight
                    delta = sum(abs(new[i] - active.get(i, 0)) for i in visited)
                    active = new
                    if delta < 1e-8:
                        break
        hits = []
        for node_id in sorted(active, key=lambda i: (-active[i], i))[:k]:
            node = allowed[node_id]
            evidence = [self.store.event(scope, r) for r in node["source_refs"]]
            hits.append({"node": node, "relevance": active[node_id], "evidence_confidence": node["confidence"], "temporal_validity": validity(node, at),
                         "path": paths.get(node_id, []), "evidence": [{"id": e["id"], "source_uri": e["source_uri"], "source_kind": e["source_kind"], "observed_at": e["observed_at"]} for e in evidence]})
        latency = (time.perf_counter() - meter.start) * 1000
        self.store.count(scope, "retrieval_calls")
        self.store.count(scope, "retrieval_ms", latency)
        return {"hits": hits, "seeds": [{"id": i, "activation": reset[i]} for i in seeds], "filtered": filtered,
                "operations": meter.operations, "truncated": meter.reason, "latency_ms": latency, "visited": len(visited),
                "embedding_space": self.provider.space.key, "strategy": strategy}

    def context(self, scope, query, *, byte_budget=4096, **options):
        from .model import canonical
        if byte_budget < 0:
            raise MemoryError("invalid-context-budget")
        result = self.search(scope, query, **options)
        text = ""
        for hit in result["hits"]:
            node = hit["node"]
            line = canonical({"untrusted_memory_data": True, "id": node["id"], "content": node["content"], "source_refs": node["source_refs"], "epistemic": node["metadata"].get("epistemic"), "temporal_validity": hit["temporal_validity"]}) + "\n"
            if len((text + line).encode("utf-8")) <= byte_budget:
                text += line
        return {"text": text, "bytes": len(text.encode("utf-8")), "token_estimate_upper_bound": len(text.encode("utf-8")), "budget_unit": "utf8-bytes"}
