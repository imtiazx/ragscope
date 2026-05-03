"""
scripts/smoke_test.py -- end-to-end smoke test for RAGScope.

Runs the full benchmark pipeline once against a live local server and a real
local database. No mocks. No pytest. Every step prints a clear pass or fail
line and the final summary exits with code 0 (all pass) or 1 (any fail).

How to run:
    python scripts/smoke_test.py

Prerequisites:
    - uvicorn backend.main:app --reload --port 8000  (server must be running)
    - Docker postgres+pgvector container must be up (docker-compose up -d)
    - OPENAI_API_KEY must be set in .env and the server must have loaded it
    - requests must be installed (pip install requests)
"""

import sys
import time
import io

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL = "http://localhost:8000"

# Send the raw dev token so the backend hashes it and compares against
# sha256(settings.dev_token). This bypasses the 3-run-per-day rate limit.
# The token value comes from DEV_TOKEN in .env.
DEV_TOKEN = "imtiazx"

HEADERS = {"X-Dev-Token": DEV_TOKEN}

# How long to wait between result polls (seconds).
POLL_INTERVAL = 3

# Maximum time to wait for the background evaluation to complete (seconds).
POLL_TIMEOUT = 120

# Expected retriever and chunker names from GET /strategies.
EXPECTED_RETRIEVERS = {"naive", "hyde", "multiquery", "hybrid"}
EXPECTED_CHUNKERS = {"fixed_size", "semantic", "hierarchical"}

# Corpus text: at least 200 words explaining RAG pipelines so the benchmark
# question "What is the purpose of chunking in a RAG pipeline?" makes sense
# and RAGAS has real context to score against.
CORPUS_TEXT = """\
Retrieval-Augmented Generation (RAG) is a technique that enhances large language
models by letting them retrieve relevant information from an external knowledge
base before generating an answer. Instead of relying solely on the knowledge
baked into model weights during training, a RAG pipeline fetches up-to-date or
domain-specific documents at inference time and includes them in the prompt
context window. This makes the model more accurate, more factual, and easier
to update without retraining.

A RAG pipeline has three main stages. The first is ingestion: documents are
loaded, processed, and stored in a vector database along with their embeddings.
The second is retrieval: when a user asks a question, the system embeds the
question and searches the vector database for the most semantically similar
document chunks. The third is generation: the retrieved chunks are placed
into the prompt and the language model generates an answer grounded in them.

Chunking is a critical preprocessing step that happens during ingestion. It
splits long documents into smaller, more manageable pieces called chunks.
Chunking matters for several reasons. First, embedding models have a fixed token
limit, so documents longer than that limit must be split before they can be
embedded. Second, smaller chunks allow the retrieval system to return only the
most relevant portions of a document rather than returning an entire 50-page
report when only one paragraph is relevant. Third, chunk granularity directly
affects retrieval precision: chunks that are too large include irrelevant
sentences that dilute the relevance signal; chunks that are too small may be
missing context and become hard to interpret in isolation.

Common chunking strategies include fixed-size chunking, which splits text every
N tokens with an optional overlap window to preserve continuity at boundaries;
semantic chunking, which uses embedding similarity between adjacent sentences
to find natural topic boundaries and split there; and hierarchical chunking,
which stores both a small child chunk and a larger parent chunk so that
retrieval can be precise while the context sent to the LLM is broader.

The overlap parameter in fixed-size chunking is especially important. When a
chunk boundary falls in the middle of a sentence or a logical unit, a small
overlap (typically 10 to 15 percent of the chunk size) ensures the information
near the boundary appears in both adjacent chunks, reducing the chance that a
key fact is split across two chunks and retrieved by neither.

In summary, chunking shapes every downstream metric: faithfulness depends on
whether the retrieved chunk contains the correct answer, context precision
depends on whether the chunk is focused rather than diluted, and latency
depends on how many chunks need to be embedded and compared. Getting the
chunking strategy and parameters right is therefore one of the highest-leverage
decisions in building a RAG system.
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def ok(step: str, detail: str = "") -> None:
    """Print a green-style PASS line for a step."""
    suffix = f" -- {detail}" if detail else ""
    print(f"  [PASS] {step}{suffix}")


def fail(step: str, detail: str = "") -> None:
    """Print a red-style FAIL line for a step."""
    suffix = f" -- {detail}" if detail else ""
    print(f"  [FAIL] {step}{suffix}")


def divider(title: str) -> None:
    """Print a section header."""
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

def step1_health() -> bool:
    """
    GET /health and confirm the response contains status == 'ok'.

    Returns
    -------
    bool
        True if health check passes, False otherwise.
    """
    divider("Step 1 -- Health check")
    try:
        resp = requests.get(f"{BASE_URL}/health", timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") == "ok":
            ok("GET /health", f"status=ok, timestamp={data.get('timestamp')}")
            return True
        fail("GET /health", f"unexpected body: {data}")
        return False
    except Exception as exc:
        fail("GET /health", str(exc))
        return False


def step2_strategies() -> bool:
    """
    GET /strategies and confirm all expected retrievers and chunkers are present.

    Returns
    -------
    bool
        True if all expected names are found, False otherwise.
    """
    divider("Step 2 -- Strategies check")
    try:
        resp = requests.get(f"{BASE_URL}/strategies", timeout=10)
        resp.raise_for_status()
        data = resp.json()

        retrieved_names = {r["name"] for r in data.get("retrievers", [])}
        chunker_names = {c["name"] for c in data.get("chunkers", [])}

        missing_retrievers = EXPECTED_RETRIEVERS - retrieved_names
        missing_chunkers = EXPECTED_CHUNKERS - chunker_names

        all_ok = True

        if missing_retrievers:
            fail("retrievers", f"missing: {missing_retrievers}")
            all_ok = False
        else:
            ok("retrievers", f"found all 4: {sorted(retrieved_names)}")

        if missing_chunkers:
            fail("chunkers", f"missing: {missing_chunkers}")
            all_ok = False
        else:
            ok("chunkers", f"found all 3: {sorted(chunker_names)}")

        return all_ok
    except Exception as exc:
        fail("GET /strategies", str(exc))
        return False


def step3_ingest() -> tuple[bool, str]:
    """
    POST a small in-memory TXT corpus to /ingest using fixed_size chunker.

    Returns
    -------
    tuple[bool, str]
        (success, corpus_hash). corpus_hash is empty string on failure.
    """
    divider("Step 3 -- Ingest")
    try:
        # Build an in-memory file-like object so we do not need a file on disk.
        file_bytes = CORPUS_TEXT.encode("utf-8")
        files = {"files": ("rag_corpus.txt", io.BytesIO(file_bytes), "text/plain")}
        data = {"chunker_strategy": "fixed_size", "chunker_params": "{}"}

        resp = requests.post(
            f"{BASE_URL}/ingest",
            files=files,
            data=data,
            headers=HEADERS,
            timeout=60,
        )

        if resp.status_code not in (200, 201):
            fail("POST /ingest", f"HTTP {resp.status_code}: {resp.text[:200]}")
            return False, ""

        body = resp.json()
        corpus_hash = body.get("corpus_hash", "")
        chunk_count = body.get("chunk_count", 0)

        if not corpus_hash:
            fail("POST /ingest", "response missing corpus_hash")
            return False, ""

        if chunk_count <= 0:
            fail("POST /ingest", f"chunk_count={chunk_count} must be > 0")
            return False, ""

        status_word = "new" if resp.status_code == 201 else "cached"
        ok(
            "POST /ingest",
            f"corpus_hash={corpus_hash[:16]}... chunk_count={chunk_count} ({status_word})",
        )
        return True, corpus_hash

    except Exception as exc:
        fail("POST /ingest", str(exc))
        return False, ""


def step4_benchmark(corpus_hash: str) -> tuple[bool, str]:
    """
    POST /benchmark with naive retrieval and the given corpus_hash.

    Returns
    -------
    tuple[bool, str]
        (success, run_id). run_id is empty string on failure.
    """
    divider("Step 4 -- Benchmark")
    try:
        payload = {
            "corpus_hash": corpus_hash,
            "question": "What is the purpose of chunking in a RAG pipeline?",
            "retrieval_strategy": "naive",
            "retrieval_params": {},
            "chunker_strategy": "fixed_size",
            "chunker_params": {},
            "compression_enabled": False,
            "compression_params": {},
        }

        resp = requests.post(
            f"{BASE_URL}/benchmark",
            json=payload,
            headers=HEADERS,
            timeout=30,
        )

        if resp.status_code != 202:
            fail("POST /benchmark", f"HTTP {resp.status_code}: {resp.text[:200]}")
            return False, ""

        body = resp.json()
        run_id = body.get("run_id", "")

        if not run_id:
            fail("POST /benchmark", "response missing run_id")
            return False, ""

        ok("POST /benchmark", f"HTTP 202 -- run_id={run_id}")
        return True, run_id

    except Exception as exc:
        fail("POST /benchmark", str(exc))
        return False, ""


def step5_poll(run_id: str) -> tuple[bool, dict]:
    """
    Poll GET /results/{run_id} until status is completed or failed, or timeout.

    Returns
    -------
    tuple[bool, dict]
        (success, result_body). result_body is empty dict on failure.
        success is True only when status == 'completed'.
    """
    divider("Step 5 -- Poll for results")
    deadline = time.monotonic() + POLL_TIMEOUT
    poll_num = 0

    while time.monotonic() < deadline:
        poll_num += 1
        try:
            resp = requests.get(
                f"{BASE_URL}/results/{run_id}",
                headers=HEADERS,
                timeout=10,
            )
            resp.raise_for_status()
            body = resp.json()
            status = body.get("status", "unknown")
            elapsed = round(time.monotonic() - (deadline - POLL_TIMEOUT), 1)
            print(f"  poll #{poll_num} at +{elapsed}s -- status={status}")

            if status == "completed":
                ok("poll completed", f"after {elapsed}s and {poll_num} polls")
                return True, body

            if status == "failed":
                error_msg = body.get("error_message") or "(no error message)"
                fail("evaluation failed", error_msg)
                return False, body

        except Exception as exc:
            print(f"  poll #{poll_num} -- request error: {exc}")

        time.sleep(POLL_INTERVAL)

    fail("poll timeout", f"status never reached completed within {POLL_TIMEOUT}s")
    return False, {}


def step6_validate(result: dict) -> bool:
    """
    Validate that all metric fields in the completed result are within range.

    Parameters
    ----------
    result : dict
        The full result body from GET /results/{run_id}.

    Returns
    -------
    bool
        True if all metric fields pass validation, False otherwise.
    """
    divider("Step 6 -- Validate results")

    all_ok = True

    def check_float_01(field: str) -> bool:
        """Return True if result[field] is a float nominally in [0.0, 1.0].

        Rounds to 6 decimal places before the range check because RAGAS
        occasionally returns values like 1.0000000000000004 due to IEEE 754
        floating-point rounding in its internal weighted averaging. Such values
        are semantically 1.0 and should not be treated as failures.
        """
        val = result.get(field)
        if val is None:
            fail(field, "is None")
            return False
        if not isinstance(val, (int, float)):
            fail(field, f"not a float: {type(val).__name__}={val!r}")
            return False
        rounded = round(float(val), 6)
        if not (0.0 <= rounded <= 1.0):
            fail(field, f"out of range [0,1]: {val}")
            return False
        ok(field, f"{rounded:.4f}")
        return True

    all_ok &= check_float_01("faithfulness")
    all_ok &= check_float_01("context_utilization")
    all_ok &= check_float_01("answer_relevancy")

    # latency_ms must be a positive float.
    latency = result.get("latency_ms")
    if latency is None:
        fail("latency_ms", "is None")
        all_ok = False
    elif not isinstance(latency, (int, float)) or float(latency) <= 0:
        fail("latency_ms", f"must be a positive float: {latency!r}")
        all_ok = False
    else:
        ok("latency_ms", f"{latency:.1f} ms")

    # generated_answer must be a non-empty string.
    answer = result.get("generated_answer")
    if not isinstance(answer, str) or not answer.strip():
        fail("generated_answer", f"empty or missing: {answer!r}")
        all_ok = False
    else:
        preview = answer[:80].replace("\n", " ")
        ok("generated_answer", f'"{preview}..."')

    return all_ok


def step7_summary(results: dict[str, bool]) -> None:
    """
    Print a final summary table and exit with the appropriate code.

    Parameters
    ----------
    results : dict[str, bool]
        Mapping of step label to pass/fail boolean.
    """
    divider("Step 7 -- Summary")
    print(f"  {'Step':<40} {'Result'}")
    print(f"  {'-' * 40} {'------'}")

    all_passed = True
    for label, passed in results.items():
        status = "PASS" if passed else "FAIL"
        print(f"  {label:<40} {status}")
        if not passed:
            all_passed = False

    print()
    if all_passed:
        print("  All steps passed. RAGScope full pipeline is healthy.")
        sys.exit(0)
    else:
        print("  One or more steps failed. See output above for details.")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    """
    Run the full smoke test sequence and report results.

    Calls each step in order. If a step produces a value needed by a later
    step (corpus_hash, run_id, result body) it is threaded through explicitly.
    Each step is independent in terms of pass/fail tracking -- a failure in
    step 3 does not prevent steps 4-6 from being attempted if we have the
    data to continue, but steps that depend on a missing value from a prior
    step are marked as skipped (False) automatically.
    """
    print("\nRAGScope End-to-End Smoke Test")
    print(f"Target: {BASE_URL}")
    print(f"Started: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")

    step_results: dict[str, bool] = {}

    # Step 1
    s1 = step1_health()
    step_results["Step 1 -- Health check"] = s1

    # Step 2
    s2 = step2_strategies()
    step_results["Step 2 -- Strategies check"] = s2

    # Step 3
    s3, corpus_hash = step3_ingest()
    step_results["Step 3 -- Ingest"] = s3

    # Step 4: only attempt if we have a corpus_hash.
    if corpus_hash:
        s4, run_id = step4_benchmark(corpus_hash)
    else:
        divider("Step 4 -- Benchmark")
        fail("skipped", "no corpus_hash from step 3")
        s4, run_id = False, ""
    step_results["Step 4 -- Benchmark (HTTP 202)"] = s4

    # Step 5: only attempt if we have a run_id.
    if run_id:
        s5, result_body = step5_poll(run_id)
    else:
        divider("Step 5 -- Poll for results")
        fail("skipped", "no run_id from step 4")
        s5, result_body = False, {}
    step_results["Step 5 -- Poll until completed"] = s5

    # Step 6: only attempt if we have a completed result.
    if result_body and result_body.get("status") == "completed":
        s6 = step6_validate(result_body)
    else:
        divider("Step 6 -- Validate results")
        fail("skipped", "no completed result from step 5")
        s6 = False
    step_results["Step 6 -- Validate metric scores"] = s6

    # Step 7: always print summary.
    step7_summary(step_results)


if __name__ == "__main__":
    main()
