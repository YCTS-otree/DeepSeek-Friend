"""Scoped raw-evidence fallback sharing the existing MNN event store and graph."""
from collections import Counter
import json
import math
import re

from .embedding import tokenize
from .model import canonical, MemoryError
from .recall import Recall


def speaker_metadata(text):
    # Inspect only the bridge-authored prefix, never claims inside the user body.
    prefix = re.split(r"【用户消息[^】]*】", text, maxsplit=1)[0]
    for line in prefix.splitlines():
        if line.startswith("{") and '"accountId"' in line and '"userId"' in line:
            try:
                actor = json.loads(line)
            except ValueError:
                continue
            return {k: actor[k] for k in ("channel", "accountId", "userId", "trustedOwner", "displayName") if k in actor}
    return None


def semantic_body(event):
    text = event["content"]
    if text.startswith("Current runtime context."):
        return ""
    pieces = re.split(r"【用户消息[^】]*】", text, maxsplit=1)
    return pieces[-1].strip()


class EvidenceRecall:
    def __init__(self, store):
        self.store = store

    def search(self, scope, query, *, k=4):
        if len(query.encode("utf-8")) > 8192 or not 1 <= k <= 10:
            raise MemoryError("evidence-recall-budget")
        terms = set(tokenize(query))
        rows = self.store.db.execute("SELECT body FROM events WHERE scope=? AND json_extract(body,'$.metadata.dsh_type') IN ('user/message','tool/result','turn/end') ORDER BY seq LIMIT 10000", (scope.key,)).fetchall()
        documents = []
        for row in rows:
            event = json.loads(row[0])
            if event.get('metadata',{}).get('self_read'): continue
            text = semantic_body(event)
            if text:
                documents.append((event, text, Counter(tokenize(text))))
        count = len(documents)
        frequencies = {term: sum(term in tokens for _, _, tokens in documents) for term in terms}
        average = sum(sum(tokens.values()) for _, _, tokens in documents) / max(1, count)
        result = []
        for event, text, tokens in documents:
            score = 0
            for term in terms:
                tf = tokens[term]
                if tf:
                    idf = math.log(1 + (count - frequencies[term] + .5) / (frequencies[term] + .5))
                    score += idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * sum(tokens.values()) / max(1, average)))
            if score:
                positions = [text.lower().find(t) for t in terms if len(t) > 1 and text.lower().find(t) >= 0]
                offset = max(0, min(positions, default=0) - 120)
                result.append({"source_ref": event["id"], "source_seq": event["seq"], "source_kind": event["source_kind"],
                               "excerpt": text[offset:offset + 1000], "excerpt_offset": offset,
                               "recorded_speaker": speaker_metadata(event["content"]), "speaker_is_agent": False,
                               "observed_at": event["observed_at"], "relevance": score, "untrusted_evidence_data": True})
        return sorted(result, key=lambda r: (-r["relevance"], r["source_seq"]))[:k]

    def context(self, scope, query, *, byte_budget=4096):
        if byte_budget < 0:
            raise MemoryError("invalid-context-budget")
        exact = self.search(scope, query)
        text, included = "", []
        for item in exact:
            line = canonical(item) + "\n"
            if len((text + line).encode("utf-8")) <= byte_budget // 2:
                text += line
                included.append(item["source_ref"])
        graph = Recall(self.store).context(scope, query, byte_budget=byte_budget - len(text.encode("utf-8")))
        text += graph["text"]
        return {"text": text, "bytes": len(text.encode("utf-8")), "budget_unit": "utf8-bytes", "evidence_refs": included,
                "token_estimate_upper_bound": len(text.encode("utf-8")), "source": "shared-mnn-graph-and-raw-evidence"}
