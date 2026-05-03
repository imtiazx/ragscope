"""
Hybrid BM25 + dense retrieval strategy for RAGScope.

Runs BM25 keyword retrieval and cosine similarity dense retrieval in parallel,
then fuses their ranked result lists using Reciprocal Rank Fusion (RRF). BM25
catches exact keyword matches that dense retrieval misses; dense retrieval
catches semantic matches that BM25 misses. RRF combines both using rank
position rather than raw scores, avoiding the scale-incompatibility problem
of mixing BM25 scores with cosine similarities.

The BM25 index is built at construction time from corpus text so retrieve()
does not repeat that work per query.
"""

import asyncio
import math
import time
from typing import Optional

from rank_bm25 import BM25Okapi

from backend.llm.openai_provider import OpenAIProvider
from backend.retrieval.base import BaseRetriever, RetrievalResult, register


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """
    Compute cosine similarity between two dense embedding vectors.

    Returns a value between -1.0 and 1.0. Returns 0.0 if either vector has
    zero magnitude to avoid division by zero.

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


async def _bm25_scores(bm25: BM25Okapi, query_tokens: list[str]) -> list[float]:
    """
    Return BM25 scores for every corpus document against the tokenised query.

    Defined as async so it can participate in asyncio.gather alongside the
    genuinely async dense retrieval coroutine. The BM25 computation itself is
    synchronous and in-memory (microseconds), so no thread pool is needed.

    Parameters
    ----------
    bm25 : BM25Okapi
        Pre-built BM25 index over the corpus.
    query_tokens : list[str]
        Whitespace-tokenised, lowercased query terms.

    Returns
    -------
    list[float]
        One score per corpus document, in corpus order.
    """
    return list(bm25.get_scores(query_tokens))


async def _dense_scores(
    query: str, corpus: list[dict], provider: object
) -> list[float]:
    """
    Embed the query and return cosine similarity scores against every chunk.

    Parameters
    ----------
    query : str
        Raw query string. Embedding is computed inside this function.
    corpus : list[dict]
        Corpus chunks, each containing an "embedding" key.
    provider : object
        LLM provider with an async embed(text) -> list[float] method.

    Returns
    -------
    list[float]
        One cosine similarity score per corpus chunk, in corpus order.
    """
    query_embedding = await provider.embed(query)
    return [_cosine_similarity(query_embedding, chunk["embedding"]) for chunk in corpus]


def _rrf_fuse(
    scores_a: list[float],
    scores_b: list[float],
    weight_a: float,
    rrf_k: int,
) -> list[float]:
    """
    Fuse two scored lists using Reciprocal Rank Fusion.

    Converts each score list to a rank ordering (rank 1 = highest score),
    then computes a weighted sum of rank-reciprocal values for every position.
    The weighting allows callers to bias the fusion toward either signal.

    Parameters
    ----------
    scores_a : list[float]
        Scores from the first retrieval method (BM25), one per corpus chunk.
    scores_b : list[float]
        Scores from the second retrieval method (dense), one per corpus chunk.
    weight_a : float
        Weight applied to scores_a's RRF contribution. The complementary
        weight (1 - weight_a) is applied to scores_b automatically.
    rrf_k : int
        Rank-smoothing constant. Controls how steeply the score drops for
        lower-ranked results. Higher values flatten the curve and give more
        equal weight to non-top results.

    Returns
    -------
    list[float]
        One fused score per position. Higher means more relevant.
    """
    n = len(scores_a)

    # Convert scores to 1-indexed rank maps. The item with the highest score
    # gets rank 1. Using enumerate after sorting gives us the rank directly.
    rank_a = {
        idx: rank + 1
        for rank, idx in enumerate(
            sorted(range(n), key=lambda i: scores_a[i], reverse=True)
        )
    }
    rank_b = {
        idx: rank + 1
        for rank, idx in enumerate(
            sorted(range(n), key=lambda i: scores_b[i], reverse=True)
        )
    }

    fused = []
    for i in range(n):
        rrf_a = weight_a * (1.0 / (rrf_k + rank_a[i]))
        rrf_b = (1.0 - weight_a) * (1.0 / (rrf_k + rank_b[i]))
        fused.append(rrf_a + rrf_b)

    return fused


@register
class HybridRetriever(BaseRetriever):
    """
    Retriever that fuses BM25 keyword search with dense cosine similarity.

    The BM25 index is built from corpus text at construction time. At query
    time, both retrieval paths are launched in parallel via asyncio.gather.
    Their result lists are fused with weighted RRF and the top_k chunks by
    fused score are returned.

    corpus format: list of dicts, each with keys:
      - chunk_id (str): unique identifier for the chunk
      - content  (str): raw text of the chunk (used by BM25)
      - embedding (list[float]): pre-computed dense vector (used by cosine)
    """

    name: str = "hybrid"
    display_name: str = "Hybrid BM25 + Dense"
    description: str = (
        "Runs BM25 keyword retrieval and dense cosine similarity in parallel, "
        "then fuses rankings with Reciprocal Rank Fusion. Catches both exact "
        "keyword matches and semantic matches in one pass."
    )

    param_schema: list[dict] = [
        {
            "name": "top_k",
            "type": "int",
            "default": 5,
            "min": 1,
            "max": 20,
            "description": "Number of chunks to return after fusion.",
        },
        {
            "name": "bm25_weight",
            "type": "float",
            "default": 0.5,
            "min": 0.0,
            "max": 1.0,
            "description": (
                "Weight given to BM25's RRF contribution. 0.0 means pure dense "
                "retrieval; 1.0 means pure BM25; 0.5 blends both equally. Increase "
                "for corpora with precise technical terminology; decrease for "
                "conversational or paraphrase-heavy corpora."
            ),
        },
        {
            "name": "rrf_k",
            "type": "int",
            "default": 60,
            "min": 1,
            "max": 100,
            "description": (
                "Rank-smoothing constant in the RRF formula 1/(k + rank). A higher "
                "value flattens the score curve, giving lower-ranked results more "
                "equal weight relative to the top result. The empirically derived "
                "default of 60 works well across most retrieval benchmarks."
            ),
        },
    ]

    def __init__(
        self,
        corpus: list[dict],
        top_k: int = 5,
        bm25_weight: float = 0.5,
        rrf_k: int = 60,
        llm_provider: Optional[object] = None,
    ) -> None:
        """
        Initialise the retriever and build the BM25 index.

        Building the BM25 index here rather than in retrieve() ensures the
        O(n) indexing cost is paid once at construction, not on every query.

        Parameters
        ----------
        corpus : list[dict]
            All chunks available for retrieval. Each dict must contain
            chunk_id, content, and embedding keys.
        top_k : int
            Default number of results to return.
        bm25_weight : float
            Weight for the BM25 RRF contribution (0.0 to 1.0).
        rrf_k : int
            RRF smoothing constant. Typical range 1-100; 60 is the standard
            empirical default from the original RRF paper.
        llm_provider : object, optional
            An object with an async embed(text: str) -> list[float] method.
            Defaults to a real OpenAIProvider when None. Pass a mock in tests.
        """
        self.corpus = corpus
        self.top_k = top_k
        self.bm25_weight = bm25_weight
        self.rrf_k = rrf_k
        self._provider = llm_provider

        # Tokenise corpus text once and build the BM25 index. Lowercase and
        # whitespace-split matches how query tokens will be produced in retrieve().
        tokenized_corpus = [chunk["content"].lower().split() for chunk in corpus]
        self._bm25 = BM25Okapi(tokenized_corpus)

    async def retrieve(self, query: str, top_k: int) -> list[RetrievalResult]:
        """
        Run BM25 and dense retrieval in parallel, fuse with RRF, return top_k.

        Parameters
        ----------
        query : str
            The user's question or search string.
        top_k : int
            Number of chunks to return.

        Returns
        -------
        list[RetrievalResult]
            Up to top_k results ordered by descending RRF-fused score.
            metadata["bm25_score"] and metadata["dense_score"] carry the
            raw pre-fusion scores for benchmark interpretability.
        """
        t0 = time.perf_counter()

        provider = self._provider if self._provider is not None else OpenAIProvider()

        # Tokenise the query the same way the corpus was tokenised so BM25
        # term frequencies are computed on a consistent vocabulary.
        query_tokens = query.lower().split()

        # Launch both retrieval paths concurrently. _bm25_scores is a thin
        # async wrapper around synchronous BM25 scoring; _dense_scores awaits
        # the real embedding API call. gather returns both results together
        # once both coroutines complete.
        bm25_raw, dense_raw = await asyncio.gather(
            _bm25_scores(self._bm25, query_tokens),
            _dense_scores(query, self.corpus, provider),
        )

        # Fuse the two score lists using weighted Reciprocal Rank Fusion.
        fused = _rrf_fuse(bm25_raw, dense_raw, self.bm25_weight, self.rrf_k)

        # Sort corpus indices by descending fused score and take top_k.
        ranked_indices = sorted(range(len(fused)), key=lambda i: fused[i], reverse=True)

        latency_ms = (time.perf_counter() - t0) * 1000.0

        return [
            RetrievalResult(
                chunk_id=self.corpus[i]["chunk_id"],
                content=self.corpus[i]["content"],
                score=fused[i],
                latency_ms=latency_ms,
                metadata={
                    "bm25_score": bm25_raw[i],
                    "dense_score": dense_raw[i],
                },
            )
            for i in ranked_indices[:top_k]
        ]
