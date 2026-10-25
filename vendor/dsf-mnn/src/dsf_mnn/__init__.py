"""DSF-MNN: scoped, evidence-preserving associative memory."""

__version__ = "1.2.3"

from .model import Event, Node, Scope
from .store import MemoryStore

__all__ = ["Event", "Node", "Scope", "MemoryStore", "__version__"]
