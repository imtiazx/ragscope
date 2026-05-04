"""
Integration tests for the three API routers and the utility endpoints.

Uses FastAPI's TestClient (synchronous httpx wrapper) so no running server
is needed. The lifespan create_tables() and close_pool() are mocked so
tests pass without a reachable database. Each individual test mocks only
the database and external-API calls it would actually trigger, nothing more.

TestClient runs FastAPI BackgroundTasks synchronously before returning the
response, so patching run_evaluation is enough to prevent any DB or LLM
work from running during the benchmark endpoint tests.
"""

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from backend.main import app


# ---------------------------------------------------------------------------
# Shared mock infrastructure
# ---------------------------------------------------------------------------

class _MockConn:
    """
    In-memory stand-in for an asyncpg connection inside router tests.

    Records execute() calls and returns a pre-configured value from fetchrow().
    """

    def __init__(self, fetchrow_result=None) -> None:
        """Initialise with optional fetchrow return value."""
        self.execute_calls: list = []
        self._fetchrow_result = fetchrow_result

    async def execute(self, query: str, *args) -> None:
        """Record the call; do nothing."""
        self.execute_calls.append((query, args))

    async def fetchrow(self, query: str, *args):
        """Return the pre-configured result."""
        return self._fetchrow_result


class _MockAcquireCtx:
    """Async context manager that yields a fixed _MockConn."""

    def __init__(self, conn: _MockConn) -> None:
        """Store the connection to yield."""
        self._conn = conn

    async def __aenter__(self) -> _MockConn:
        """Return the connection on entry."""
        return self._conn

    async def __aexit__(self, *args) -> None:
        """Nothing to clean up."""


class _MockPool:
    """Mock asyncpg pool whose acquire() yields a fixed _MockConn."""

    def __init__(self, conn: _MockConn) -> None:
        """Store the connection."""
        self._conn = conn

    def acquire(self) -> _MockAcquireCtx:
        """Return an async context manager wrapping the connection."""
        return _MockAcquireCtx(self._conn)


# ---------------------------------------------------------------------------
# Fixture: TestClient with mocked lifespan
# ---------------------------------------------------------------------------

@pytest.fixture
def client():
    """
    Provide a TestClient whose lifespan startup and shutdown are mocked.

    create_tables() and close_pool() in the lifespan would both try to reach
    a real database. Patching them here lets the TestClient start and stop
    without any network access. The patches are active for the entire client
    lifetime so the lifespan teardown (close_pool) is also a no-op.
    """
    with patch("backend.main.create_tables", new_callable=AsyncMock), \
         patch("backend.main.close_pool", new_callable=AsyncMock):
        with TestClient(app) as c:
            yield c


# ---------------------------------------------------------------------------
# POST /ingest tests
# ---------------------------------------------------------------------------

def test_ingest_rejects_oversized_combined_upload(client):
    """
    POST /ingest must return HTTP 413 when the combined size of all uploaded
    files exceeds MAX_FILE_SIZE_BYTES. The check must happen before any DB
    or embedding work starts.
    """
    # Patch settings on the ingest router so we can use a tiny limit (5 bytes)
    # without uploading a real 10MB file in the test.
    with patch("backend.routers.ingest.settings") as mock_settings:
        mock_settings.max_file_size_bytes = 5
        response = client.post(
            "/ingest",
            files=[("files", ("test.txt", b"hello world", "text/plain"))],
            data={"chunker_strategy": "fixed_size", "chunker_params": "{}"},
        )

    assert response.status_code == 413
    assert "exceeds" in response.json()["detail"].lower()


def test_ingest_returns_existing_corpus_without_reprocessing(client):
    """
    POST /ingest must return HTTP 200 with the cached corpus_hash and chunk
    count when the same files were already ingested, without calling the
    embedder or chunker again.
    """
    with patch("backend.routers.ingest.corpus_exists",
               new_callable=AsyncMock) as mock_exists, \
         patch("backend.routers.ingest.get_chunk_count",
               new_callable=AsyncMock) as mock_count:

        mock_exists.return_value = True
        mock_count.return_value = 42

        response = client.post(
            "/ingest",
            files=[("files", ("doc.txt", b"existing corpus content", "text/plain"))],
            data={"chunker_strategy": "fixed_size", "chunker_params": "{}"},
        )

    assert response.status_code == 200
    body = response.json()
    assert "corpus_hash" in body
    assert body["chunk_count"] == 42
    # corpus_hash must be the sha256 of the uploaded bytes -- 64 hex chars.
    assert len(body["corpus_hash"]) == 64


def test_ingest_new_corpus_returns_201(client):
    """
    POST /ingest must return HTTP 201 with corpus_hash and chunk_count when
    the corpus is genuinely new. All external calls (embed, DB write) are
    mocked so no real API keys or database are needed.
    """
    mock_embedding = [0.1] * 1536

    with patch("backend.routers.ingest.corpus_exists",
               new_callable=AsyncMock) as mock_exists, \
         patch("backend.routers.ingest.store_chunks",
               new_callable=AsyncMock), \
         patch("backend.routers.ingest.OpenAIProvider") as mock_cls:

        mock_exists.return_value = False
        # Make OpenAIProvider().embed() return a fixed vector.
        mock_cls.return_value.embed = AsyncMock(return_value=mock_embedding)

        response = client.post(
            "/ingest",
            files=[("files", ("doc.txt", b"the quick brown fox", "text/plain"))],
            data={"chunker_strategy": "fixed_size", "chunker_params": "{}"},
        )

    assert response.status_code == 201
    body = response.json()
    assert "corpus_hash" in body
    assert body["chunk_count"] >= 1


def test_ingest_rejects_unsupported_file_type(client):
    """
    POST /ingest must return HTTP 422 for file types not in the ingestor
    registry (e.g. .docx, .csv). The error message must identify the
    unsupported extension.
    """
    with patch("backend.routers.ingest.corpus_exists",
               new_callable=AsyncMock) as mock_exists:
        mock_exists.return_value = False
        response = client.post(
            "/ingest",
            files=[("files", ("report.docx", b"binary content", "application/octet-stream"))],
            data={"chunker_strategy": "fixed_size", "chunker_params": "{}"},
        )

    assert response.status_code == 422
    assert ".docx" in response.json()["detail"]


# ---------------------------------------------------------------------------
# POST /benchmark tests
# ---------------------------------------------------------------------------

def test_benchmark_returns_404_for_unknown_corpus_hash(client):
    """
    POST /benchmark must return HTTP 404 if the corpus_hash has not been
    ingested. The corpus check fires before the rate limit check, so no
    rate limit mocks are needed -- the 404 is returned first.
    """
    with patch("backend.routers.benchmark.corpus_exists",
               new_callable=AsyncMock) as mock_exists:
        mock_exists.return_value = False

        response = client.post(
            "/benchmark",
            json={
                "corpus_hash": "nonexistent_hash",
                "question": "What is the answer?",
                "strategies": [{"strategy": "naive"}],
            },
        )

    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


def test_benchmark_returns_400_for_unknown_retrieval_strategy(client):
    """
    POST /benchmark must return HTTP 400 if any strategy in the list is not
    in the retrieval registry. The 400 must be returned before any DB write.
    Strategy validation happens before the rate limit check, so only the
    corpus mock is required.
    """
    with patch("backend.routers.benchmark.corpus_exists",
               new_callable=AsyncMock) as mock_exists:
        mock_exists.return_value = True  # corpus exists, strategy is the problem

        response = client.post(
            "/benchmark",
            json={
                "corpus_hash": "abc123",
                "question": "What is the answer?",
                "strategies": [{"strategy": "totally_unknown_strategy"}],
            },
        )

    assert response.status_code == 400
    assert "totally_unknown_strategy" in response.json()["detail"]


def test_benchmark_returns_202_and_run_ids_on_success(client):
    """
    POST /benchmark must return HTTP 202 with a run_ids list when all inputs
    are valid. Each strategy in the list gets its own run_id. The background
    task is registered but not awaited (run_evaluation is mocked to a no-op).

    get_run_count and increment_run_count are patched at the benchmark module
    level so the test runs without a real database connection.
    """
    run_uuid = uuid.UUID("a7f3c2d1-1234-5678-9abc-def012345678")
    mock_conn = _MockConn(fetchrow_result={"id": run_uuid})
    mock_pool = _MockPool(mock_conn)

    with patch("backend.routers.benchmark.corpus_exists",
               new_callable=AsyncMock) as mock_exists, \
         patch("backend.routers.benchmark.get_pool",
               new_callable=AsyncMock) as mock_gp, \
         patch("backend.routers.benchmark.run_evaluation"), \
         patch("backend.routers.benchmark.get_run_count",
               new_callable=AsyncMock) as mock_count, \
         patch("backend.routers.benchmark.increment_run_count",
               new_callable=AsyncMock):

        mock_exists.return_value = True
        mock_gp.return_value = mock_pool
        mock_count.return_value = 0  # well under the daily limit

        response = client.post(
            "/benchmark",
            json={
                "corpus_hash": "abc123",
                "question": "What is the answer?",
                "strategies": [
                    {"strategy": "naive", "retrieval_params": {"top_k": 3}},
                ],
            },
        )

    assert response.status_code == 202
    body = response.json()
    assert "run_ids" in body
    assert isinstance(body["run_ids"], list)
    assert len(body["run_ids"]) == 1
    assert body["run_ids"][0] == str(run_uuid)


# ---------------------------------------------------------------------------
# GET /results/{run_id} tests
# ---------------------------------------------------------------------------

def test_results_returns_404_for_unknown_run_id(client):
    """
    GET /results/{run_id} must return HTTP 404 when get_run() returns None,
    meaning no run with that ID exists in the database.
    """
    with patch("backend.routers.results.get_run",
               new_callable=AsyncMock) as mock_get:
        mock_get.return_value = None
        response = client.get("/results/nonexistent-run-id")

    assert response.status_code == 404
    assert "nonexistent-run-id" in response.json()["detail"]


def test_results_returns_run_dict_when_found(client):
    """
    GET /results/{run_id} must return the full run dict with all fields when
    the run exists. The status field drives the frontend polling decision.
    """
    mock_run = {
        "id": str(uuid.uuid4()),
        "status": "completed",
        "faithfulness": 0.91,
        "context_utilization": 0.87,
        "answer_relevancy": 0.88,
        "latency_ms": 312.5,
        "question": "What is RAG?",
        "retrieval_strategy": "naive",
        "error_message": None,
    }

    with patch("backend.routers.results.get_run",
               new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_run
        response = client.get(f"/results/{mock_run['id']}")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["faithfulness"] == 0.91


# ---------------------------------------------------------------------------
# GET /strategies tests
# ---------------------------------------------------------------------------

def test_strategies_returns_all_three_top_level_keys(client):
    """
    GET /strategies must return a dict with 'retrievers', 'chunkers', and
    'compression' keys so the frontend can build all three configuration panels.
    """
    response = client.get("/strategies")
    assert response.status_code == 200
    body = response.json()
    assert "retrievers" in body
    assert "chunkers" in body
    assert "compression" in body


def test_strategies_retrievers_have_required_fields(client):
    """
    Every retriever entry must have name, display_name, description, and
    param_schema so the frontend can render the strategy selector and its
    configuration form.
    """
    body = client.get("/strategies").json()
    required = {"name", "display_name", "description", "param_schema"}
    for retriever in body["retrievers"]:
        missing = required - retriever.keys()
        assert not missing, f"Retriever {retriever.get('name')} missing: {missing}"


def test_strategies_chunkers_have_required_fields(client):
    """Every chunker entry must have name, display_name, and param_schema."""
    body = client.get("/strategies").json()
    required = {"name", "display_name", "param_schema"}
    for chunker in body["chunkers"]:
        missing = required - chunker.keys()
        assert not missing, f"Chunker {chunker.get('name')} missing: {missing}"


def test_strategies_param_schema_entries_have_required_keys(client):
    """
    Every entry in every param_schema must contain the six keys the frontend
    uses to render form fields: name, type, default, min, max, description.
    """
    body = client.get("/strategies").json()
    required = {"name", "type", "default", "min", "max", "description"}

    for retriever in body["retrievers"]:
        for entry in retriever["param_schema"]:
            missing = required - entry.keys()
            assert not missing, (
                f"{retriever['name']} param {entry.get('name')} missing: {missing}"
            )

    for chunker in body["chunkers"]:
        for entry in chunker["param_schema"]:
            missing = required - entry.keys()
            assert not missing, (
                f"{chunker['name']} param {entry.get('name')} missing: {missing}"
            )

    for entry in body["compression"]["param_schema"]:
        missing = required - entry.keys()
        assert not missing, f"compression param {entry.get('name')} missing: {missing}"


def test_strategies_includes_all_four_retrievers(client):
    """The four retrieval strategies registered in the registry must all appear."""
    body = client.get("/strategies").json()
    names = {r["name"] for r in body["retrievers"]}
    assert {"naive", "hyde", "multiquery", "hybrid"} <= names


def test_strategies_includes_all_three_chunkers(client):
    """The three chunkers registered in the registry must all appear."""
    body = client.get("/strategies").json()
    names = {c["name"] for c in body["chunkers"]}
    assert {"fixed_size", "semantic", "hierarchical"} <= names


# ---------------------------------------------------------------------------
# GET /health tests
# ---------------------------------------------------------------------------

def test_health_returns_ok(client):
    """GET /health must return status 'ok' and a non-empty timestamp string."""
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["timestamp"]  # non-empty string
