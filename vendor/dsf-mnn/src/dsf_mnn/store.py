from __future__ import annotations

from collections import Counter
from contextlib import closing, contextmanager
from dataclasses import asdict
import json
import math
import os
from pathlib import Path
import sqlite3
import tempfile
from uuid import uuid4

from .embedding import EmbeddingSpace, normalize, pack, tokenize, unpack
from .model import Event, MemoryError, Node, RELATIONS, Scope, canonical, digest, now, unit


class MemoryStore:
    SCHEMA_VERSION = 1

    def __init__(self, path: str | Path):
        self.path = Path(path) if str(path) != ":memory:" else None
        if self.path:
            if self.path.suffix not in {".db", ".sqlite", ".sqlite3"}:
                raise MemoryError("database-extension-required")
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), isolation_level=None, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        tables = self.db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        if not tables:
            schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
            self.db.executescript("BEGIN IMMEDIATE;\n" + schema + "\nCOMMIT;")
        else:
            try:
                version = self.db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
                if int(version) != self.SCHEMA_VERSION:
                    raise MemoryError("unsupported-schema-version")
            except (sqlite3.Error, TypeError, ValueError):
                self.db.close()
                raise MemoryError("unsupported-schema-version") from None
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self._vector_cache = {}

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    @contextmanager
    def transaction(self):
        nested = self.db.in_transaction
        marker = "sp_" + uuid4().hex
        self.db.execute(f"SAVEPOINT {marker}" if nested else "BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute(f"RELEASE {marker}" if nested else "COMMIT")
        except BaseException:
            self.db.execute(f"ROLLBACK TO {marker}" if nested else "ROLLBACK")
            if nested:
                self.db.execute(f"RELEASE {marker}")
            self._vector_cache.clear()
            raise

    def register(self, scope: Scope):
        self.db.execute("INSERT OR IGNORE INTO scopes VALUES (?,?)", (scope.key, canonical(asdict(scope))))

    def _sources(self, scope, refs):
        if not refs or len(set(refs)) != len(refs):
            raise MemoryError("distinct-evidence-required")
        for ref in refs:
            if not self.db.execute("SELECT 1 FROM events WHERE scope=? AND id=?", (scope.key, ref)).fetchone():
                raise MemoryError("evidence-unavailable")

    def event(self, scope, event_id):
        row = self.db.execute("SELECT body FROM events WHERE scope=? AND id=?", (scope.key, event_id)).fetchone()
        if not row:
            raise MemoryError("evidence-unavailable")
        return json.loads(row[0])

    def add_event(self, scope: Scope, event: Event):
        body = event.to_dict()
        fingerprint = digest(body)
        with self.transaction():
            self.register(scope)
            old = self.db.execute("SELECT digest FROM events WHERE scope=? AND id=?", (scope.key, event.id)).fetchone()
            if old:
                if old[0] != fingerprint:
                    raise MemoryError("event-idempotency-conflict")
                return False
            if event.seq <= self.watermark(scope, "formation"):
                raise MemoryError("late-event-before-watermark")
            try:
                self.db.execute("INSERT INTO events VALUES (?,?,?,?,?)", (scope.key, event.id, event.seq, canonical(body), fingerprint))
            except sqlite3.IntegrityError:
                raise MemoryError("event-sequence-conflict") from None
        return True

    def snapshot(self, scope, after=-1, through=None):
        maximum = self.db.execute("SELECT COALESCE(MAX(seq),-1) FROM events WHERE scope=?", (scope.key,)).fetchone()[0]
        if through is None:
            through = maximum
        if through > maximum:
            raise MemoryError("snapshot-beyond-durable-events")
        rows = self.db.execute("SELECT body FROM events WHERE scope=? AND seq>? AND seq<=? ORDER BY seq", (scope.key, after, through))
        return {"through": through, "events": [json.loads(r[0]) for r in rows]}

    def node(self, scope, node_id):
        row = self.db.execute("SELECT body FROM nodes WHERE scope=? AND id=?", (scope.key, node_id)).fetchone()
        if not row:
            raise MemoryError("node-unavailable")
        return json.loads(row[0])

    def nodes(self, scope):
        return [json.loads(r[0]) for r in self.db.execute("SELECT body FROM nodes WHERE scope=? ORDER BY id", (scope.key,))]

    def _index_node(self, scope, body, *, replacing=True):
        if replacing:
            self.db.execute("DELETE FROM lexical WHERE scope=? AND node_id=?", (scope.key, body["id"]))
        terms = " ".join(tokenize(body["content"] + " " + body["summary"]))
        self.db.execute("INSERT INTO lexical VALUES (?,?,?)", (scope.key, body["id"], terms))

    def add_node(self, scope: Scope, node: Node):
        body = node.to_dict(scope)
        body["version"] = 1
        with self.transaction():
            self.register(scope)
            self._sources(scope, body["source_refs"])
            try:
                old = self.node(scope, node.id)
            except MemoryError:
                old = None
            if old:
                if old != body:
                    raise MemoryError("node-idempotency-conflict")
                return False
            self.db.execute("INSERT INTO nodes VALUES (?,?,?,?,?,?)", (scope.key, node.id, body["type"], body["status"], 1, canonical(body)))
            self.db.executemany("INSERT INTO node_sources VALUES (?,?,?)", [(scope.key, node.id, ref) for ref in body["source_refs"]])
            self.db.execute("INSERT INTO history VALUES (?,?,?,?,?,?,?)", (scope.key, node.id, 1, canonical(body), "formation", canonical(body["source_refs"]), now()))
            self._index_node(scope, body, replacing=False)
        return True

    def evolve(self, scope, node_id, expected_version, changes, evidence_refs, reason):
        allowed = {"summary", "confidence", "status", "valid_from", "valid_to", "metadata"}
        if not reason or set(changes) - allowed:
            raise MemoryError("invalid-evolution-fields")
        with self.transaction():
            old = self.node(scope, node_id)
            if old["version"] != expected_version:
                raise MemoryError("version-conflict")
            self._sources(scope, evidence_refs)
            if not changes or all(old[k] == v for k, v in changes.items()):
                return old
            body = {**old, **changes, "version": expected_version + 1,
                    "source_refs": list(dict.fromkeys(old["source_refs"] + evidence_refs))}
            body = Node(**body).to_dict(scope)
            self.db.execute("UPDATE nodes SET status=?,version=?,body=? WHERE scope=? AND id=?", (body["status"], body["version"], canonical(body), scope.key, node_id))
            self.db.executemany("INSERT OR IGNORE INTO node_sources VALUES (?,?,?)", [(scope.key, node_id, r) for r in body["source_refs"]])
            self.db.execute("INSERT INTO history VALUES (?,?,?,?,?,?,?)", (scope.key, node_id, body["version"], canonical(body), reason, canonical(evidence_refs), now()))
            if body["summary"] != old["summary"]:
                self.db.execute("DELETE FROM embeddings WHERE scope=? AND node_id=?", (scope.key, node_id))
                self._bump_index()
            self._index_node(scope, body)
        return body

    def history(self, scope, node_id):
        self.node(scope, node_id)
        return [{**dict(r), "body": json.loads(r["body"]), "evidence": json.loads(r["evidence"])} for r in self.db.execute("SELECT version,body,reason,evidence,created_at FROM history WHERE scope=? AND node_id=? ORDER BY version", (scope.key, node_id))]

    def undo(self, scope, node_id, target_version, expected_version, reason):
        rows = self.history(scope, node_id)
        target = next((r for r in rows if r["version"] == target_version), None)
        if not target:
            raise MemoryError("version-unavailable")
        fields = ("summary", "confidence", "status", "valid_from", "valid_to", "metadata")
        return self.evolve(scope, node_id, expected_version, {k: target["body"][k] for k in fields}, target["evidence"], reason)

    def add_edge(self, scope, source_id, target_id, relation_type, evidence_refs, *, weight=0.5, confidence=0.5, inference=True):
        if relation_type not in RELATIONS or source_id == target_id:
            raise MemoryError("invalid-relation")
        unit(weight)
        unit(confidence)
        edge_id = digest([source_id, target_id, relation_type, sorted(evidence_refs)])[:32]
        with self.transaction():
            self.node(scope, source_id)
            self.node(scope, target_id)
            self._sources(scope, evidence_refs)
            if relation_type == "caused_by" and not inference:
                if not any(self.event(scope, r)["source_kind"] == "tool_verified" for r in evidence_refs):
                    raise MemoryError("verified-causal-evidence-required")
            old = self.db.execute("SELECT body FROM edges WHERE scope=? AND id=?", (scope.key, edge_id)).fetchone()
            if old:
                body = json.loads(old[0])
                if (body["weight"], body["confidence"], body["inference"]) != (weight, confidence, inference):
                    raise MemoryError("edge-idempotency-conflict")
                return body
            body = dict(id=edge_id, source_id=source_id, target_id=target_id, relation_type=relation_type, weight=weight,
                        evidence_refs=evidence_refs, confidence=confidence, inference=inference,
                        created_at=now(), last_validated_at=now(), status="active")
            self.db.execute("INSERT INTO edges VALUES (?,?,?,?,?,?,?,?,?,?)", (scope.key, edge_id, source_id, target_id, relation_type, weight, confidence, int(inference), "active", canonical(body)))
            self.db.executemany("INSERT INTO edge_sources VALUES (?,?,?)", [(scope.key, edge_id, r) for r in evidence_refs])
        return body

    def neighbors(self, scope, node_id, *, limit=32, relations=None):
        self.node(scope, node_id)
        # Directed traversal: the stored target is the next node. No silent reverse causality.
        sql = "SELECT body FROM edges WHERE scope=? AND source_id=? AND status='active'"
        params = [scope.key, node_id]
        if relations is not None:
            if not relations:
                return []
            if set(relations) - RELATIONS:
                raise MemoryError("invalid-relation-filter")
            sql += " AND relation_type IN (" + ",".join("?" for _ in relations) + ")"
            params += sorted(relations)
        sql += " ORDER BY weight*confidence DESC,id LIMIT ?"
        return [json.loads(r[0]) for r in self.db.execute(sql, (*params, limit))]

    def put_embedding(self, scope, node_id, space: EmbeddingSpace, vector):
        values = normalize(vector, space.dimension)
        with self.transaction():
            node = self.node(scope, node_id)
            self.db.execute("INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?,?,?)", (scope.key, node_id, space.key, space.dimension, pack(values), digest([node["content"], node["summary"]])))
            self._bump_index()

    def _bump_index(self):
        self.db.execute("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'")
        self._vector_cache.clear()

    def vectors(self, scope, space):
        generation = (self.db.execute("PRAGMA data_version").fetchone()[0], self.db.execute("SELECT value FROM meta WHERE key='index_generation'").fetchone()[0])
        key = (scope.key, space.key, generation)
        if key not in self._vector_cache:
            rows = self.db.execute("SELECT node_id,dimension,vector FROM embeddings WHERE scope=? AND space=? ORDER BY node_id", (scope.key, space.key)).fetchall()
            if any(r["dimension"] != space.dimension for r in rows):
                raise MemoryError("embedding-space-mismatch")
            self._vector_cache = {key: [(r["node_id"], unpack(r["vector"], space.dimension)) for r in rows]}
        return self._vector_cache[key]

    def rebuild_index(self, scope, provider, batch_size=64):
        nodes = self.nodes(scope)
        with self.transaction():
            self.db.execute("DELETE FROM lexical WHERE scope=?", (scope.key,))
            self.db.execute("DELETE FROM embeddings WHERE scope=?", (scope.key,))
            for start in range(0, len(nodes), batch_size):
                batch = nodes[start:start + batch_size]
                vectors = provider.embed([n["content"] + " " + n["summary"] for n in batch])
                if len(vectors) != len(batch):
                    raise MemoryError("embedding-batch-mismatch")
                for node, vector in zip(batch, vectors):
                    self._index_node(scope, node, replacing=False)
                    self.put_embedding(scope, node["id"], provider.space, vector)
            self._bump_index()
        return len(nodes)

    def lexical(self, scope, query, limit=20, allowed_ids=None, meter=None):
        terms = list(dict.fromkeys(tokenize(query)))[:64]
        if not terms:
            return []
        match = " OR ".join('"' + t + '"' for t in terms)
        # FTS5 bm25() uses corpus-wide statistics, which could couple private scopes.
        # Retrieve only this scope's matches and compute BM25 with local statistics.
        rows = self.db.execute("SELECT node_id,tokens FROM lexical WHERE scope=? AND lexical MATCH ?", (scope.key, match)).fetchall()
        documents = []
        for row in rows:
            if allowed_ids is not None and row["node_id"] not in allowed_ids:
                continue
            if meter and not meter.spend(len(row["tokens"]) + 1):
                return []
            documents.append((row["node_id"], Counter(row["tokens"].split())))
        corpus = self.db.execute("SELECT node_id,tokens FROM lexical WHERE scope=?", (scope.key,)).fetchall()
        lengths = [len(r["tokens"].split()) for r in corpus if allowed_ids is None or r["node_id"] in allowed_ids]
        count, average = len(lengths), sum(lengths) / max(1, len(lengths))
        frequency = {term: sum(term in values for _, values in documents) for term in terms}
        ranking = []
        for node_id, values in documents:
            if meter and not meter.spend(len(terms)):
                break
            length, score = sum(values.values()), 0.0
            for term in terms:
                tf = values[term]
                idf = math.log(1 + (count - frequency[term] + .5) / (frequency[term] + .5))
                if tf:
                    score += idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * length / max(1, average)))
            ranking.append((node_id, score))
        return sorted(ranking, key=lambda pair: (-pair[1], pair[0]))[:limit]

    def receipt(self, scope, receipt_id):
        row = self.db.execute("SELECT kind,digest,body FROM receipts WHERE scope=? AND id=?", (scope.key, receipt_id)).fetchone()
        return {"kind": row[0], "digest": row[1], "body": json.loads(row[2])} if row else None

    def save_receipt(self, scope, receipt_id, kind, fingerprint, body):
        self.register(scope)
        old = self.receipt(scope, receipt_id)
        if old:
            if old["digest"] != fingerprint or old["kind"] != kind:
                raise MemoryError("receipt-idempotency-conflict")
            return old["body"]
        self.db.execute("INSERT INTO receipts VALUES (?,?,?,?,?)", (scope.key, receipt_id, kind, fingerprint, canonical(body)))
        return body

    def watermark(self, scope, kind):
        row = self.db.execute("SELECT seq FROM watermarks WHERE scope=? AND kind=?", (scope.key, kind)).fetchone()
        return row[0] if row else -1

    def advance(self, scope, kind, seq):
        self.register(scope)
        if seq < self.watermark(scope, kind):
            raise MemoryError("watermark-regression")
        self.db.execute("INSERT INTO watermarks VALUES (?,?,?) ON CONFLICT(scope,kind) DO UPDATE SET seq=excluded.seq", (scope.key, kind, seq))

    def count(self, scope, name, amount=1):
        if not math.isfinite(amount) or amount < 0:
            raise MemoryError("invalid-metric")
        self.register(scope)
        self.db.execute("INSERT INTO metrics VALUES (?,?,?) ON CONFLICT(scope,name) DO UPDATE SET value=value+excluded.value", (scope.key, name, amount))

    def status(self, scope):
        result = {name: self.db.execute(f"SELECT COUNT(*) FROM {name} WHERE scope=?", (scope.key,)).fetchone()[0] for name in ("events", "nodes", "edges", "embeddings", "receipts")}
        result["watermarks"] = {r[0]: r[1] for r in self.db.execute("SELECT kind,seq FROM watermarks WHERE scope=?", (scope.key,))}
        result["metrics"] = {r[0]: r[1] for r in self.db.execute("SELECT name,value FROM metrics WHERE scope=?", (scope.key,))}
        result["schema_version"] = self.SCHEMA_VERSION
        return result

    def forget_scope(self, scope):
        """Explicit operator API; all local derived copies removed, never called by Dreaming."""
        with self.transaction():
            self.db.execute("DELETE FROM lexical WHERE scope=?", (scope.key,))
            for table in ("edges", "nodes", "events", "receipts", "watermarks", "metrics"):
                self.db.execute(f"DELETE FROM {table} WHERE scope=?", (scope.key,))
            self.db.execute("DELETE FROM scopes WHERE scope=?", (scope.key,))
            self._bump_index()

    def forget_event(self, scope, event_id):
        """Conservative: remove dependent nodes and evidence-bearing histories, not raw DSF data."""
        self.event(scope, event_id)
        with self.transaction():
            affected = {r[0] for r in self.db.execute("SELECT node_id FROM node_sources WHERE scope=? AND event_id=?", (scope.key, event_id))}
            for row in self.db.execute("SELECT node_id,evidence FROM history WHERE scope=?", (scope.key,)):
                if event_id in json.loads(row["evidence"]):
                    affected.add(row["node_id"])
            # References between projections may carry free text; remove dependants transitively.
            changed = True
            while changed:
                changed = False
                for node in self.nodes(scope):
                    refs = set(node["metadata"].get("memory_refs", []))
                    if node["id"] not in affected and refs & affected:
                        affected.add(node["id"])
                        changed = True
            for node_id in affected:
                self.db.execute("DELETE FROM lexical WHERE scope=? AND node_id=?", (scope.key, node_id))
                self.db.execute("DELETE FROM nodes WHERE scope=? AND id=?", (scope.key, node_id))
            self.db.execute("DELETE FROM edges WHERE scope=? AND id IN (SELECT edge_id FROM edge_sources WHERE scope=? AND event_id=?)", (scope.key, scope.key, event_id))
            self.db.execute("DELETE FROM events WHERE scope=? AND id=?", (scope.key, event_id))
            self.db.execute("DELETE FROM receipts WHERE scope=?", (scope.key,))
            self.db.execute("DELETE FROM watermarks WHERE scope=?", (scope.key,))
            self._bump_index()
        return len(affected)

    @staticmethod
    def verify(path):
        location = Path(path).resolve()
        if location.suffix not in {".db", ".sqlite", ".sqlite3"}:
            raise MemoryError("database-extension-required")
        with closing(sqlite3.connect(location.as_uri() + "?mode=ro", uri=True)) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or connection.execute("PRAGMA foreign_key_check").fetchall():
                raise MemoryError("backup-verification-failed")
            row = connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if row != (str(MemoryStore.SCHEMA_VERSION),):
                raise MemoryError("unsupported-schema-version")
        return True

    def backup(self, destination):
        target = Path(destination).resolve()
        if target.suffix not in {".db", ".sqlite", ".sqlite3"}:
            raise MemoryError("database-extension-required")
        if self.db.in_transaction:
            raise MemoryError("backup-during-write")
        if target.exists():
            raise MemoryError("backup-target-exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix="mnn-backup-", suffix=".sqlite", dir=target.parent)
        os.close(fd)
        try:
            with closing(sqlite3.connect(temporary)) as backup:
                self.db.backup(backup)
                backup.execute("PRAGMA journal_mode=DELETE")
            self.verify(temporary)
            with open(temporary, "r+b") as handle:
                os.fsync(handle.fileno())
            os.link(temporary, target)  # atomic publication; refuses an existing target
        finally:
            Path(temporary).unlink(missing_ok=True)
        return {"verified": True, "path": str(target)}

    @classmethod
    def restore(cls, source, destination):
        cls.verify(source)
        target = Path(destination)
        if target.exists():
            raise MemoryError("restore-target-exists")
        # Open the source read-only: do not alter the original backup's journal mode.
        with closing(sqlite3.connect(Path(source).resolve().as_uri() + "?mode=ro", uri=True)) as origin:
            instance = object.__new__(cls)
            instance.db = origin
            return instance.backup(destination)
