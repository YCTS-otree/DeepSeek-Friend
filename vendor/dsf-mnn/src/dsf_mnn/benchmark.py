"""Deterministic synthetic ablation, no paid model calls or private data."""
from dataclasses import asdict
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import platform
import statistics
import tempfile
import time
from uuid import uuid4

from . import __version__
from .embedding import HashEmbedding
from .formation import Formation
from .lifecycle import Dreaming
from .model import Event, Node, Scope
from .recall import Recall, RecallBudget
from .store import MemoryStore


def _quality(ranks):
    return {"recall_at_5": sum(rank is not None for rank in ranks) / len(ranks),
            "mrr_at_5": statistics.mean(1 / rank if rank else 0 for rank in ranks),
            "ndcg_at_5": statistics.mean(1 / math.log2(rank + 1) if rank else 0 for rank in ranks),
            "evidence_precision_at_5": statistics.mean(.2 if rank else 0 for rank in ranks)}


def run(sizes=(100, 1000, 10000), output_root=".cache/benchmarks"):
    if not sizes or any(n < 100 or n > 100000 for n in sizes):
        raise ValueError("benchmark-size-range")
    root = Path(output_root) / uuid4().hex
    root.mkdir(parents=True)
    results = []
    for size in sizes:
        database = root / f"scale-{size}.sqlite"
        scope = Scope("benchmark", "synthetic", f"scale-{size}", "benchmark")
        provider = HashEmbedding()
        queries = [(f"case{i:05d}", f"n{i}", "factual") for i in (20, 41, 62, 83)]
        queries += [(f"trigger{i:05d}", f"n{i + 2}", "multihop") for i in (0, 3, 6, 9)]
        with MemoryStore(database) as store:
            formation = Formation(store, provider)
            start = time.perf_counter()
            with store.transaction():
                nodes = []
                for i in range(size):
                    if i < 12:
                        text = f"trigger{i:05d}" if i % 3 == 0 else f"middle{i:05d}" if i % 3 == 1 else f"solution{i:05d}"
                    else:
                        text = f"case{i:05d} 项目记录 {i} 测试结果 procedure{i % 31}"
                    raw = Event(f"e{i}", i, text, "2026-10-23T02:00:00Z", "tool_verified", f"synthetic://benchmark/{i}")
                    store.add_event(scope, raw)
                    node = Node(f"n{i}", "Episode", text, [raw.id], created_at=raw.observed_at, observed_at=raw.observed_at,
                                metadata={"layer": "daily", "topic": f"project{i // 3}"})
                    store.add_node(scope, node)
                    nodes.append(store.node(scope, node.id))
                formation.index(scope, nodes)
                store.advance(scope, "formation", size - 1)
                for i in range(0, size - 2, 3):
                    store.add_edge(scope, f"n{i}", f"n{i+1}", "related_to", [f"e{i}", f"e{i+1}"], weight=.8, confidence=.9)
                    store.add_edge(scope, f"n{i+1}", f"n{i+2}", "learned_from", [f"e{i+1}", f"e{i+2}"], weight=.8, confidence=.9)
            indexing_s = time.perf_counter() - start
            strategies = {}
            for strategy in ("vector", "hybrid", "bfs", "ppr"):
                recall = Recall(store, provider)
                latencies, ranks, rows, truncated = [], [], [], 0
                for query_index, (query, gold, category) in enumerate(queries):
                    budget = RecallBudget(deadline_ms=10000, max_operations=20000000)
                    result = recall.search(scope, query, strategy=strategy, k=5, budget=budget)
                    ids = [h["node"]["id"] for h in result["hits"]]
                    rank = ids.index(gold) + 1 if gold in ids else None
                    latencies.append(result["latency_ms"])
                    ranks.append(rank)
                    raw_path = root / f"scale-{size}-{strategy}-q{query_index}.json"
                    raw_path.write_text(json.dumps({"query": query, "gold": gold, "category": category, "budget": asdict(budget), "result": result}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                    rows.append({"query": query, "gold": gold, "category": category, "rank_at_5": rank, "retrieved": ids,
                                 "latency_ms": result["latency_ms"], "operations": result["operations"], "truncated": result["truncated"], "visited": result["visited"],
                                 "raw_result_file": raw_path.name})
                    truncated += int(result["truncated"] is not None)
                ordered = sorted(latencies)
                strategies[strategy] = {**_quality(ranks), "latency_ms_median": statistics.median(latencies),
                                         "latency_ms_p95": ordered[math.ceil(.95 * len(ordered)) - 1], "queries": len(queries),
                                         "truncated_queries": truncated, "details": rows}
            start = time.perf_counter()
            incremental = Event(f"e{size}", size, "incremental 中文新经历", "2026-10-24T02:00:00Z", "tool_verified", "synthetic://incremental")
            formation.ingest(scope, [incremental])
            incremental_ms = (time.perf_counter() - start) * 1000
            start = time.perf_counter()
            Dreaming(store, provider).tick(scope, at="2026-10-24T04:00:00+08:00", idle=True)
            dreaming_ms = (time.perf_counter() - start) * 1000
            start = time.perf_counter()
            backup = root / f"backup-{size}.sqlite"
            store.backup(backup)
            backup_ms = (time.perf_counter() - start) * 1000
            start = time.perf_counter()
            store.rebuild_index(scope, provider)
            rebuild_ms = (time.perf_counter() - start) * 1000
            vector_bytes = store.db.execute("SELECT SUM(LENGTH(vector)) FROM embeddings").fetchone()[0]
            counts = store.status(scope)
        with MemoryStore(backup) as restored:
            recovered = bool(Recall(restored, provider).search(scope, "case00020", strategy="hybrid", budget=RecallBudget(deadline_ms=10000))["hits"])
        results.append({"size": size, "indexing_seconds": indexing_s, "indexing_items_per_second": size / indexing_s,
                        "incremental_ms": incremental_ms, "dreaming_bounded_batch_ms": dreaming_ms,
                        "rebuild_ms": rebuild_ms, "backup_ms": backup_ms, "backup_reopen_recall": recovered,
                        "database_bytes": database.stat().st_size, "vector_bytes": vector_bytes, "nodes": counts["nodes"], "edges": counts["edges"], "strategies": strategies})
    return {"schema": "dsf-mnn-benchmark/1", "version": __version__, "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
            "platform": platform.platform(), "python": platform.python_version(), "embedding": "lexical-hash-baseline/1/256",
            "corpus": "synthetic-v1 (8 queries/size; 4 factual + 4 directed two-hop)", "seed": "deterministic, no randomness",
            "clock": {"name": "perf_counter", "resolution_seconds": time.get_clock_info("perf_counter").resolution},
            "cost": {"llm_requests": 0, "embedding_api_requests": 0, "graph_linking_llm_requests": 0, "dreaming_llm_requests": 0, "self_reflection_llm_requests": 0,
                     "model_tokens": 0, "context_token_saving": None}, "results": results,
            "limitations": ["No neural embedding evaluation", "Not LongMemEval/LoCoMo", "Not DSH A-F end-to-end comparison", "Eight queries are a smoke benchmark, not statistical quality evidence", "Latency includes scoped storage reads; deadline is cooperative", "Evidence precision uses one gold node per query and five requested slots"]}
