"""
Tests for the four concrete retrieval strategies and their registry wiring.

All external calls (OpenAI embed, OpenAI complete) are replaced with a
configurable mock provider so no network calls are made. The BM25 path in
HybridRetriever runs against the in-memory corpus without mocking -- it is
purely synchronous and has no external dependencies.

Corpus design: five chunks with 3-dimensional embeddings placed at cardinal
directions in the vector space so similarity outcomes are predictable and
manually verifiable.
"""

import pytest

# Importing registry triggers the side-effect chain:
# registry.py -> naive, hyde, multiquery, hybrid, contextual_compression
# Each @register decorator fires and populates backend.retrieval.base.registry.
from backend.retrieval.registry import registry
from backend.retrieval.naive import NaiveRetriever
from backend.retrieval.hyde import HyDeRetriever
from backend.retrieval.multiquery import MultiQueryRetriever
from backend.retrieval.hybrid import HybridRetriever


# ---------------------------------------------------------------------------
# Shared test corpus
# ---------------------------------------------------------------------------

# Five chunks with 3-dimensional unit-vector embeddings. Chunk 0 and 1 point
# toward [1,0,0]; chunk 2 and 3 toward [0,1,0]; chunk 4 toward [0,0,1].
# A query embedding of [1,0,0] should rank chunks 0 and 1 highest.
_CORPUS = [
    {"chunk_id": "c0", "content": "alpha document about topic A",    "embedding": [1.0, 0.0, 0.0]},
    {"chunk_id": "c1", "content": "beta document about topic A",     "embedding": [0.9, 0.1, 0.0]},
    {"chunk_id": "c2", "content": "gamma document about topic B",    "embedding": [0.0, 1.0, 0.0]},
    {"chunk_id": "c3", "content": "delta document about topic B",    "embedding": [0.0, 0.9, 0.1]},
    {"chunk_id": "c4", "content": "epsilon document about topic C",  "embedding": [0.0, 0.0, 1.0]},
]


# ---------------------------------------------------------------------------
# Mock providers
# ---------------------------------------------------------------------------

class _MockProvider:
    """
    Configurable stub for LLM providers used across all retrieval tests.

    Records every call to complete() and embed() so tests can assert on
    call order, call count, and the arguments that were passed.
    """

    def __init__(
        self,
        complete_response: str = "",
        embed_vector: list[float] | None = None,
    ) -> None:
        """
        Initialise with fixed responses for both methods.

        Parameters
        ----------
        complete_response : str
            String returned by every complete() call.
        embed_vector : list[float], optional
            Vector returned by every embed() call. Defaults to [1, 0, 0].
        """
        self.complete_calls: list[str] = []
        self.embed_calls: list[str] = []
        self._complete_response = complete_response
        self._embed_vector = embed_vector if embed_vector is not None else [1.0, 0.0, 0.0]

    async def complete(self, prompt: str) -> str:
        """Record the prompt and return the fixed response."""
        self.complete_calls.append(prompt)
        return self._complete_response

    async def embed(self, text: str) -> list[float]:
        """Record the input text and return the fixed vector."""
        self.embed_calls.append(text)
        return self._embed_vector


# ---------------------------------------------------------------------------
# NaiveRetriever tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_naive_returns_correct_number_of_results():
    """
    NaiveRetriever must return exactly top_k results when the corpus is larger.
    """
    provider = _MockProvider(embed_vector=[1.0, 0.0, 0.0])
    retriever = NaiveRetriever(corpus=_CORPUS, llm_provider=provider)
    results = await retriever.retrieve("test query", top_k=3)
    assert len(results) == 3


@pytest.mark.asyncio
async def test_naive_results_ordered_by_descending_score():
    """
    Results must be sorted so the highest cosine similarity comes first.

    With query embedding [1,0,0], chunk c0 (embedding [1,0,0]) should score
    highest (similarity 1.0), followed by c1 ([0.9,0.1,0]).
    """
    provider = _MockProvider(embed_vector=[1.0, 0.0, 0.0])
    retriever = NaiveRetriever(corpus=_CORPUS, llm_provider=provider)
    results = await retriever.retrieve("test query", top_k=2)

    assert results[0].chunk_id == "c0"
    assert results[1].chunk_id == "c1"
    assert results[0].score >= results[1].score


@pytest.mark.asyncio
async def test_naive_latency_is_positive():
    """latency_ms must be a positive float on every result."""
    provider = _MockProvider(embed_vector=[1.0, 0.0, 0.0])
    retriever = NaiveRetriever(corpus=_CORPUS, llm_provider=provider)
    results = await retriever.retrieve("test query", top_k=2)
    assert all(r.latency_ms > 0 for r in results)


@pytest.mark.asyncio
async def test_naive_returns_fewer_than_top_k_when_corpus_is_small():
    """If the corpus has fewer chunks than top_k, return all chunks."""
    small_corpus = _CORPUS[:2]
    provider = _MockProvider(embed_vector=[1.0, 0.0, 0.0])
    retriever = NaiveRetriever(corpus=small_corpus, llm_provider=provider)
    results = await retriever.retrieve("test query", top_k=10)
    assert len(results) == 2


# ---------------------------------------------------------------------------
# HyDeRetriever tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_hyde_calls_complete_before_embed():
    """
    HyDeRetriever must call complete() to generate the hypothesis before
    calling embed(). The embed call must receive the hypothesis text, not
    the original query.
    """
    hypothesis = "This is the generated hypothetical answer."
    provider = _MockProvider(
        complete_response=hypothesis,
        embed_vector=[1.0, 0.0, 0.0],
    )
    retriever = HyDeRetriever(corpus=_CORPUS, llm_provider=provider)
    await retriever.retrieve("What is topic A?", top_k=2)

    # complete() must have been called exactly once.
    assert len(provider.complete_calls) == 1

    # The first embed() call must receive the hypothesis, not the raw query.
    assert len(provider.embed_calls) >= 1
    assert provider.embed_calls[0] == hypothesis


@pytest.mark.asyncio
async def test_hyde_hypothesis_stored_in_metadata():
    """
    Every result must carry the generated hypothesis in metadata["hypothesis"]
    so the benchmark UI can display it for interpretability.
    """
    hypothesis = "Generated hypothesis text."
    provider = _MockProvider(complete_response=hypothesis, embed_vector=[1.0, 0.0, 0.0])
    retriever = HyDeRetriever(corpus=_CORPUS, llm_provider=provider)
    results = await retriever.retrieve("test query", top_k=2)

    assert all(r.metadata.get("hypothesis") == hypothesis for r in results)


@pytest.mark.asyncio
async def test_hyde_invalid_length_raises():
    """Constructing with an unsupported hypothetical_doc_length raises ValueError."""
    with pytest.raises(ValueError):
        HyDeRetriever(corpus=_CORPUS, hypothetical_doc_length="huge")


# ---------------------------------------------------------------------------
# MultiQueryRetriever tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_multiquery_deduplicates_by_chunk_id():
    """
    When all query variants produce the same ranking (identical embeddings),
    the merged result must have no duplicate chunk_ids.
    """
    provider = _MockProvider(
        complete_response="reworded query one\nreworded query two",
        embed_vector=[1.0, 0.0, 0.0],
    )
    retriever = MultiQueryRetriever(
        corpus=_CORPUS, num_variants=2, llm_provider=provider
    )
    # Request all chunks to expose any duplicates.
    results = await retriever.retrieve("original query", top_k=len(_CORPUS))

    chunk_ids = [r.chunk_id for r in results]
    assert len(chunk_ids) == len(set(chunk_ids)), "Duplicate chunk_ids found after merge"


@pytest.mark.asyncio
async def test_multiquery_returns_at_most_top_k():
    """The merged result must contain no more than top_k items."""
    provider = _MockProvider(
        complete_response="variant one\nvariant two\nvariant three",
        embed_vector=[1.0, 0.0, 0.0],
    )
    retriever = MultiQueryRetriever(
        corpus=_CORPUS, num_variants=3, llm_provider=provider
    )
    results = await retriever.retrieve("test query", top_k=2)
    assert len(results) == 2


@pytest.mark.asyncio
async def test_multiquery_matched_variants_in_metadata():
    """
    Each result must carry metadata["matched_variants"] listing the query
    variants that retrieved it.
    """
    provider = _MockProvider(
        complete_response="variant one\nvariant two",
        embed_vector=[1.0, 0.0, 0.0],
    )
    retriever = MultiQueryRetriever(
        corpus=_CORPUS, num_variants=2, llm_provider=provider
    )
    results = await retriever.retrieve("test query", top_k=3)

    for r in results:
        assert "matched_variants" in r.metadata
        assert isinstance(r.metadata["matched_variants"], list)


# ---------------------------------------------------------------------------
# HybridRetriever tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_hybrid_calls_dense_path():
    """
    HybridRetriever must call embed() to run the dense retrieval path.
    The BM25 path runs automatically without any provider call.
    """
    provider = _MockProvider(embed_vector=[1.0, 0.0, 0.0])
    retriever = HybridRetriever(corpus=_CORPUS, llm_provider=provider)
    await retriever.retrieve("test query", top_k=3)

    # embed() must be called exactly once (the dense path).
    assert len(provider.embed_calls) == 1


@pytest.mark.asyncio
async def test_hybrid_results_carry_both_raw_scores():
    """
    Every result must expose metadata["bm25_score"] and metadata["dense_score"]
    so the benchmark UI can show how each retrieval path contributed.
    """
    provider = _MockProvider(embed_vector=[1.0, 0.0, 0.0])
    retriever = HybridRetriever(corpus=_CORPUS, llm_provider=provider)
    results = await retriever.retrieve("test query", top_k=3)

    for r in results:
        assert "bm25_score" in r.metadata
        assert "dense_score" in r.metadata
        assert isinstance(r.metadata["bm25_score"], float)
        assert isinstance(r.metadata["dense_score"], float)


@pytest.mark.asyncio
async def test_hybrid_bm25_weight_affects_ranking():
    """
    At bm25_weight=1.0 (pure BM25), the top result should be the chunk whose
    content best matches the query keywords. At bm25_weight=0.0 (pure dense),
    the top result should be the chunk closest in embedding space.

    Corpus c0 has embedding [1,0,0] (best dense match for query [1,0,0]) and
    content "alpha document about topic A" (no keyword overlap with "topic C").
    Corpus c4 has content "epsilon document about topic C" (keyword match for
    "topic C") and embedding [0,0,1] (worst dense match for [1,0,0]).
    """
    bm25_heavy = HybridRetriever(
        corpus=_CORPUS, bm25_weight=1.0,
        llm_provider=_MockProvider(embed_vector=[1.0, 0.0, 0.0])
    )
    dense_heavy = HybridRetriever(
        corpus=_CORPUS, bm25_weight=0.0,
        llm_provider=_MockProvider(embed_vector=[1.0, 0.0, 0.0])
    )

    bm25_results = await bm25_heavy.retrieve("topic C", top_k=1)
    dense_results = await dense_heavy.retrieve("topic C", top_k=1)

    # BM25-heavy should surface the keyword-matching chunk.
    assert bm25_results[0].chunk_id == "c4"
    # Dense-heavy should surface the embedding-nearest chunk.
    assert dense_results[0].chunk_id == "c0"


@pytest.mark.asyncio
async def test_hybrid_returns_correct_number_of_results():
    """HybridRetriever must return exactly top_k results."""
    provider = _MockProvider(embed_vector=[1.0, 0.0, 0.0])
    retriever = HybridRetriever(corpus=_CORPUS, llm_provider=provider)
    results = await retriever.retrieve("test query", top_k=3)
    assert len(results) == 3


# ---------------------------------------------------------------------------
# param_schema contract tests (all four strategies)
# ---------------------------------------------------------------------------

REQUIRED_SCHEMA_KEYS = {"name", "type", "default", "min", "max", "description"}


@pytest.mark.parametrize("strategy_name", ["naive", "hyde", "multiquery", "hybrid"])
def test_param_schema_is_present_and_non_empty(strategy_name):
    """Every registered retriever must expose a non-empty param_schema list."""
    cls = registry[strategy_name]
    assert isinstance(cls.param_schema, list)
    assert len(cls.param_schema) > 0


@pytest.mark.parametrize("strategy_name", ["naive", "hyde", "multiquery", "hybrid"])
def test_param_schema_entries_have_required_keys(strategy_name):
    """Every param_schema entry must contain all six required keys."""
    cls = registry[strategy_name]
    for entry in cls.param_schema:
        missing = REQUIRED_SCHEMA_KEYS - entry.keys()
        assert not missing, (
            f"{strategy_name} param_schema entry {entry.get('name', '?')} "
            f"is missing keys: {missing}"
        )


# ---------------------------------------------------------------------------
# Registry discovery
# ---------------------------------------------------------------------------

def test_all_four_retrievers_are_registered():
    """All four retrieval strategies must be present in the registry."""
    for name in ("naive", "hyde", "multiquery", "hybrid"):
        assert name in registry, f"'{name}' not found in registry"
