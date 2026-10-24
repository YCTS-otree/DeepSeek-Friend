from __future__ import annotations

from array import array
from collections import Counter
from dataclasses import asdict, dataclass
import hashlib
import math
from pathlib import Path
import re
from typing import Protocol

from .model import MemoryError, digest


def tokenize(text: str) -> list[str]:
    """Latin technical tokens plus Chinese characters/bigrams; no network dictionaries."""
    result = re.findall(r"[a-z0-9_]+", text.lower())
    for run in re.findall(r"[\u3400-\u9fff]+", text):
        result.extend(run)
        result.extend(run[i:i + 2] for i in range(len(run) - 1))
    return result


@dataclass(frozen=True)
class EmbeddingSpace:
    model: str
    version: str
    dimension: int
    normalization: str = "l2"
    index_version: int = 1

    def __post_init__(self):
        if not self.model or not self.version or self.dimension < 1 or self.normalization != "l2":
            raise MemoryError("invalid-embedding-space")

    @property
    def key(self):
        return digest(asdict(self))


class EmbeddingProvider(Protocol):
    space: EmbeddingSpace

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def normalize(vector, dimension: int) -> list[float]:
    values = [float(v) for v in vector]
    if len(values) != dimension or not all(math.isfinite(v) for v in values):
        raise MemoryError("invalid-embedding-vector")
    length = math.sqrt(sum(v * v for v in values))
    if not math.isfinite(length) or length <= 0:
        raise MemoryError("zero-or-overflow-embedding")
    return [v / length for v in values]


def pack(vector) -> bytes:
    data = array("f", vector)
    import sys
    if sys.byteorder != "little":
        data.byteswap()
    return data.tobytes()


def unpack(data: bytes, dimension: int) -> list[float]:
    if len(data) != dimension * 4:
        raise MemoryError("corrupt-embedding")
    values = array("f")
    values.frombytes(data)
    import sys
    if sys.byteorder != "little":
        values.byteswap()
    result = list(values)
    if not all(math.isfinite(v) for v in result) or abs(sum(v * v for v in result) - 1) > 1e-4:
        raise MemoryError("corrupt-embedding")
    return result


class HashEmbedding:
    """Deterministic lexical baseline. This is NOT a neural semantic model."""

    def __init__(self, dimension=256):
        self.space = EmbeddingSpace("lexical-hash-baseline", "1", dimension)

    def embed(self, texts):
        result = []
        for text in texts:
            values = [0.0] * self.space.dimension
            for term, count in Counter(tokenize(text) or ["__empty__"]).items():
                hashed = hashlib.sha256(term.encode()).digest()
                slot = int.from_bytes(hashed[:4], "little") % len(values)
                values[slot] += (1 if hashed[4] & 1 else -1) * (1 + math.log(count))
            if not any(values):
                values[0] = 1.0
            result.append(normalize(values, len(values)))
        return result


class LocalSentenceTransformer:
    """Explicit local model only: no model downloads, API keys or remote code."""

    def __init__(self, model_path: str, model_id: str, revision: str):
        location = Path(model_path)
        if not location.is_dir():
            raise MemoryError("local-model-required")
        from sentence_transformers import SentenceTransformer
        self.model = SentenceTransformer(str(location), local_files_only=True, trust_remote_code=False)
        self.space = EmbeddingSpace(model_id, revision, self.model.get_sentence_embedding_dimension())

    def embed(self, texts):
        vectors = self.model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        return [normalize(v, self.space.dimension) for v in vectors]
