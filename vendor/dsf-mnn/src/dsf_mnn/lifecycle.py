from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
from zoneinfo import ZoneInfo

from .association import AssociationCue
from .formation import Formation
from .model import MemoryError, Node, canonical, digest, timestamp


class GoalState:
    def __init__(self, store):
        self.store = store

    def create(self, scope, goal_id, description, evidence_refs, *, next_actions=None, memory_refs=None):
        for ref in memory_refs or []:
            self.store.node(scope, ref)
        node = Node(goal_id, "Goal", description, evidence_refs,
                    metadata={"current_progress": "", "last_action": None, "next_actions": next_actions or [],
                              "memory_refs": memory_refs or [], "layer": "carryover"})
        self.store.add_node(scope, node)
        return goal_id

    def progress(self, scope, goal_id, expected_version, evidence_refs, *, current_progress, next_actions, completed=False):
        node = self.store.node(scope, goal_id)
        if node["type"] != "Goal":
            raise MemoryError("goal-required")
        metadata = {**node["metadata"], "current_progress": current_progress, "next_actions": next_actions}
        return self.store.evolve(scope, goal_id, expected_version, {"metadata": metadata, "status": "archived" if completed else "active"}, evidence_refs, "goal-progress")

    def carryover(self, scope):
        return [n for n in self.store.nodes(scope) if n["type"] == "Goal" and n["status"] == "active" and n["metadata"].get("layer") == "carryover"]


class SelfProjection:
    """An evidence-backed overlay; the existing bootstrap/Core files are never modified."""
    FIELDS = {"narrative", "traits", "preferences", "open_questions"}

    def __init__(self, store):
        self.store = store

    def current(self, scope):
        projections = [n for n in self.store.nodes(scope) if n["type"] == "SelfObservation" and n["metadata"].get("self_projection")]
        return projections[0] if projections else None

    def update(self, scope, changes, evidence_refs, *, expected_version=0, reason=""):
        if not changes:
            return {"state": "noop"}
        if set(changes) - self.FIELDS or not reason or not all(isinstance(v, list) and all(isinstance(x, str) for x in v) for v in changes.values()):
            raise MemoryError("self-projection-fields-rejected")
        with self.store.transaction():
            evidence = [self.store.event(scope, ref) for ref in evidence_refs]
            if not evidence or not all(e["source_kind"] == "tool_verified" and e["metadata"].get("agent_experience") is True for e in evidence):
                raise MemoryError("self-requires-experienced-verified-evidence")
            if {"traits", "preferences"} & set(changes) and len({e["observed_at"][:10] for e in evidence}) < 2:
                raise MemoryError("stable-trait-requires-independent-days")
            old = self.current(scope)
            if (old["version"] if old else 0) != expected_version:
                raise MemoryError("version-conflict")
            if old:
                # content is immutable: evolving projection is metadata, every version retained.
                metadata = {**old["metadata"], "projection": {**old["metadata"]["projection"], **changes}, "reason": reason}
                return self.store.evolve(scope, old["id"], expected_version, {"metadata": metadata}, evidence_refs, reason)
            node = Node("self_projection", "SelfObservation", "Evidence-backed overlay of the existing DSF Self Model", evidence_refs,
                        metadata={"self_projection": True, "projection": changes, "reason": reason, "bootstrap_version": "0.1.0", "memory_refs": []})
            self.store.add_node(scope, node)
            return self.store.node(scope, node.id)


@dataclass(frozen=True)
class DreamingConfig:
    time: str = "03:00"
    timezone: str = "Asia/Shanghai"
    idle_minutes: int = 15


class Dreaming:
    """Explicit scheduler tick; no daemon, session creation, model request or external action."""

    def __init__(self, store, provider=None, association=None, config=None):
        self.store, self.formation, self.association = store, Formation(store, provider), association
        self.config = config or DreamingConfig()

    def daily(self, scope, *, at, last_interaction, idle):
        current, last = datetime.fromisoformat(timestamp(at)), datetime.fromisoformat(timestamp(last_interaction))
        if not idle or (current - last).total_seconds() < self.config.idle_minutes * 60:
            return {"state": "deferred"}
        with self.store.transaction():
            result = self.formation.ingest(scope, [])
            self.store.advance(scope, "daily", result["through"])
            return {"state": "completed" if result["episode_ids"] else "noop", **result}

    def tick(self, scope, *, at, idle):
        local = datetime.fromisoformat(timestamp(at)).astimezone(ZoneInfo(self.config.timezone))
        hour, minute = [int(x) for x in self.config.time.split(":")]
        scheduled = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        day = (scheduled - timedelta(days=1) if local < scheduled else scheduled).date().isoformat()
        if not idle:
            return {"state": "deferred", "day": day}
        # BEGIN IMMEDIATE serializes mutation across processes. A crash rolls back work and watermarks.
        with self.store.transaction():
            self.store.register(scope)
            receipt_id = "dreaming:" + day
            old = self.store.receipt(scope, receipt_id)
            if old:
                return old["body"]
            formed = self.formation.ingest(scope, [])
            previous = self.store.watermark(scope, "dreaming")
            snapshot = self.store.snapshot(scope, previous, formed["through"])
            event_ids = {e["id"] for e in snapshot["events"]}
            changed, proposals = [], []
            # Bounded work; backlog beyond this batch is left for a later tick/day.
            candidates = [n for n in self.store.nodes(scope) if n["type"] == "Episode" and n["status"] == "active" and n["metadata"].get("layer") == "daily"][:128]
            for node in candidates:
                metadata = {**node["metadata"], "layer": "long_term", "consolidated_day": day}
                self.store.evolve(scope, node["id"], node["version"], {"metadata": metadata}, node["source_refs"], "dreaming-evidence-replay")
                changed.append(node["id"])
                if self.association and len(proposals) < 8:
                    result = self.association.consider(scope, AssociationCue("dream:" + day + ":" + node["id"], node["content"], tuple(node["source_refs"]), "dreaming", node["id"]))
                    proposals.extend(result["proposals"][:8 - len(proposals)])
            self.store.advance(scope, "dreaming", formed["through"])
            result = {"state": "completed" if changed else "noop", "day": day, "snapshot_through": formed["through"],
                      "consolidated": changed, "association_proposals": proposals, "carryover_refs": [g["id"] for g in GoalState(self.store).carryover(scope)],
                      "self_reflection": "noop", "context_reconstruction": "shadow-only"}
            self.store.count(scope, "dreaming_runs")
            return self.store.save_receipt(scope, receipt_id, "dreaming", digest([day, formed["through"]]), result)
