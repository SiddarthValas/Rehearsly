"""Grounding retrieval over the candidate's material.

Dense search with Ollama embeddings + FAISS (inner product on normalised vectors).
If the embedding model isn't installed, falls back to a BM25-style keyword ranker so
the app still works with only a chat model pulled.
"""

from __future__ import annotations

import math
import re
from collections import Counter

import numpy as np

from server import llm

try:
    import faiss  # type: ignore
except Exception:  # pragma: no cover
    faiss = None

_WORD = re.compile(r"[a-z0-9][a-z0-9+#.\-]*")
_STOP = set(
    "the a an and or of to in on for with at by from as is are was were be been it this that these those i we you they he she "
    "my our your their me us them do did does done have has had can could will would should about into over under than then".split()
)


def tokens(text: str) -> list[str]:
    return [word.strip(".-") for word in _WORD.findall(text.lower()) if word not in _STOP and len(word) > 1]


def chunk(text: str, size: int = 650, overlap: int = 100) -> list[str]:
    """Split on paragraph/line boundaries, packing lines into ~size-char chunks."""
    lines = [line.strip() for line in re.split(r"\n+", text) if line.strip()]
    chunks: list[str] = []
    current = ""
    for line in lines:
        while len(line) > size:  # very long line: hard-wrap at a sentence/space
            cut = line.rfind(". ", 0, size)
            cut = cut + 1 if cut > size // 2 else line.rfind(" ", 0, size)
            cut = cut if cut > 0 else size
            pieces = (current + " " + line[:cut]).strip()
            chunks.append(pieces)
            current = ""
            line = line[cut:].strip()
        if len(current) + len(line) + 1 > size and current:
            chunks.append(current)
            current = current[-overlap:].split(" ", 1)[-1] if overlap else ""
        current = f"{current}\n{line}".strip()
    if current:
        chunks.append(current)
    return chunks or [text[:size]]


class Index:
    def __init__(self, text: str):
        self.chunks = chunk(text)
        self.dense = False
        self._faiss = None
        self._matrix = None
        vectors = llm.embed(self.chunks)
        if vectors:
            matrix = np.asarray(vectors, dtype="float32")
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            matrix /= np.where(norms == 0, 1, norms)
            self._matrix = matrix
            self.dense = True
            if faiss is not None:
                self._faiss = faiss.IndexFlatIP(matrix.shape[1])
                self._faiss.add(matrix)
        # keyword stats (always built: used for fallback and hybrid re-ranking)
        self._docs = [Counter(tokens(item)) for item in self.chunks]
        self._lengths = [sum(doc.values()) or 1 for doc in self._docs]
        self._avg = sum(self._lengths) / len(self._lengths)
        df: Counter = Counter()
        for doc in self._docs:
            df.update(doc.keys())
        n = len(self._docs)
        self._idf = {term: math.log(1 + (n - freq + 0.5) / (freq + 0.5)) for term, freq in df.items()}

    def _bm25(self, query: str) -> np.ndarray:
        terms = tokens(query)
        scores = np.zeros(len(self._docs), dtype="float32")
        for index, doc in enumerate(self._docs):
            total = 0.0
            for term in terms:
                tf = doc.get(term, 0)
                if tf:
                    idf = self._idf.get(term, 0.0)
                    total += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * self._lengths[index] / self._avg))
            scores[index] = total
        return scores

    def search(self, query: str, k: int = 3) -> list[str]:
        k = min(k, len(self.chunks))
        keyword = self._bm25(query)
        if keyword.max() > 0:
            keyword = keyword / keyword.max()
        if self.dense:
            vector = llm.embed([query])
            if vector:
                q = np.asarray(vector, dtype="float32")
                q /= np.linalg.norm(q) or 1
                if self._faiss is not None:
                    sims, ids = self._faiss.search(q, len(self.chunks))
                    dense = np.zeros(len(self.chunks), dtype="float32")
                    dense[ids[0]] = sims[0]
                else:
                    dense = (self._matrix @ q[0]).astype("float32")
                combined = 0.7 * dense + 0.3 * keyword  # hybrid: semantic + exact-term
                order = np.argsort(-combined)[:k]
                return [self.chunks[i] for i in order]
        order = np.argsort(-keyword)[:k]
        return [self.chunks[i] for i in order]
