"""
Tests for ContextualCompressor post-retrieval processing.

All LLM calls are replaced with a sequential mock provider that returns
configurable responses in order, so no network calls are made and test
outcomes are fully deterministic.

Tests verify: content replacement, original content preservation,
compression ratio calculation, short-chunk dropping, order preservation,
metadata merging from different retriever outputs, and edge cases.
"""

import pytest

from backend.retrieval.base import RetrievalResult
from backend.retrieval.contextual_compression import ContextualCompressor


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_result(
    chunk_id: str,
    content: str,
    score: float = 0.9,
    metadata: dict | None = None,
) -> RetrievalResult:
    """
    Construct a RetrievalResult for use in compression tests.

    Parameters
    ----------
    chunk_id : str
        Unique identifier for the chunk.
    content : str
        Text content of the chunk.
    score : float
        Retrieval score (arbitrary in these tests, just needs to be present).
    metadata : dict, optional
        Any pre-existing retriever metadata to attach.

    Returns
    -------
    RetrievalResult
        Fully constructed result object.
    """
    return RetrievalResult(
        chunk_id=chunk_id,
        content=content,
        score=score,
        latency_ms=12.0,
        metadata=metadata or {},
    )


class _SequentialProvider:
    """
    Mock LLM provider that returns responses from a pre-set list in order.

    The i-th call to complete() / complete_sync() returns responses[i]. If
    more calls are made than responses provided, the last response is repeated.
    This lets tests configure per-chunk compression outcomes precisely.

    complete_sync() is the variant called by ContextualCompressor.compress()
    in the background task execution path (httpx.Client, no anyio dependency).
    Both variants share the same counter and response list so test assertions
    work regardless of which variant is called.
    """

    def __init__(self, responses: list[str]) -> None:
        """
        Initialise with an ordered list of responses.

        Parameters
        ----------
        responses : list[str]
            Strings to return on successive complete() / complete_sync() calls.
        """
        self.responses = responses
        self.call_count = 0
        self.prompts_received: list[str] = []

    def _next_response(self, prompt: str) -> str:
        """Return the next configured response and record the prompt."""
        self.prompts_received.append(prompt)
        idx = min(self.call_count, len(self.responses) - 1)
        self.call_count += 1
        return self.responses[idx]

    async def complete(self, prompt: str) -> str:
        """Async variant: return the next configured response."""
        return self._next_response(prompt)

    def complete_sync(self, prompt: str) -> str:
        """Sync variant: return the next configured response (used by compress())."""
        return self._next_response(prompt)


# ---------------------------------------------------------------------------
# Content replacement tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_compressed_text_replaces_content_field():
    """
    The content field of a surviving result must equal the LLM's compressed
    output, not the original chunk text.
    """
    original = "The sky is blue. Photosynthesis uses sunlight. Water boils at 100 degrees."
    compressed = "Water boils at 100 degrees."
    provider = _SequentialProvider([compressed])
    compressor = ContextualCompressor(min_relevance_length=10, llm_provider=provider)

    results = await compressor.compress(
        [_make_result("c0", original)], "What temperature does water boil at?"
    )

    assert len(results) == 1
    assert results[0].content == compressed


@pytest.mark.asyncio
async def test_original_content_stored_in_metadata():
    """
    The original pre-compression text must be stored in
    metadata["original_content"] so it is not permanently lost.
    """
    original = "Sentence one about topic A. Sentence two about topic B."
    compressed = "Sentence one about topic A."
    provider = _SequentialProvider([compressed])
    compressor = ContextualCompressor(min_relevance_length=10, llm_provider=provider)

    results = await compressor.compress(
        [_make_result("c0", original)], "Tell me about topic A."
    )

    assert results[0].metadata["original_content"] == original


@pytest.mark.asyncio
async def test_compression_ratio_stored_in_metadata():
    """
    metadata["compression_ratio"] must equal len(compressed) / len(original),
    giving the benchmark UI a numeric measure of how much was trimmed.
    """
    original = "A" * 100   # 100 characters
    compressed = "A" * 40  # 40 characters -> ratio 0.4
    provider = _SequentialProvider([compressed])
    compressor = ContextualCompressor(min_relevance_length=20, llm_provider=provider)

    results = await compressor.compress(
        [_make_result("c0", original)], "test query"
    )

    assert abs(results[0].metadata["compression_ratio"] - 0.4) < 1e-9


# ---------------------------------------------------------------------------
# Chunk dropping tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_chunk_below_min_length_is_dropped():
    """
    A chunk whose compressed text is shorter than min_relevance_length must
    be dropped from the output entirely.
    """
    provider = _SequentialProvider(["no"])  # 2 chars, below any sensible minimum
    compressor = ContextualCompressor(min_relevance_length=50, llm_provider=provider)

    results = await compressor.compress(
        [_make_result("c0", "Long original text with many words.")], "test query"
    )

    assert results == []


@pytest.mark.asyncio
async def test_mix_of_kept_and_dropped_chunks():
    """
    Only chunks whose compressed text meets the min_relevance_length threshold
    survive. Chunks that do not are dropped and the survivors maintain their
    original relative order.
    """
    long_response = "This sentence is relevant and long enough to keep."  # 50 chars
    short_response = "No."                                                  # 3 chars

    provider = _SequentialProvider([long_response, short_response, long_response])
    compressor = ContextualCompressor(min_relevance_length=20, llm_provider=provider)

    results = await compressor.compress(
        [
            _make_result("c0", "Chunk zero original content."),
            _make_result("c1", "Chunk one original content."),
            _make_result("c2", "Chunk two original content."),
        ],
        "test query",
    )

    # c1 is dropped; c0 and c2 survive in original order.
    assert len(results) == 2
    assert results[0].chunk_id == "c0"
    assert results[1].chunk_id == "c2"


@pytest.mark.asyncio
async def test_all_chunks_dropped_returns_empty_list():
    """
    If every compressed chunk is below min_relevance_length, the result is
    an empty list, not an error.
    """
    provider = _SequentialProvider([""])
    compressor = ContextualCompressor(min_relevance_length=50, llm_provider=provider)

    results = await compressor.compress(
        [_make_result("c0", "Some text."), _make_result("c1", "More text.")],
        "query",
    )

    assert results == []


@pytest.mark.asyncio
async def test_empty_input_returns_empty_list():
    """Passing an empty result list must return an empty list with no error."""
    provider = _SequentialProvider(["anything"])
    compressor = ContextualCompressor(llm_provider=provider)

    results = await compressor.compress([], "query")

    assert results == []
    # No LLM calls should have been made.
    assert provider.call_count == 0


# ---------------------------------------------------------------------------
# Immutability and metadata preservation tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_score_and_chunk_id_are_preserved():
    """
    Compression must not alter chunk_id, score, or latency_ms -- only content
    and metadata change.
    """
    original_result = _make_result("chunk-xyz", "original text here", score=0.87)
    compressed_text = "original text here compressed version that is long enough"
    provider = _SequentialProvider([compressed_text])
    compressor = ContextualCompressor(min_relevance_length=10, llm_provider=provider)

    results = await compressor.compress([original_result], "test query")

    assert results[0].chunk_id == "chunk-xyz"
    assert results[0].score == 0.87
    assert results[0].latency_ms == 12.0


@pytest.mark.asyncio
async def test_existing_retriever_metadata_is_preserved():
    """
    Metadata attached by the retriever (e.g. hypothesis from HyDE, matched
    variants from multi-query) must survive compression alongside the new
    compression-specific keys.
    """
    retriever_metadata = {
        "hypothesis": "A plausible answer the LLM generated.",
        "matched_variants": ["query v1", "query v2"],
    }
    compressed_text = "The relevant sentence from the passage that answers the question."
    provider = _SequentialProvider([compressed_text])
    compressor = ContextualCompressor(min_relevance_length=10, llm_provider=provider)

    results = await compressor.compress(
        [_make_result("c0", "Full passage text.", metadata=retriever_metadata)],
        "test query",
    )

    assert results[0].metadata["hypothesis"] == "A plausible answer the LLM generated."
    assert results[0].metadata["matched_variants"] == ["query v1", "query v2"]
    # Compression keys are also present.
    assert "original_content" in results[0].metadata
    assert "compression_ratio" in results[0].metadata


# ---------------------------------------------------------------------------
# Compatibility with different retriever outputs
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_works_with_naive_style_results():
    """
    Compressor must handle plain results with no pre-existing metadata, as
    produced by NaiveRetriever.
    """
    compressed = "Relevant extracted sentence from the naive result."
    provider = _SequentialProvider([compressed])
    compressor = ContextualCompressor(min_relevance_length=10, llm_provider=provider)

    naive_result = RetrievalResult(
        chunk_id="naive-0",
        content="Full chunk text with multiple sentences. Some relevant. Some not.",
        score=0.91,
        latency_ms=45.3,
    )

    results = await compressor.compress([naive_result], "find the relevant sentence")

    assert len(results) == 1
    assert results[0].content == compressed
    assert results[0].chunk_id == "naive-0"


@pytest.mark.asyncio
async def test_works_with_hybrid_style_results():
    """
    Compressor must preserve hybrid retriever metadata (bm25_score,
    dense_score) while adding its own keys on top.
    """
    compressed = "The specific sentence relevant to the query about fusion scoring."
    provider = _SequentialProvider([compressed])
    compressor = ContextualCompressor(min_relevance_length=10, llm_provider=provider)

    hybrid_result = RetrievalResult(
        chunk_id="hybrid-0",
        content="BM25 matched text. Dense matched text. Other text.",
        score=0.77,
        latency_ms=88.1,
        metadata={"bm25_score": 3.2, "dense_score": 0.85},
    )

    results = await compressor.compress([hybrid_result], "fusion scoring query")

    assert results[0].metadata["bm25_score"] == 3.2
    assert results[0].metadata["dense_score"] == 0.85
    assert results[0].metadata["original_content"] == hybrid_result.content


# ---------------------------------------------------------------------------
# LLM call count
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_one_llm_call_per_chunk():
    """
    The compressor must call complete() exactly once per input chunk, not
    more (batching not implemented) and not fewer (lazy skipping not allowed).
    """
    response = "A sufficiently long relevant sentence that passes the threshold check."
    provider = _SequentialProvider([response, response, response])
    compressor = ContextualCompressor(min_relevance_length=10, llm_provider=provider)

    await compressor.compress(
        [
            _make_result("c0", "text a"),
            _make_result("c1", "text b"),
            _make_result("c2", "text c"),
        ],
        "query",
    )

    assert provider.call_count == 3
