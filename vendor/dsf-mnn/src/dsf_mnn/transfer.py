"""Versioned portable JSON exchange, scoped and with complete index reconstruction."""
import json

from .model import Event, MemoryError, Node, Scope, canonical, digest


def export_scope(store, scope):
    body = {"schema": "dsf-mnn-export/1", "scope": json.loads(canonical(scope.__dict__)),
            "events": store.snapshot(scope)["events"], "nodes": store.nodes(scope),
            "edges": [json.loads(r[0]) for r in store.db.execute("SELECT body FROM edges WHERE scope=? ORDER BY id", (scope.key,))],
            "history": [dict(r) for r in store.db.execute("SELECT node_id,version,body,reason,evidence,created_at FROM history WHERE scope=? ORDER BY node_id,version", (scope.key,))],
            "watermarks": store.status(scope)["watermarks"]}
    return {"body": body, "digest": digest(body)}


def import_scope(store, package, provider):
    body = package["body"]
    if body.get("schema") != "dsf-mnn-export/1" or package.get("digest") != digest(body):
        raise MemoryError("export-integrity-failed")
    scope = Scope(**body["scope"])
    with store.transaction():
        if store.db.execute("SELECT 1 FROM scopes WHERE scope=?", (scope.key,)).fetchone():
            raise MemoryError("import-requires-empty-scope")
        store.register(scope)
        for event in body["events"]:
            store.add_event(scope, Event(**event))
        for node in body["nodes"]:
            if node["owner_scope"] != body["scope"]:
                raise MemoryError("import-scope-mismatch")
            node = dict(node)
            node["version"] = 1
            store.add_node(scope, Node(**node))
        store.db.execute("DELETE FROM history WHERE scope=?", (scope.key,))
        histories = {}
        for history in body["history"]:
            node = Node(**json.loads(history["body"])).to_dict(scope)
            store.node(scope, history["node_id"])
            if node["id"] != history["node_id"] or node["version"] != history["version"]:
                raise MemoryError("import-history-mismatch")
            store._sources(scope, json.loads(history["evidence"]))
            store.db.execute("INSERT INTO history VALUES (?,?,?,?,?,?,?)", (scope.key, history["node_id"], history["version"], canonical(node), history["reason"], history["evidence"], history["created_at"]))
            histories.setdefault(node["id"], []).append(node["version"])
        for node in body["nodes"]:
            if histories.get(node["id"]) != list(range(1, node["version"] + 1)):
                raise MemoryError("import-incomplete-history")
            stored = store.db.execute("SELECT body FROM history WHERE scope=? AND node_id=? AND version=?", (scope.key, node["id"], node["version"])).fetchone()
            if json.loads(stored[0]) != node:
                raise MemoryError("import-latest-history-mismatch")
            store.db.execute("UPDATE nodes SET version=?,body=? WHERE scope=? AND id=?", (node["version"], canonical(node), scope.key, node["id"]))
        for edge in body["edges"]:
            created = store.add_edge(scope, edge["source_id"], edge["target_id"], edge["relation_type"], edge["evidence_refs"], weight=edge["weight"], confidence=edge["confidence"], inference=edge["inference"])
            if created["id"] != edge["id"]:
                raise MemoryError("import-edge-mismatch")
            store.db.execute("UPDATE edges SET body=?,status=? WHERE scope=? AND id=?", (canonical(edge), edge["status"], scope.key, edge["id"]))
        for kind, seq in body["watermarks"].items():
            store.advance(scope, kind, seq)
        store.rebuild_index(scope, provider)
    return scope
