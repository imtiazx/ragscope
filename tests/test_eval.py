"""
Tests for the RAGAS evaluation runner and database helper functions.

All asyncpg calls are replaced with an in-memory mock connection that records
every execute() call. RAGAS, dataset imports, and OpenAI answer generation are
patched at the module level so tests pass without a live database, a live
OpenAI key, or the ragas/datasets packages installed.

Test focus:
  - Status transitions: pending -> running -> completed
  - Failure handling: status='failed' and error_message written on any exception
  - get_run: correct dict shape with JSON-safe field types
  - run_evaluation safety: never raises, even when inner work fails
"""

import datetime
import uuid
from unittest.mock import AsyncMock, patch

import pytest

from backend.eval.ragas_runner import run_evaluation, get_run, _row_to_dict
from backend.retrieval.base import RetrievalResult


# ---------------------------------------------------------------------------
# Mock infrastructure
# ---------------------------------------------------------------------------

class _MockConnection:
    """
    In-memory stand-in for an asyncpg connection.

    Records every execute() call as a (query_string, args_tuple) pair so
    tests can assert on what SQL was sent and with what parameters.
    fetchrow() returns whatever _fetchrow_result is set to.
    """

    def __init__(self) -> None:
        """Initialise with empty call log and no fetchrow result."""
        self.execute_calls: list[tuple[str, tuple]] = []
        self._fetchrow_result = None

    async def execute(self, query: str, *args) -> None:
        """Record the call; do not actually touch a database."""
        self.execute_calls.append((query, args))

    async def fetchrow(self, query: str, *args):
        """Return the pre-configured result dict."""
        return self._fetchrow_result


class _MockAcquireCtx:
    """Async context manager that yields a fixed connection object."""

    def __init__(self, conn: _MockConnection) -> None:
        """Store the connection to yield."""
        self._conn = conn

    async def __aenter__(self) -> _MockConnection:
        """Return the connection when entering the `async with` block."""
        return self._conn

    async def __aexit__(self, *args) -> None:
        """No cleanup needed for an in-memory mock."""


class _MockPool:
    """
    Mock asyncpg pool whose acquire() returns a _MockAcquireCtx.

    Every call to acquire() returns the same connection object, so all
    execute() calls in a single test are recorded on the same instance.
    """

    def __init__(self, conn: _MockConnection) -> None:
        """Store the connection that acquire() will expose."""
        self._conn = conn

    def acquire(self) -> _MockAcquireCtx:
        """Return an async context manager wrapping the fixed connection."""
        return _MockAcquireCtx(self._conn)


class _MockRetriever:
    """
    Minimal retriever substitute that returns one fixed RetrievalResult.

    Used as the class stored in the mock retrieval_registry dict. The
    benchmark runner calls `cls(corpus=..., **params)` then `.retrieve()`,
    so we need both an __init__ and an async retrieve method.
    """

    def __init__(self, corpus: list, **kwargs) -> None:
        """Accept and ignore all construction arguments."""

    async def retrieve(self, query: str, top_k: int) -> list[RetrievalResult]:
        """Return a single hard-coded result regardless of the query."""
        return [
            RetrievalResult(
                chunk_id="c0",
                content="mock retrieved content",
                score=0.9,
                latency_ms=10.0,
            )
        ]


# Shared mock RAGAS scores returned by the patched _run_ragas.
_MOCK_SCORES = {
    "faithfulness": 0.92,
    "context_utilization": 0.85,
    "answer_relevancy": 0.88,
}

# Minimal corpus entry -- format required by all retriever constructors.
_CORPUS = [{"chunk_id": "c0", "content": "test content", "embedding": [1.0, 0.0, 0.0]}]

# Fixed run_id used across tests.
_RUN_ID = str(uuid.uuid4())


def _make_pool_and_conn() -> tuple[_MockPool, _MockConnection]:
    """Create a paired mock pool and connection for use in a test."""
    conn = _MockConnection()
    return _MockPool(conn), conn


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _queries(conn: _MockConnection) -> list[str]:
    """Extract just the query strings from a connection's execute call log."""
    return [call[0] for call in conn.execute_calls]


def _find_call_with(conn: _MockConnection, keyword: str) -> tuple[str, tuple] | None:
    """Return the first execute call whose query contains keyword, or None."""
    for query, args in conn.execute_calls:
        if keyword in query:
            return query, args
    return None


# ---------------------------------------------------------------------------
# Status transition tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_status_transitions_to_running_then_completed():
    """
    run_evaluation must update status to 'running' before any work begins
    and to 'completed' after all work succeeds, in that order.
    """
    pool, conn = _make_pool_and_conn()

    with patch("backend.eval.ragas_runner.get_pool", new_callable=AsyncMock) as mock_gp, \
         patch("backend.eval.ragas_runner.retrieval_registry", {"naive": _MockRetriever}), \
         patch("backend.eval.ragas_runner._generate_answer", new_callable=AsyncMock) as mock_gen, \
         patch("backend.eval.ragas_runner._run_ragas", new_callable=AsyncMock) as mock_ragas:

        mock_gp.return_value = pool
        mock_gen.return_value = "generated answer text"
        mock_ragas.return_value = _MOCK_SCORES

        await run_evaluation(
            run_id=_RUN_ID,
            retrieval_strategy="naive",
            chunker_strategy="fixed_size",
            retrieval_params={"top_k": 3},
            chunker_params={},
            compression_enabled=False,
            compression_params={},
            corpus=_CORPUS,
            question="What is the answer?",
            corpus_hash="hash123",
        )

    queries = _queries(conn)
    assert any("running" in q for q in queries), "Status was never set to 'running'"
    assert any("completed" in q for q in queries), "Status was never set to 'completed'"

    # running must come before completed in execution order.
    running_pos = next(i for i, q in enumerate(queries) if "running" in q)
    completed_pos = next(i for i, q in enumerate(queries) if "completed" in q)
    assert running_pos < completed_pos


@pytest.mark.asyncio
async def test_completed_run_writes_all_metric_fields():
    """
    After a successful run, the completed UPDATE must include faithfulness,
    context_utilization, answer_relevancy, and latency_ms as parameters.
    """
    pool, conn = _make_pool_and_conn()

    with patch("backend.eval.ragas_runner.get_pool", new_callable=AsyncMock) as mock_gp, \
         patch("backend.eval.ragas_runner.retrieval_registry", {"naive": _MockRetriever}), \
         patch("backend.eval.ragas_runner._generate_answer", new_callable=AsyncMock) as mock_gen, \
         patch("backend.eval.ragas_runner._run_ragas", new_callable=AsyncMock) as mock_ragas:

        mock_gp.return_value = pool
        mock_gen.return_value = "answer"
        mock_ragas.return_value = _MOCK_SCORES

        await run_evaluation(
            run_id=_RUN_ID,
            retrieval_strategy="naive",
            chunker_strategy="fixed_size",
            retrieval_params={"top_k": 5},
            chunker_params={},
            compression_enabled=False,
            compression_params={},
            corpus=_CORPUS,
            question="test question",
            corpus_hash="h1",
        )

    # Find the UPDATE that sets status='completed' and check its args.
    completed_call = _find_call_with(conn, "completed")
    assert completed_call is not None

    _, args = completed_call
    # args: (retrieved_chunks, generated_answer, faithfulness, context_utilization,
    #        answer_relevancy, latency_ms, run_uuid)
    assert 0.92 in args, "faithfulness score not found in args"
    assert 0.85 in args, "context_utilization score not found in args"
    assert 0.88 in args, "answer_relevancy score not found in args"
    assert "answer" in args, "generated answer not found in args"


# ---------------------------------------------------------------------------
# Failure handling tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_failed_run_sets_status_to_failed():
    """
    When _run_ragas raises, run_evaluation must set status='failed' rather
    than propagating the exception or leaving the row in 'running' state.
    """
    pool, conn = _make_pool_and_conn()

    with patch("backend.eval.ragas_runner.get_pool", new_callable=AsyncMock) as mock_gp, \
         patch("backend.eval.ragas_runner.retrieval_registry", {"naive": _MockRetriever}), \
         patch("backend.eval.ragas_runner._generate_answer", new_callable=AsyncMock) as mock_gen, \
         patch("backend.eval.ragas_runner._run_ragas", new_callable=AsyncMock) as mock_ragas:

        mock_gp.return_value = pool
        mock_gen.return_value = "answer"
        mock_ragas.side_effect = RuntimeError("RAGAS evaluation failed")

        await run_evaluation(
            run_id=_RUN_ID,
            retrieval_strategy="naive",
            chunker_strategy="fixed_size",
            retrieval_params={"top_k": 5},
            chunker_params={},
            compression_enabled=False,
            compression_params={},
            corpus=_CORPUS,
            question="test question",
            corpus_hash="h1",
        )

    queries = _queries(conn)
    assert any("failed" in q for q in queries), "Status was never set to 'failed'"
    # 'completed' must NOT appear -- the run did not succeed.
    assert not any("completed" in q for q in queries)


@pytest.mark.asyncio
async def test_failed_run_writes_error_message():
    """
    The exception message must be written to error_message so the frontend
    can display a human-readable failure reason.
    """
    pool, conn = _make_pool_and_conn()
    error_text = "Connection to RAGAS LLM judge timed out"

    with patch("backend.eval.ragas_runner.get_pool", new_callable=AsyncMock) as mock_gp, \
         patch("backend.eval.ragas_runner.retrieval_registry", {"naive": _MockRetriever}), \
         patch("backend.eval.ragas_runner._generate_answer", new_callable=AsyncMock) as mock_gen, \
         patch("backend.eval.ragas_runner._run_ragas", new_callable=AsyncMock) as mock_ragas:

        mock_gp.return_value = pool
        mock_gen.return_value = "answer"
        mock_ragas.side_effect = RuntimeError(error_text)

        await run_evaluation(
            run_id=_RUN_ID,
            retrieval_strategy="naive",
            chunker_strategy="fixed_size",
            retrieval_params={"top_k": 5},
            chunker_params={},
            compression_enabled=False,
            compression_params={},
            corpus=_CORPUS,
            question="test question",
            corpus_hash="h1",
        )

    failed_call = _find_call_with(conn, "failed")
    assert failed_call is not None
    _, args = failed_call
    # First positional arg is error_message; it must contain the exception text.
    assert error_text in args[0], f"Error text not found in args: {args}"


@pytest.mark.asyncio
async def test_run_evaluation_never_raises():
    """
    run_evaluation must swallow all exceptions and return None, even when the
    inner failure handler also fails. An unhandled exception in a background
    task would silently kill it with no way to report the failure to the user.
    """
    pool, conn = _make_pool_and_conn()

    # Make the failure-handler's execute() also raise to stress-test the
    # double try/except guard.
    call_count = 0

    async def always_raise(query: str, *args) -> None:
        nonlocal call_count
        call_count += 1
        raise RuntimeError("DB completely unavailable")

    conn.execute = always_raise

    with patch("backend.eval.ragas_runner.get_pool", new_callable=AsyncMock) as mock_gp, \
         patch("backend.eval.ragas_runner.retrieval_registry", {"naive": _MockRetriever}), \
         patch("backend.eval.ragas_runner._generate_answer", new_callable=AsyncMock) as mock_gen, \
         patch("backend.eval.ragas_runner._run_ragas", new_callable=AsyncMock) as mock_ragas:

        mock_gp.return_value = pool
        mock_gen.return_value = "answer"
        mock_ragas.return_value = _MOCK_SCORES

        # Must return normally -- no exception should escape.
        result = await run_evaluation(
            run_id=_RUN_ID,
            retrieval_strategy="naive",
            chunker_strategy="fixed_size",
            retrieval_params={"top_k": 5},
            chunker_params={},
            compression_enabled=False,
            compression_params={},
            corpus=_CORPUS,
            question="test question",
            corpus_hash="h1",
        )

    assert result is None  # run_evaluation always returns None


@pytest.mark.asyncio
async def test_retrieval_failure_is_caught_as_failed():
    """
    If retrieval itself raises (e.g. invalid strategy name), the run must
    be marked 'failed', not 'running' forever.
    """
    pool, conn = _make_pool_and_conn()

    class _ExplodingRetriever:
        def __init__(self, corpus, **kwargs):
            pass

        async def retrieve(self, query, top_k):
            raise ValueError("Corpus is empty")

    with patch("backend.eval.ragas_runner.get_pool", new_callable=AsyncMock) as mock_gp, \
         patch("backend.eval.ragas_runner.retrieval_registry",
               {"naive": _ExplodingRetriever}):

        mock_gp.return_value = pool

        await run_evaluation(
            run_id=_RUN_ID,
            retrieval_strategy="naive",
            chunker_strategy="fixed_size",
            retrieval_params={"top_k": 5},
            chunker_params={},
            compression_enabled=False,
            compression_params={},
            corpus=_CORPUS,
            question="test question",
            corpus_hash="h1",
        )

    assert any("failed" in q for q in _queries(conn))
    failed_call = _find_call_with(conn, "failed")
    assert "Corpus is empty" in failed_call[1][0]


# ---------------------------------------------------------------------------
# get_run tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_run_returns_correct_fields():
    """
    get_run must return a plain dict with all benchmark_runs columns.
    UUID and datetime values must be converted to strings for JSON safety.
    """
    run_uuid = uuid.UUID("a7f3c2d1-1234-5678-9abc-def012345678")
    created = datetime.datetime(2024, 6, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)

    mock_row = {
        "id": run_uuid,
        "created_at": created,
        "status": "completed",
        "retrieval_strategy": "hybrid",
        "chunker_strategy": "semantic",
        "retrieval_params": {"top_k": 5, "bm25_weight": 0.5},
        "chunker_params": {"similarity_threshold": 0.6},
        "compression_enabled": False,
        "compression_params": {},
        "corpus_hash": "sha256abc",
        "question": "What is RAG?",
        "retrieved_chunks": [{"chunk_id": "c0", "content": "text", "score": 0.9}],
        "generated_answer": "RAG stands for retrieval-augmented generation.",
        "faithfulness": 0.91,
        "context_utilization": 0.87,
        "answer_relevancy": 0.93,
        "latency_ms": 312.5,
        "error_message": None,
    }

    pool, conn = _make_pool_and_conn()
    conn._fetchrow_result = mock_row

    with patch("backend.eval.ragas_runner.get_pool", new_callable=AsyncMock) as mock_gp:
        mock_gp.return_value = pool
        result = await get_run(str(run_uuid))

    assert result is not None
    # UUID converted to string.
    assert result["id"] == "a7f3c2d1-1234-5678-9abc-def012345678"
    # Datetime converted to ISO string.
    assert result["created_at"] == "2024-06-01T12:00:00+00:00"
    # Scalar fields preserved as-is.
    assert result["status"] == "completed"
    assert result["faithfulness"] == 0.91
    assert result["question"] == "What is RAG?"
    # JSONB fields preserved as Python objects (list/dict).
    assert isinstance(result["retrieved_chunks"], list)
    assert isinstance(result["retrieval_params"], dict)


@pytest.mark.asyncio
async def test_get_run_returns_none_for_missing_id():
    """
    get_run must return None when no row exists for the given UUID so the
    results router can translate that to a 404 response.
    """
    pool, conn = _make_pool_and_conn()
    conn._fetchrow_result = None  # fetchrow returns None when no row found

    with patch("backend.eval.ragas_runner.get_pool", new_callable=AsyncMock) as mock_gp:
        mock_gp.return_value = pool
        result = await get_run(str(uuid.uuid4()))

    assert result is None


# ---------------------------------------------------------------------------
# _row_to_dict unit tests (no DB needed)
# ---------------------------------------------------------------------------

def test_row_to_dict_converts_uuid_to_string():
    """UUID fields must be converted to their string representation."""
    run_uuid = uuid.UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    row = {"id": run_uuid, "status": "pending", "created_at": None}
    result = _row_to_dict(row)
    assert result["id"] == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    assert isinstance(result["id"], str)


def test_row_to_dict_converts_datetime_to_iso():
    """TIMESTAMPTZ fields must be converted to ISO 8601 strings."""
    dt = datetime.datetime(2025, 1, 15, 9, 30, 0, tzinfo=datetime.timezone.utc)
    row = {"id": None, "created_at": dt, "status": "running"}
    result = _row_to_dict(row)
    assert result["created_at"] == "2025-01-15T09:30:00+00:00"
    assert isinstance(result["created_at"], str)


def test_row_to_dict_handles_null_id_and_created_at():
    """None values for id and created_at must pass through unchanged."""
    row = {"id": None, "created_at": None, "status": "pending"}
    result = _row_to_dict(row)
    assert result["id"] is None
    assert result["created_at"] is None
