from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import math


class MemoryError(ValueError):
    """Stable validation failure; never includes input content."""


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def timestamp(value: str) -> str:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise MemoryError("timezone-required")
    return dt.astimezone(timezone.utc).isoformat(timespec="microseconds")


def unit(value: float) -> float:
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise MemoryError("confidence-out-of-range")
    return value


@dataclass(frozen=True)
class Scope:
    agent_id: str
    user_id: str
    session_id: str
    workspace_id: str
    visibility: str = "private"

    def __post_init__(self):
        if not all(isinstance(v, str) and v.strip() for v in asdict(self).values()):
            raise MemoryError("complete-scope-required")
        if self.visibility != "private":
            raise MemoryError("visibility-not-authorized")

    @property
    def key(self):
        return digest(asdict(self))


SOURCE_KINDS = {"user_statement", "tool_verified", "external", "inference", "hypothesis", "reflection", "creative"}
NODE_KINDS = {"Event", "Episode", "Entity", "Fact", "Concept", "Project", "Goal", "Reflection", "Procedure", "SelfObservation"}
RELATIONS = {"related_to", "part_of", "occurred_during", "caused_by", "resolved_by", "learned_from", "supports", "contradicts", "supersedes", "depends_on", "reflects_on", "associated_with"}
STATUSES = {"active", "superseded", "disputed", "archived"}


@dataclass(frozen=True)
class Event:
    id: str
    seq: int
    content: str
    observed_at: str
    source_kind: str
    source_uri: str
    topic: str = ""
    metadata: dict = field(default_factory=dict)

    def to_dict(self):
        if not self.id or not isinstance(self.seq, int) or self.seq < 0 or not self.source_uri:
            raise MemoryError("invalid-event-identity")
        if self.source_kind not in SOURCE_KINDS or not isinstance(self.content, str):
            raise MemoryError("invalid-event-source")
        value = asdict(self)
        value["observed_at"] = timestamp(self.observed_at)
        canonical(value)
        return value


@dataclass
class Node:
    id: str
    type: str
    content: str
    source_refs: list[str]
    summary: str = ""
    confidence: float = 0.5
    status: str = "active"
    created_at: str = field(default_factory=now)
    observed_at: str | None = None
    valid_from: str | None = None
    valid_to: str | None = None
    owner_scope: dict = field(default_factory=dict)
    version: int = 1
    embedding_ref: str | None = None
    metadata: dict = field(default_factory=dict)

    def to_dict(self, scope: Scope):
        if not self.id or self.type not in NODE_KINDS or self.status not in STATUSES or not self.source_refs:
            raise MemoryError("invalid-node")
        unit(self.confidence)
        value = asdict(self)
        value["owner_scope"] = asdict(scope)
        for name in ("created_at", "observed_at", "valid_from", "valid_to"):
            if value[name] is not None:
                value[name] = timestamp(value[name])
        if value["valid_from"] and value["valid_to"] and value["valid_from"] >= value["valid_to"]:
            raise MemoryError("invalid-validity-interval")
        canonical(value)
        return value
