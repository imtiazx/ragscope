"""
Naive RAG retrieval strategy for RAGScope.

Embeds the raw query with text-embedding-3-small, computes cosine similarity
against every stored chunk embedding in the corpus, and returns the top_k
closest chunks. This is the baseline strategy that all others are benchmarked
against. No LLM inference is involved at retrieval time -- only one embedding
call is made per query.
"""

import math
import time
from typing import Optional

from backend.llm.openai_provider import OpenAIProvider
from backend.retrieval.base import BaseRetriever, RetrievalResult, register


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """
    Compute cosine similarity between two dense embedding vectors.

    Returns a value between -1.0 and 1.0 where 1.0 is identical direction.
    Returns 0.0 if either vector has zero magnitude to avoid division by zero.

    Parameters
    ----------
    a, b : list[float]
        Embedding vectors of equal length.

    Returns
    -------
    float
        Cosine similarity score.
    """
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


@register
class NaiveRetriever(BaseRetriever):
    """
    Baseline retriever using direct cosine similarity on query embeddings.

    Accepts the full corpus at construction time so retrieve() is a pure
    in-memory operation with one async embedding call. The llm_provider
    parameter exists for testability -- pass a mock to avoid live API calls.

    corpus format: list of dicts, each with keys:
      - chunk_id (str): unique identifier for the chunk
      - content  (str): raw text of the chunk
      - embedding (list[float]): pre-computed dense vector
    """

    name: str = "naive"
    display_name: str = "Naive RAG"
    description: str = (
        "Embeds the query and retrieves the closest chunks by cosine similarity. "
        "The baseline against which all other strategies are measured."
    )

    param_schema: list[dict] = [
        {
            "name": "top_k",
            "type": "int",
            "default": 5,
            "min": 1,
            "max": 20,
            "description": (
                "Number of chunks to retrieve. Higher values give the LLM more "
                "context but increase token usage and may introduce noise."
            ),
        },
    ]

    def __init__(
        self,
        corpus: list[dict],
        top_k: int = 5,
        llm_provider: Optional[object] = None,
    ) -> None:
        """
        Initialise the retriever with the corpus and optional configuration.

        Parameters
        ----------
        corpus : list[dict]
            All chunks available for retrieval. Each dict must contain
            chunk_id, content, and embedding keys.
        top_k : int
            Default number of results to return. The retrieve() caller may
            override this by passing a different top_k at call time.
        llm_provider : object, optional
            An object with an async embed(text: str) -> list[float] method.
            Defaults to a real OpenAIProvider when None. Pass a mock in tests.
        """
        self.corpus = corpus
        self.top_k = top_k
        self._provider = llm_provider

    async def retrieve(self, query: str, top_k: int) -> list[RetrievalResult]:
        """
        Embed the query and return the top_k most similar corpus chunks.

        Latency is measured from the start of this call (including embedding
        time) to match how the benchmark runner experiences the cost of
        retrieval. All results share the same latency_ms -- the entire
        retrieve() call is one atomic measurement.

        Parameters
        ----------
        query : str
            The user's question or search string.
        top_k : int
            Number of chunks to return.

        Returns
        -------
        list[RetrievalResult]
            Up to top_k results ordered by descending cosine similarity score.
        """
        t0 = time.perf_counter()

        # embed_sync() uses httpx.Client (blocking) instead of httpx.AsyncClient.
        # This function runs inside _run_evaluation_async on a plain asyncio event
        # loop with no anyio task scope; AsyncClient.__aenter__ requires anyio.
        provider = self._provider if self._provider is not None else OpenAIProvider()
        query_embedding = provider.embed_sync(query)

        # Score every chunk against the query embedding.
        scored: list[tuple[float, dict]] = [
            (_cosine_similarity(query_embedding, chunk["embedding"]), chunk)
            for chunk in self.corpus
        ]

        # Sort highest similarity first and take the top_k entries.
        scored.sort(key=lambda pair: pair[0], reverse=True)

        latency_ms = (time.perf_counter() - t0) * 1000.0

        return [
            RetrievalResult(
                chunk_id=chunk["chunk_id"],
                content=chunk["content"],
                score=score,
                latency_ms=latency_ms,
            )
            for score, chunk in scored[:top_k]
        ]
