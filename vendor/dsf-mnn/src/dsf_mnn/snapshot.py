"""Normalized read-only DSH snapshot contract. No session log directory scanning."""

from .model import Event, MemoryError, Scope, digest


def validate_snapshot(payload, scope: Scope):
    if payload.get("schema") != "dsf-mnn-snapshot/1" or payload.get("session_id") != scope.session_id:
        raise MemoryError("snapshot-binding-mismatch")
    events = [Event(**row) for row in payload.get("events", [])]
    if not events or len(events) > 10000:
        raise MemoryError("snapshot-event-count")
    rows = [e.to_dict() for e in events]
    if [e.seq for e in events] != sorted({e.seq for e in events}) or len({e.id for e in events}) != len(events):
        raise MemoryError("snapshot-order")
    if payload.get("digest") != digest(rows):
        raise MemoryError("snapshot-digest-mismatch")
    return events
