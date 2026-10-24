from __future__ import annotations

from datetime import datetime

from .embedding import HashEmbedding, tokenize
from .model import Event, MemoryError, Node, canonical, digest


class Formation:
    """Deterministic offline formation. LLM extraction can supply validated proposals later."""

    def __init__(self, store, provider=None):
        self.store = store
        self.provider = provider or HashEmbedding()

    def index(self, scope, nodes):
        vectors = self.provider.embed([n["content"] + " " + n["summary"] for n in nodes])
        if len(vectors) != len(nodes):
            raise MemoryError("embedding-batch-mismatch")
        for node, vector in zip(nodes, vectors):
            self.store.put_embedding(scope, node["id"], self.provider.space, vector)
        self.store.count(scope, "embedding_items", len(nodes))

    @staticmethod
    def _groups(events):
        groups = []
        for event in events:
            if groups:
                prior = groups[-1][-1]
                elapsed = (datetime.fromisoformat(event["observed_at"]) - datetime.fromisoformat(prior["observed_at"])).total_seconds()
                left, right = set(tokenize(event["content"])), set(tokenize(prior["content"]))
                overlap = len(left & right) / max(1, len(left | right))
                same = event["topic"] == prior["topic"] if event["topic"] or prior["topic"] else overlap >= 0.25
                if same and 0 <= elapsed <= 1800 and len(groups[-1]) < 100:
                    groups[-1].append(event)
                    continue
            groups.append([event])
        return groups

    def ingest(self, scope, events: list[Event], *, through=None):
        with self.store.transaction():
            self.store.register(scope)
            inserted = sum(self.store.add_event(scope, event) for event in events)
            snapshot = self.store.snapshot(scope, self.store.watermark(scope, "formation"), through)
            formed = []
            for group in self._groups(snapshot["events"]):
                refs = [e["id"] for e in group]
                episode = Node("episode_" + digest(refs)[:24], "Episode", "\n".join(e["content"] for e in group), refs,
                               observed_at=group[0]["observed_at"], created_at=group[-1]["observed_at"],
                               metadata={"layer": "daily", "topic": group[0]["topic"], "source_kinds": sorted({e["source_kind"] for e in group}), "extraction": "deterministic-v1"})
                self.store.add_node(scope, episode)
                formed.append(self.store.node(scope, episode.id))
            if formed:
                self.index(scope, formed)
            self.store.advance(scope, "formation", max(self.store.watermark(scope, "formation"), snapshot["through"]))
            self.store.count(scope, "events_inserted", inserted)
            self.store.count(scope, "episodes_formed", len(formed))
            return {"inserted": inserted, "episode_ids": [n["id"] for n in formed], "through": snapshot["through"]}

    def fact(self, scope, content, source_refs, *, fact_key=None, valid_from=None):
        evidence = [self.store.event(scope, ref) for ref in source_refs]
        if not evidence:
            raise MemoryError("evidence-required")
        kinds = {e["source_kind"] for e in evidence}
        epistemic = "verified" if kinds == {"tool_verified"} else "asserted" if kinds <= {"tool_verified", "user_statement"} else "inferred"
        node_id = "fact_" + digest([content, sorted(source_refs), fact_key, valid_from])[:24]
        node = Node(node_id, "Fact", content, source_refs, confidence={"verified": .95, "asserted": .75, "inferred": .35}[epistemic],
                    created_at=max(e["observed_at"] for e in evidence), observed_at=min(e["observed_at"] for e in evidence), valid_from=valid_from,
                    metadata={"epistemic": epistemic, "fact_key": fact_key, "layer": "daily"})
        with self.store.transaction():
            inserted = self.store.add_node(scope, node)
            if inserted:
                self.index(scope, [self.store.node(scope, node_id)])
        return node_id

    def supersede(self, scope, old_id, new_id, *, expected_version):
        with self.store.transaction():
            old, new = self.store.node(scope, old_id), self.store.node(scope, new_id)
            if old["type"] != "Fact" or new["type"] != "Fact" or not old["metadata"].get("fact_key") or old["metadata"].get("fact_key") != new["metadata"].get("fact_key"):
                raise MemoryError("explicit-matching-fact-key-required")
            if new["metadata"]["epistemic"] == "inferred" or not new["valid_from"] or (old["valid_from"] and new["valid_from"] <= old["valid_from"]):
                raise MemoryError("reliable-new-effective-evidence-required")
            self.store.evolve(scope, old_id, expected_version, {"status": "superseded", "valid_to": new["valid_from"]}, new["source_refs"], "explicit-fact-supersession")
            return self.store.add_edge(scope, new_id, old_id, "supersedes", new["source_refs"], weight=1, confidence=new["confidence"], inference=False)

    def link_candidates(self, scope, node_id, recall, limit=5):
        node = self.store.node(scope, node_id)
        result = recall.search(scope, node["content"], strategy="hybrid", k=limit + 1)
        return [{"source_id": node_id, "target_id": hit["node"]["id"], "relation_type": "related_to", "inference": True,
                 "evidence_refs": list(dict.fromkeys(node["source_refs"] + hit["node"]["source_refs"])), "status": "proposed"}
                for hit in result["hits"] if hit["node"]["id"] != node_id][:limit]
