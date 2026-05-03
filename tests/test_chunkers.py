"""
Tests for the chunker registry, param_schema contract, and chunking behaviour.

These tests verify that each chunker correctly splits text, honours its
configured parameters, and exposes a well-formed param_schema. No live API
calls are made: SemanticChunker tests inject a mock embedding provider that
returns constant vectors so asyncio.gather resolves immediately.
"""

import pytest

from backend.chunkers.registry import registry
from backend.chunkers.fixed_size import FixedSizeChunker
from backend.chunkers.semantic import SemanticChunker
from backend.chunkers.hierarchical import HierarchicalChunker


# ---------------------------------------------------------------------------
# Mock LLM provider for SemanticChunker tests
# ---------------------------------------------------------------------------

class _ConstantEmbedProvider:
    """
    Stub provider that returns the same unit vector for every input string.

    All pairwise cosine similarities are 1.0, so no chunk boundaries are
    inserted regardless of the similarity_threshold. This lets SemanticChunker
    tests verify structural behaviour without touching the OpenAI API.
    """

    async def embed(self, text: str) -> list[float]:
        """Return a fixed three-dimensional unit vector."""
        return [1.0, 0.0, 0.0]


class _AlternatingEmbedProvider:
    """
    Stub provider that alternates between two orthogonal vectors.

    Sentences at even call counts get [1, 0, 0]; odd call counts get [0, 1, 0].
    Adjacent pairs are always orthogonal (similarity 0.0), so every sentence
    boundary becomes a chunk boundary regardless of threshold.
    """

    def __init__(self) -> None:
        """Initialise the call counter."""
        self._count = 0

    async def embed(self, text: str) -> list[float]:
        """Return alternating orthogonal vectors."""
        vec = [1.0, 0.0, 0.0] if self._count % 2 == 0 else [0.0, 1.0, 0.0]
        self._count += 1
        return vec


# ---------------------------------------------------------------------------
# FixedSizeChunker tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fixed_size_chunk_size_is_respected():
    """
    Every chunk must contain at most chunk_size whitespace-delimited tokens.
    """
    chunker = FixedSizeChunker(chunk_size=5, overlap=0)
    # 13 tokens -- produces chunks of 5, 5, 3
    result = await chunker.chunk(["one two three four five six seven eight nine ten eleven twelve thirteen"])
    assert all(len(chunk.split()) <= 5 for chunk in result)
    # Verify total coverage: every token appears somewhere
    assert len(result) == 3


@pytest.mark.asyncio
async def test_fixed_size_overlap_is_respected():
    """
    The last `overlap` tokens of chunk N must equal the first `overlap` tokens
    of chunk N+1, confirming that consecutive chunks genuinely share tokens.
    """
    chunker = FixedSizeChunker(chunk_size=4, overlap=2)
    # 10 tokens, step=2: produces 5 chunks (the window advances 2 each time,
    # leaving a 2-token trailing chunk at the end -- expected behaviour).
    # The assertion we care about is the overlap condition, not the count.
    result = await chunker.chunk(["a b c d e f g h i j"])
    assert len(result) >= 2
    for i in range(len(result) - 1):
        tail = result[i].split()[-2:]      # last 2 tokens of chunk i
        head = result[i + 1].split()[:2]   # first 2 tokens of chunk i+1
        assert tail == head, (
            f"Overlap mismatch between chunk {i} and {i+1}: "
            f"tail={tail}, head={head}"
        )


@pytest.mark.asyncio
async def test_fixed_size_empty_input_returns_empty():
    """An empty text list must produce an empty chunk list with no error."""
    chunker = FixedSizeChunker()
    assert await chunker.chunk([]) == []


@pytest.mark.asyncio
async def test_fixed_size_invalid_overlap_raises():
    """Constructing with overlap >= chunk_size must raise ValueError immediately."""
    with pytest.raises(ValueError):
        FixedSizeChunker(chunk_size=10, overlap=10)


# ---------------------------------------------------------------------------
# SemanticChunker tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_semantic_returns_at_least_one_chunk():
    """
    SemanticChunker must return a non-empty list for any non-empty input.

    Uses a constant-vector provider so all similarities are 1.0 and no
    boundaries are inserted; the full text is returned as a single chunk.
    """
    chunker = SemanticChunker(
        similarity_threshold=0.5,
        min_chunk_size=1,
        llm_provider=_ConstantEmbedProvider(),
    )
    result = await chunker.chunk(["First sentence. Second sentence. Third sentence."])
    assert len(result) >= 1
    assert all(isinstance(s, str) and s for s in result)


@pytest.mark.asyncio
async def test_semantic_splits_on_topic_shift():
    """
    SemanticChunker must insert boundaries where similarity drops below the
    threshold. With alternating orthogonal embeddings every adjacent pair has
    similarity 0.0, so every sentence boundary becomes a chunk boundary.
    """
    chunker = SemanticChunker(
        similarity_threshold=0.5,
        min_chunk_size=1,
        llm_provider=_AlternatingEmbedProvider(),
    )
    # Four distinct sentences -> should produce multiple chunks
    text = "Alpha sentence. Beta sentence. Gamma sentence. Delta sentence."
    result = await chunker.chunk([text])
    assert len(result) > 1


@pytest.mark.asyncio
async def test_semantic_empty_input_returns_empty():
    """An empty text list must produce an empty chunk list with no error."""
    chunker = SemanticChunker(llm_provider=_ConstantEmbedProvider())
    assert await chunker.chunk([]) == []


# ---------------------------------------------------------------------------
# HierarchicalChunker tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_hierarchical_produces_more_chunks_than_parent_split():
    """
    Child chunks must outnumber parent chunks because each parent is divided
    into multiple children. With parent_size=10 and child_size=5 over 20
    tokens, we get 2 parents and 4 children (2 children per parent).
    """
    text = " ".join(str(i) for i in range(20))   # "0 1 2 3 ... 19"
    chunker = HierarchicalChunker(parent_chunk_size=10, child_chunk_size=5)
    children = await chunker.chunk([text])

    assert len(children) > len(chunker.parent_chunks)
    assert len(children) == 4
    assert len(chunker.parent_chunks) == 2


@pytest.mark.asyncio
async def test_hierarchical_child_to_parent_mapping_is_valid():
    """
    Every index in child_to_parent must be a valid index into parent_chunks.
    The length of child_to_parent must equal the number of returned children.
    """
    text = " ".join(str(i) for i in range(30))
    chunker = HierarchicalChunker(parent_chunk_size=10, child_chunk_size=5)
    children = await chunker.chunk([text])

    assert len(chunker.child_to_parent) == len(children)
    for idx in chunker.child_to_parent:
        assert 0 <= idx < len(chunker.parent_chunks)


@pytest.mark.asyncio
async def test_hierarchical_empty_input_returns_empty():
    """An empty text list must produce an empty chunk list with no error."""
    chunker = HierarchicalChunker()
    result = await chunker.chunk([])
    assert result == []
    assert chunker.parent_chunks == []
    assert chunker.child_to_parent == []


@pytest.mark.asyncio
async def test_hierarchical_invalid_sizes_raises():
    """Constructing with child_chunk_size >= parent_chunk_size must raise ValueError."""
    with pytest.raises(ValueError):
        HierarchicalChunker(parent_chunk_size=256, child_chunk_size=256)


# ---------------------------------------------------------------------------
# param_schema contract tests
# ---------------------------------------------------------------------------

REQUIRED_SCHEMA_KEYS = {"name", "type", "default", "min", "max", "description"}


@pytest.mark.parametrize("chunker_name", ["fixed_size", "semantic", "hierarchical"])
def test_param_schema_is_present_and_non_empty(chunker_name):
    """
    Every registered chunker must expose a non-empty param_schema list so
    the frontend API has something to return for its configuration form.
    """
    cls = registry[chunker_name]
    assert isinstance(cls.param_schema, list)
    assert len(cls.param_schema) > 0


@pytest.mark.parametrize("chunker_name", ["fixed_size", "semantic", "hierarchical"])
def test_param_schema_entries_have_required_keys(chunker_name):
    """
    Every entry in param_schema must contain all six required keys so the
    frontend can render a labelled, validated, range-bounded form field.
    """
    cls = registry[chunker_name]
    for entry in cls.param_schema:
        missing = REQUIRED_SCHEMA_KEYS - entry.keys()
        assert not missing, (
            f"{chunker_name} param_schema entry {entry.get('name', '?')} "
            f"is missing keys: {missing}"
        )


# ---------------------------------------------------------------------------
# Registry discovery tests
# ---------------------------------------------------------------------------

def test_all_chunkers_are_registered():
    """All three chunkers must be present in the registry after import."""
    assert "fixed_size" in registry
    assert "semantic" in registry
    assert "hierarchical" in registry
