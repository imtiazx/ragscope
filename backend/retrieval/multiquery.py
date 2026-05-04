"""
Multi-query retrieval strategy for RAGScope.

Generates several rewordings of the user's question, runs cosine similarity
retrieval independently for each rewording, then merges all result sets into
one deduplicated ranking. Solves the vocabulary mismatch problem: different
phrasings of the same question produce different embeddings that may be close
to different relevant chunks, so the union is more complete than any single
query alone.

One LLM completion call is made to generate all rewordings. Embeddings for
all rewordings are computed concurrently via asyncio.gather.
"""

import math
import re
import time
from typing import Optional

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


def _parse_variants(llm_response: str, limit: int) -> list[str]:
    """
    Parse the LLM's newline-separated list of query rewordings.

    Strips common list prefixes (numbers, dashes, asterisks) that language
    models often produce even when not asked for them. Returns at most
    `limit` non-empty lines.

    Parameters
    ----------
    llm_response : str
        Raw text returned by the LLM completion call.
    limit : int
        Maximum number of variants to return.

    Returns
    -------
    list[str]
        Cleaned variant strings, at most `limit` entries.
    """
    variants = []
    for line in llm_response.strip().splitlines():
        # Remove leading "1.", "2)", "-", "*", or whitespace that the LLM
        # might prepend even though the prompt asks for plain lines.
        cleaned = re.sub(r"^\s*[\d]+[.)]\s*|^\s*[-*]\s*", "", line).strip()
        if cleaned:
            variants.append(cleaned)
    return variants[:limit]


def _build_variant_prompt(query: str, num_variants: int) -> str:
    """
    Build the prompt that asks the LLM for alternative phrasings of the query.

    Parameters
    ----------
    query : str
        The user's original question.
    num_variants : int
        Exact number of rewordings to request.

    Returns
    -------
    str
        Prompt string ready to pass to an LLM complete() call.
    """
    return (
        f"Generate exactly {num_variants} alternative phrasings of the following "
        "question. Each phrasing should approach the same topic from a different "
        "angle to maximise the chance of finding relevant information. "
        "Return only the reworded questions, one per line, with no numbering, "
        "bullets, or extra explanation.\n\n"
        f"Original question: {query}"
    )


@register
class MultiQueryRetriever(BaseRetriever):
    """
    Retriever that expands a query into multiple rewordings before searching.

    For each rewording, runs cosine similarity retrieval independently against
    the corpus. Merges all per-variant result sets by keeping the highest score
    seen for each chunk_id across all variants, then returns the top_k by that
    merged score.

    corpus format: list of dicts, each with keys:
      - chunk_id (str): unique identifier for the chunk
      - content  (str): raw text of the chunk
      - embedding (list[float]): pre-computed dense vector
    """

    name: str = "multiquery"
    display_name: str = "Multi-Query"
    description: str = (
        "Generates multiple rewordings of the query, retrieves for each, and "
        "merges the results. Improves recall when the user's phrasing does not "
        "closely match the vocabulary used in the source documents."
    )

    param_schema: list[dict] = [
        {
            "name": "top_k",
            "type": "int",
            "default": 5,
            "min": 1,
            "max": 20,
            "description": (
                "Number of chunks to return after merging all per-variant results."
            ),
        },
        {
            "name": "num_variants",
            "type": "int",
            "default": 3,
            "min": 2,
            "max": 5,
            "description": (
                "Number of alternative phrasings to generate. More variants improve "
                "recall but cost one extra embedding call each and increase latency."
            ),
        },
    ]

    def __init__(
        self,
        corpus: list[dict],
        top_k: int = 5,
        num_variants: int = 3,
        llm_provider: Optional[object] = None,
    ) -> None:
        """
        Initialise the retriever with corpus and configuration.

        Parameters
        ----------
        corpus : list[dict]
            All chunks available for retrieval. Each dict must contain
            chunk_id, content, and embedding keys.
        top_k : int
            Number of results to return after merging all variant results.
        num_variants : int
            Number of query rewordings to generate. Must be between 2 and 5.
        llm_provider : object, optional
            An object with async complete(prompt: str) -> str and
            async embed(text: str) -> list[float] methods. Defaults to a
            real OpenAIProvider when None. Pass a mock in tests.
        """
        self.corpus = corpus
        self.top_k = top_k
        self.num_variants = num_variants
        self._provider = llm_provider

    async def retrieve(self, query: str, top_k: int) -> list[RetrievalResult]:
        """
        Expand the query into variants, embed all in parallel, merge results.

        Step 1: one LLM call to generate num_variants rewordings.
        Step 2: embed all variants concurrently with asyncio.gather.
        Step 3: score every corpus chunk against every variant embedding.
        Step 4: deduplicate by chunk_id, keeping the highest score seen.
        Step 5: sort by merged score and return top_k.

        Parameters
        ----------
        query : str
            The user's original question.
        top_k : int
            Number of results to return.

        Returns
        -------
        list[RetrievalResult]
            Up to top_k deduplicated results, ordered by best score across
            all variants. metadata["matched_variants"] lists the rewordings
            that each chunk appeared in.
        """
        t0 = time.perf_counter()

        # complete_sync() and embed_sync() use httpx.Client (blocking). This
        # function runs inside _run_evaluation_async on a plain asyncio event
        # loop with no anyio task scope; AsyncClient.__aenter__ requires anyio.
        provider = self._provider if self._provider is not None else OpenAIProvider()

        # Step 1: generate query variants with one LLM completion call.
        prompt = _build_variant_prompt(query, self.num_variants)
        raw_response = provider.complete_sync(prompt)
        variants = _parse_variants(raw_response, self.num_variants)

        # Always include the original query so we never regress below Naive.
        all_queries = [query] + variants

        # Step 2: embed all queries sequentially. The original used asyncio.gather
        # for concurrency, but embed_sync() is blocking so concurrency requires
        # threads instead. Sequential calls are simpler and acceptable here
        # because this thread has no other coroutines competing on its event loop.
        embeddings: list[list[float]] = [
            provider.embed_sync(q) for q in all_queries
        ]

        # Step 3 + 4: score each corpus chunk against every query embedding.
        # best_scores maps chunk_id -> (best_score_seen, chunk_dict, list_of_matching_variant_queries)
        best_scores: dict[str, tuple[float, dict, list[str]]] = {}

        for variant_query, embedding in zip(all_queries, embeddings):
            for chunk in self.corpus:
                score = _cosine_similarity(embedding, chunk["embedding"])
                chunk_id = chunk["chunk_id"]
                if chunk_id not in best_scores or score > best_scores[chunk_id][0]:
                    # First time seeing this chunk, or new score beats the previous best.
                    existing_variants = (
                        best_scores[chunk_id][2] if chunk_id in best_scores else []
                    )
                    best_scores[chunk_id] = (score, chunk, existing_variants + [variant_query])
                else:
                    # Score did not improve, but record that this variant also matched.
                    prev_score, prev_chunk, prev_variants = best_scores[chunk_id]
                    best_scores[chunk_id] = (prev_score, prev_chunk, prev_variants + [variant_query])

        # Step 5: sort by best score across all variants, descending.
        ranked = sorted(best_scores.values(), key=lambda t: t[0], reverse=True)

        latency_ms = (time.perf_counter() - t0) * 1000.0

        return [
            RetrievalResult(
                chunk_id=chunk["chunk_id"],
                content=chunk["content"],
                score=score,
                latency_ms=latency_ms,
                metadata={"matched_variants": matched_variants},
            )
            for score, chunk, matched_variants in ranked[:top_k]
        ]
