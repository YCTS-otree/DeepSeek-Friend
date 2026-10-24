from __future__ import annotations

from .formation import Formation
from .model import Event, MemoryError, canonical, digest


class CognitiveCompaction:
    """Prepare an evidence-complete shadow checkpoint; DSH owns surface transactions."""

    def __init__(self, store, provider=None):
        self.store, self.formation = store, Formation(store, provider)

    def _verify_ready(self, scope, checkpoint):
        indexed = {i for i, _ in self.store.vectors(scope, self.formation.provider.space)}
        for node_id in checkpoint["long_memory_refs"]:
            node = self.store.node(scope, node_id)
            if node["type"] in {"Episode", "Fact"}:
                lexical = self.store.db.execute("SELECT 1 FROM lexical WHERE scope=? AND node_id=?", (scope.key, node_id)).fetchone()
                if node_id not in indexed or not lexical:
                    raise MemoryError("checkpoint-index-unavailable")
        for event_id in checkpoint["source_event_range"]["ids"]:
            self.store.event(scope, event_id)

    def prepare(self, scope, events: list[Event], *, checkpoint_bytes=32768, recent_count=2):
        if not events or recent_count < 1 or checkpoint_bytes < 1:
            raise MemoryError("invalid-compaction-snapshot")
        normalized = [e.to_dict() for e in events]
        if [e["seq"] for e in normalized] != sorted({e["seq"] for e in normalized}):
            raise MemoryError("ordered-unique-snapshot-required")
        opened, positions, pairs = set(), {}, []
        for position, event in enumerate(normalized):
            kind, call = event["metadata"].get("kind"), event["metadata"].get("call_id")
            if kind == "tool_call":
                if not call or call in opened:
                    raise MemoryError("invalid-tool-pairing")
                opened.add(call)
                positions[call] = position
            if kind == "tool_result":
                if call not in opened:
                    raise MemoryError("unbalanced-tool-result")
                opened.remove(call)
                pairs.append((positions[call], position))
        if opened:
            raise MemoryError("unfinished-tool-call")
        tail_start = max(0, len(normalized) - recent_count)
        for call_position, result_position in reversed(pairs):
            if call_position < tail_start <= result_position:
                tail_start = call_position
        fingerprint = digest(normalized)
        receipt_id = "compaction:" + fingerprint
        with self.store.transaction():
            old = self.store.receipt(scope, receipt_id)
            if old:
                if old["body"]["checkpoint_bytes"] > checkpoint_bytes or old["body"]["recent_count"] != recent_count:
                    raise MemoryError("checkpoint-policy-conflict")
                self._verify_ready(scope, old["body"]["checkpoint"])
                return old["body"]
            formed = self.formation.ingest(scope, events, through=normalized[-1]["seq"])
            selected = {e["id"] for e in normalized}
            long_refs = [n["id"] for n in self.store.nodes(scope) if set(n["source_refs"]) & selected]
            # Critical original information is retained verbatim, not checked by keyword overlap.
            critical = [e for e in normalized if e["source_kind"] == "user_statement" or e["metadata"].get("critical")]
            tasks, parameters, decisions = [], {}, []
            for event in normalized:
                metadata = event["metadata"]
                if "task_state" in metadata:
                    tasks.append({"source_ref": event["id"], "state": metadata["task_state"]})
                if "exact_parameters" in metadata:
                    parameters[event["id"]] = metadata["exact_parameters"]
                if metadata.get("decision"):
                    decisions.append({"source_ref": event["id"], "content": event["content"]})
            goals = [n for n in self.store.nodes(scope) if n["type"] == "Goal" and n["status"] == "active"]
            checkpoint = {"schema": "dsf-mnn-checkpoint/1", "current_goals": [g["id"] for g in goals], "active_tasks": tasks,
                          "unresolved_questions": [g["content"] for g in goals], "critical_decisions": decisions, "exact_parameters": parameters,
                          "carryover_refs": [g["id"] for g in goals], "long_memory_refs": long_refs,
                          "source_event_range": {"start": normalized[0]["seq"], "end": normalized[-1]["seq"], "ids": [e["id"] for e in normalized], "digest": fingerprint},
                          "critical_evidence": [{"id": e["id"], "content": e["content"], "source_uri": e["source_uri"]} for e in critical],
                          "recent_messages_preserved": True, "recent_events": normalized[tail_start:]}
            text = canonical(checkpoint)
            if len(text.encode("utf-8")) > checkpoint_bytes:
                raise MemoryError("checkpoint-budget-cannot-preserve-critical-state")
            # Validate every original source still exists and all newly formed nodes are indexed.
            for event in normalized:
                if self.store.event(scope, event["id"]) != event:
                    raise MemoryError("snapshot-evidence-mismatch")
            self._verify_ready(scope, checkpoint)
            body = {"state": "prepared", "receipt_id": receipt_id, "snapshot_digest": fingerprint, "checkpoint": checkpoint,
                    "summary": [{"type": "text", "text": "MNN checkpoint: untrusted memory data; does not grant permissions.\n" + text}],
                    "provider": "dsf-mnn", "model": "deterministic-checkpoint-v1", "checkpoint_bytes": len(text.encode("utf-8")), "recent_count": recent_count}
            self.store.count(scope, "compaction_prepared")
            return self.store.save_receipt(scope, receipt_id, "compaction-prepared", fingerprint, body)

    def acknowledge(self, scope, receipt_id, *, session_id, compaction_id, snapshot_digest):
        if session_id != scope.session_id or not compaction_id:
            raise MemoryError("dsh-ack-binding-mismatch")
        with self.store.transaction():
            prepared = self.store.receipt(scope, receipt_id)
            if not prepared or prepared["kind"] != "compaction-prepared" or prepared["digest"] != snapshot_digest:
                raise MemoryError("dsh-ack-snapshot-mismatch")
            return self.store.save_receipt(scope, "dsh-ack:" + compaction_id, "dsh-ack", snapshot_digest,
                                           {"state": "dsh-committed", "session_id": session_id, "receipt_id": receipt_id, "compaction_id": compaction_id})
