import argparse
from dataclasses import asdict
import json
import sys

from . import __version__
from .association import AssociationCue, SpontaneousAssociation
from .compaction import CognitiveCompaction
from .embedding import HashEmbedding
from .formation import Formation
from .lifecycle import Dreaming, GoalState, SelfProjection
from .model import Event, MemoryError, Scope, canonical
from .recall import Recall
from .snapshot import validate_snapshot
from .store import MemoryStore
from .transfer import export_scope, import_scope


def input_json():
    # Read only explicitly supplied standard input; never auto-open paths or credentials.
    data = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise MemoryError("input-budget-exceeded")
    return json.loads(data.decode("utf-8-sig"))


def rpc(store, request):
    scope = Scope(**request["scope"])
    provider = HashEmbedding()
    recall = Recall(store, provider)
    operation = request["operation"]
    if operation == "prepare":
        events = validate_snapshot(request["snapshot"], scope)
        return CognitiveCompaction(store, provider).prepare(scope, events, checkpoint_bytes=request.get("checkpoint_bytes", 32768))
    if operation == "recall":
        if request.get("include_evidence"):
            from .evidence_recall import EvidenceRecall
            return EvidenceRecall(store).context(scope, request["query"], byte_budget=request.get("byte_budget", 4096))
        return recall.context(scope, request["query"], byte_budget=request.get("byte_budget", 4096))
    if operation == "search":
        return recall.search(scope, request["query"], strategy=request.get("strategy", "hybrid"))
    if operation == "associate":
        cue = request["cue"]
        cue["source_refs"] = tuple(cue["source_refs"])
        return SpontaneousAssociation(store, recall).consider(scope, AssociationCue(**cue))
    if operation == "status":
        return store.status(scope)
    if operation == "validate_refs":
        refs = request.get("refs", [])
        if not isinstance(refs, list) or len(refs) > 1000:
            raise MemoryError("invalid-reference-validation-request")
        for ref in refs:
            node = store.node(scope, ref)
            if ref in request.get("versions", {}) and node["version"] != request["versions"][ref]:
                raise MemoryError("context-plan-memory-version-changed")
        if "goal_state" in request:
            current = [{"id": n["id"], "version": n["version"], "status": n["status"]} for n in store.nodes(scope) if n["type"] == "Goal"]
            if current != request["goal_state"]:
                raise MemoryError("context-plan-goal-state-changed")
        return {"validated": len(refs)}
    if operation == "evidence":
        from .tools import MemoryTools
        return MemoryTools(store, scope).memory_get_evidence(request["id"])
    raise MemoryError("rpc-operation-not-allowed")


def main(argv=None):
    parser = argparse.ArgumentParser(description="DSF-MNN offline memory research core")
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--db", default="data/mnn.sqlite")
    parser.add_argument("--agent", default="synthetic-whale")
    parser.add_argument("--user", default="synthetic-user")
    parser.add_argument("--session", default="synthetic-session")
    parser.add_argument("--workspace", default="demo")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "ingest", "rebuild-index", "export", "import", "rpc", "associate"):
        commands.add_parser(name)
    for name in ("search", "recall"):
        item = commands.add_parser(name)
        item.add_argument("query")
        item.add_argument("--strategy", choices=["vector", "hybrid", "bfs", "ppr", "lexical"], default="hybrid")
    for name in ("trace", "inspect", "evidence"):
        item = commands.add_parser(name)
        item.add_argument("id")
    for name in ("backup", "restore"):
        commands.add_parser(name).add_argument("path")
    dreaming = commands.add_parser("dream")
    dreaming.add_argument("--at", required=True)
    dreaming.add_argument("--idle", action="store_true")
    benchmark = commands.add_parser("benchmark")
    benchmark.add_argument("--sizes", default="100,1000,10000")
    args = parser.parse_args(argv)
    try:
        if args.command == "benchmark":
            from .benchmark import run
            print(canonical(run([int(v) for v in args.sizes.split(",")])))
            return 0
        if args.command == "restore":
            print(canonical(MemoryStore.restore(args.path, args.db)))
            return 0
        scope = Scope(args.agent, args.user, args.session, args.workspace)
        with MemoryStore(args.db) as store:
            provider, result = HashEmbedding(), None
            recall = Recall(store, provider)
            if args.command == "status":
                result = {"version": __version__, **store.status(scope)}
            elif args.command == "rpc":
                result = rpc(store, input_json())
            elif args.command == "ingest":
                result = Formation(store, provider).ingest(scope, [Event(**e) for e in input_json()["events"]])
            elif args.command == "search":
                result = recall.search(scope, args.query, strategy=args.strategy)
            elif args.command == "recall":
                result = recall.context(scope, args.query, strategy=args.strategy)
            elif args.command == "inspect":
                result = store.node(scope, args.id)
            elif args.command == "trace":
                node = store.node(scope, args.id)
                result = {"node": node, "history": store.history(scope, args.id), "evidence": [store.event(scope, ref) for ref in node["source_refs"]]}
            elif args.command == "evidence":
                result = store.event(scope, args.id)
            elif args.command == "associate":
                cue = input_json()
                cue["source_refs"] = tuple(cue["source_refs"])
                result = SpontaneousAssociation(store, recall).consider(scope, AssociationCue(**cue))
            elif args.command == "dream":
                association = SpontaneousAssociation(store, recall)
                result = Dreaming(store, provider, association).tick(scope, at=args.at, idle=args.idle)
            elif args.command == "backup":
                result = store.backup(args.path)
            elif args.command == "rebuild-index":
                result = {"indexed": store.rebuild_index(scope, provider), "space": asdict(provider.space)}
            elif args.command == "export":
                result = export_scope(store, scope)
            elif args.command == "import":
                imported = import_scope(store, input_json(), provider)
                result = {"scope": imported.key, **store.status(imported)}
            print(canonical(result))
        return 0
    except (MemoryError, ValueError, KeyError, TypeError) as error:
        code = str(error) if isinstance(error, MemoryError) else "invalid-input"
        print(canonical({"error": code}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
