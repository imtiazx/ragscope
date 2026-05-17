"""
RAGAS evaluation runner for RAGScope.

Implements the background task that executes a full benchmark run: retrieval,
optional contextual compression, answer generation, and RAGAS metric
computation. Results are persisted to the benchmark_runs table so the frontend
can poll for them by run_id.

Public entry point: run_evaluation() is a regular (non-async) function.
FastAPI's BackgroundTasks dispatcher runs non-async callables in a thread pool
via anyio. That thread has no asyncio event loop. The sync wrapper creates one
with asyncio.DefaultEventLoopPolicy().new_event_loop(), sets it as the current
loop for the thread, then wraps _run_evaluation_async in a Task via
loop.create_task() before passing it to loop.run_until_complete(). The Task
wrapper is required because asyncpg uses asyncio.timeout() internally when
releasing connections. In Python 3.11+, asyncio.timeout() calls
asyncio.current_task() and raises RuntimeError("Timeout should be used inside
a task") if it returns None. loop.run_until_complete(coro) drives a bare
coroutine without a Task, so current_task() is None. loop.create_task(coro)
wraps it in a Task, making current_task() non-None for the entire evaluation.
The loop is always closed in a finally block.

Never use anyio.run() inside a FastAPI background task thread - it conflicts
with FastAPI's anyio task scope. Never call nest_asyncio.apply() against a
uvloop instance.

The async implementation (_run_evaluation_async) creates its own database pool
via make_task_pool() rather than using the module-level singleton from get_pool().
asyncpg pools are bound to the event loop they were created on; the singleton is
owned by the FastAPI main event loop and cannot be used from the background
thread's separate event loop.

RAGAS and its datasets dependency are imported lazily inside _run_ragas() so
that this module is importable in test environments where those packages are not
installed. Tests mock _run_ragas() directly and never trigger the lazy imports.
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Optional

from backend.core.config import settings
from backend.core.database import get_pool, make_sync_connection
from backend.llm.openai_provider import OpenAIProvider
from backend.retrieval.base import RetrievalResult
from backend.retrieval.registry import registry as retrieval_registry
from backend.retrieval.contextual_compression import ContextualCompressor

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _generate_answer(
    question: str,
    contexts: list[str],
    provider: object,
) -> str:
    """
    Generate an answer to the question using the retrieved contexts.

    Constructs a RAG prompt with all retrieved (and optionally compressed)
    chunk contents, then calls the LLM to produce an answer. This answer is
    what RAGAS evaluates for faithfulness and answer relevancy.

    Declared as a regular (non-async) function because it runs inside
    _run_evaluation_async which itself runs on a plain asyncio event loop
    with no anyio task scope. provider.complete_sync() uses httpx.Client
    (blocking) rather than httpx.AsyncClient so no anyio context is needed.

    Parameters
    ----------
    question : str
        The user's original question.
    contexts : list[str]
        Text content of retrieved chunks, in retrieval rank order.
    provider : object
        An object with a complete_sync(prompt: str) -> str method.

    Returns
    -------
    str
        The LLM-generated answer grounded in the provided contexts.
    """
    joined = "\n\n---\n\n".join(contexts)
    prompt = (
        "Answer the following question using only the information provided in "
        "the context below. Be concise and factual. Do not use any knowledge "
        "outside the provided context.\n\n"
        f"Context:\n{joined}\n\n"
        f"Question: {question}\n\n"
        "Answer:"
    )
    return provider.complete_sync(prompt)


def _run_ragas(
    question: str,
    answer: str,
    contexts: list[str],
) -> dict:
    """
    Run RAGAS evaluation one metric at a time and return all three scores.

    Each metric is evaluated in its own ragas_evaluate() call wrapped in
    try/except BaseException. A failure in one metric (e.g. an internal
    asyncio.timeout() raise when current_task() returns None inside a RAGAS
    worker thread) records NaN for that metric and continues to the next,
    rather than aborting the whole evaluation. NaN values are stored in
    Postgres as 'NaN'::float8 and JSON-serialised as null when returned by
    the results endpoint.

    Detailed [DEBUG] print probes surround each per-metric call so Render
    stderr shows exactly which metric raised, and what asyncio.current_task()
    returned at that moment - the failure mode the previous unified call
    masked because RAGAS itself does not re-raise (raise_exceptions=False).

    Imports RAGAS and its datasets dependency lazily so this module is
    importable without those packages installed (tests mock this function).
    Declared as a regular (non-async) function because it runs inside
    _run_evaluation_async on a plain asyncio event loop.

    The OpenAI API key is written to os.environ here because RAGAS reads it
    via its langchain dependency. This is the only place in the codebase that
    writes to os.environ -- it is necessary to integrate with a third-party
    library that does not accept keys any other way.

    Parameters
    ----------
    question : str
        The original user question.
    answer : str
        The generated answer to evaluate.
    contexts : list[str]
        The retrieved chunk texts used to generate the answer.

    Returns
    -------
    dict
        Keys: faithfulness, context_utilization, answer_relevancy. Each value
        is a float; metrics whose individual ragas_evaluate() call raised
        BaseException are returned as float('nan').
    """
    import os
    # RAGAS reads the key from the environment via its langchain integration.
    os.environ.setdefault("OPENAI_API_KEY", settings.openai_api_key)

    # Lazy imports so the module does not fail to load without these packages.
    from datasets import Dataset  # noqa: PLC0415
    from ragas import evaluate as ragas_evaluate  # noqa: PLC0415
    from ragas.metrics import (  # noqa: PLC0415
        faithfulness as ragas_faithfulness,
        context_utilization as ragas_context_utilization,
        answer_relevancy as ragas_answer_relevancy,
    )

    # context_utilization is the reference-free variant of context_precision:
    # it measures how much of the retrieved context the LLM actually used
    # when generating the answer, without requiring a ground-truth reference
    # answer. context_precision requires ground_truth which this pipeline
    # does not collect.
    dataset = Dataset.from_dict({
        "question": [question],
        "answer": [answer],
        "contexts": [contexts],
    })

    # Confirm we are inside an asyncio Task at entry. The outer wrapper
    # (run_evaluation -> loop.create_task -> loop.run_until_complete) should
    # guarantee this; if current_task() is None here, the task wrapper is
    # not propagating and the asyncio.timeout() calls inside RAGAS / asyncpg
    # are doomed.
    try:
        entry_task = asyncio.current_task()
    except RuntimeError:
        entry_task = None
    print(
        f"[DEBUG] _run_ragas: entry asyncio.current_task() = {entry_task!r}",
        flush=True,
    )

    # Per-metric ordered list. Evaluating one metric per ragas_evaluate() call
    # isolates failures: if context_utilization crashes inside RAGAS, faithfulness
    # and answer_relevancy still get computed.
    metric_defs = [
        ("faithfulness", ragas_faithfulness),
        ("context_utilization", ragas_context_utilization),
        ("answer_relevancy", ragas_answer_relevancy),
    ]

    scores: dict[str, float] = {}

    for key, metric in metric_defs:
        # Re-check current_task() before each metric so logs show whether the
        # task context survives across iterations or gets torn down by RAGAS
        # internals partway through the loop.
        try:
            pre_task = asyncio.current_task()
        except RuntimeError:
            pre_task = None
        print(
            f"[DEBUG] _run_ragas: about to evaluate {key!r}, "
            f"current_task() = {pre_task!r}",
            flush=True,
        )

        try:
            result = ragas_evaluate(dataset, metrics=[metric])
            value = float(result[key])
            scores[key] = value
            print(
                f"[DEBUG] _run_ragas: {key} = {value}",
                flush=True,
            )
        except BaseException as exc:
            # Catch BaseException so SystemExit / KeyboardInterrupt / GeneratorExit
            # also get logged-and-NaN rather than aborting the whole pipeline.
            # The "Timeout should be used inside a task" RuntimeError raised by
            # asyncio.timeout() in RAGAS worker coroutines is captured here.
            print(
                f"[DEBUG] _run_ragas: {key} RAISED {type(exc).__name__}: {exc}",
                flush=True,
            )
            logger.exception(
                "_run_ragas: metric %s raised %s", key, type(exc).__name__
            )
            scores[key] = float("nan")

    print(f"[DEBUG] _run_ragas: returning scores = {scores}", flush=True)
    return scores


def _row_to_dict(row) -> dict:
    """
    Convert an asyncpg Record to a plain Python dict with JSON-safe types.

    asyncpg returns UUID columns as uuid.UUID objects and TIMESTAMPTZ columns
    as datetime objects. Neither is directly JSON-serialisable. This function
    converts both to strings so the result can be returned from a FastAPI
    endpoint without a custom encoder.

    Parameters
    ----------
    row : asyncpg.Record
        Row returned by fetchrow(). Behaves like a dict but needs explicit
        conversion for type-safe access and JSON serialisation.

    Returns
    -------
    dict
        All column values, with UUID and datetime fields converted to strings.
    """
    result = dict(row)
    if result.get("id") is not None:
        result["id"] = str(result["id"])
    if result.get("created_at") is not None:
        result["created_at"] = result["created_at"].isoformat()
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_evaluation(
    run_id: str,
    retrieval_strategy: str,
    chunker_strategy: str,
    retrieval_params: dict,
    chunker_params: dict,
    compression_enabled: bool,
    compression_params: dict,
    question: str,
    corpus_hash: str,
) -> None:
    """
    Sync entry point registered with FastAPI BackgroundTasks.

    Declared as a plain (non-async) function so FastAPI dispatches it to a
    worker thread via anyio rather than awaiting it on the main uvloop event
    loop. The worker thread has no event loop, so this function creates one
    with asyncio.DefaultEventLoopPolicy().new_event_loop(), sets it as the
    current loop for the thread, then wraps _run_evaluation_async in a Task
    via loop.create_task() before passing it to loop.run_until_complete().

    The Task wrapper is required by Python 3.11+ asyncpg behaviour: asyncpg
    calls asyncio.timeout() when releasing connections back to the pool.
    asyncio.timeout() calls asyncio.current_task() and raises
    RuntimeError("Timeout should be used inside a task") if it returns None.
    loop.run_until_complete(bare_coro) drives the coroutine without a Task,
    so current_task() is None. loop.create_task(coro) schedules the coroutine
    as a proper Task before the loop starts, making current_task() non-None
    for the entire evaluation including the DB write at step 7.

    The corpus is NOT accepted as an argument. It is fetched from the database
    inside _run_evaluation_async using the task's own pool. Passing the full
    corpus (100+ chunks x 1536 floats each) as a thread-boundary argument
    caused silent hangs on Render's free tier before run_evaluation even began
    executing, which is why no [DEBUG] print ever appeared in logs.

    This pattern avoids two production failures that prior approaches caused:
      - asyncio.run(): "Can't patch loop of type uvloop.Loop" from nest_asyncio
      - anyio.run() inside a background thread: "Timeout should be used inside
        a task" because FastAPI's anyio token on the thread conflicted with a
        nested anyio.run() call

    Parameters
    ----------
    run_id : str
        UUID string of the pre-created benchmark_runs row.
    retrieval_strategy : str
        Registry key of the retrieval strategy (e.g. 'naive', 'hyde').
    chunker_strategy : str
        Registry key of the chunking strategy used to produce the corpus.
    retrieval_params : dict
        Parameters for the retriever constructor and retrieve() call.
    chunker_params : dict
        Parameters used when the corpus was chunked. Stored for provenance.
    compression_enabled : bool
        Whether to apply ContextualCompressor after retrieval.
    compression_params : dict
        Parameters for ContextualCompressor. Used only if compression_enabled.
    question : str
        The benchmark question to answer and evaluate.
    corpus_hash : str
        SHA-256 hex digest identifying the corpus in corpus_chunks. The task
        uses this to load the corpus itself from the database.
    """
    print(f"[DEBUG] run_evaluation entered run_id={run_id}", flush=True)
    logger.info(
        "run_evaluation: starting run_id=%s strategy=%s",
        run_id,
        retrieval_strategy,
    )
    policy = asyncio.DefaultEventLoopPolicy()
    loop = policy.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        # Wrap the coroutine in a Task before passing to run_until_complete.
        # asyncpg uses asyncio.timeout() when releasing connections; that
        # function requires asyncio.current_task() to be non-None (Python 3.11+).
        # A bare coroutine passed directly to run_until_complete has no Task, so
        # current_task() returns None and asyncpg raises RuntimeError. Creating
        # a Task first via loop.create_task() ensures current_task() is set.
        task = loop.create_task(
            _run_evaluation_async(
                run_id=run_id,
                retrieval_strategy=retrieval_strategy,
                chunker_strategy=chunker_strategy,
                retrieval_params=retrieval_params,
                chunker_params=chunker_params,
                compression_enabled=compression_enabled,
                compression_params=compression_params,
                question=question,
                corpus_hash=corpus_hash,
            )
        )
        loop.run_until_complete(task)
    except BaseException as exc:
        # _run_evaluation_async writes status='failed' and returns normally.
        # This outer handler catches anything that still escapes (e.g. an
        # error inside the async error handler itself). FastAPI swallows
        # exceptions from background tasks silently, so log here.
        print(f"[DEBUG] run_evaluation CRASHED: {exc}", flush=True)
        logger.exception(
            "run_evaluation: unhandled crash for run_id=%s: %s", run_id, exc
        )
    finally:
        loop.close()


async def _run_evaluation_async(
    run_id: str,
    retrieval_strategy: str,
    chunker_strategy: str,
    retrieval_params: dict,
    chunker_params: dict,
    compression_enabled: bool,
    compression_params: dict,
    question: str,
    corpus_hash: str,
) -> None:
    """
    Async implementation of a full benchmark run.

    Called exclusively via run_evaluation() which drives it with
    loop.run_until_complete(loop.create_task(...)). Creates its own database
    pool via make_task_pool() rather than reusing the module-level singleton
    from get_pool(). asyncpg pools are bound to the event loop they were
    created on; the singleton belongs to the FastAPI main event loop and cannot
    be used from the separate event loop created in the background thread.

    NEVER raises an exception -- all failures are caught, written to the database
    as status='failed' with an error_message, and the function returns normally.
    If pool creation itself failed (pool is None at exception time), the DB update
    is skipped and the failure is only logged.

    Execution flow:
      1. Set status='running'
      2. Load corpus from database using task pool (not passed as argument)
      3. Initialise retriever and run retrieval
      4. Optionally apply contextual compression
      5. Generate an answer from retrieved contexts via LLM
      6. Run RAGAS evaluation for all three metrics
      7. Write scores, answer, and chunks to the database; set status='completed'

    Parameters match run_evaluation() exactly (corpus is omitted from both
    because it is fetched here from the database rather than passed as an arg).
    """
    # Synchronous psycopg2 connection. We use psycopg2 in the background
    # task path instead of asyncpg because asyncpg's connection code calls
    # asyncio.timeout() unconditionally on Python 3.14 (Render's runtime),
    # raising "Timeout should be used inside a task" when current_task()
    # returns None during concurrent task creation. psycopg2 is fully sync
    # and never touches asyncio, so the failure mode does not exist for
    # this path. The brief blocking of the event loop on each DB call is
    # acceptable because this thread's loop has no other coroutines to
    # starve - the only awaits between DB hops are LLM / RAGAS calls.
    # The FastAPI main loop still uses asyncpg via get_pool() and is
    # unaffected.
    import psycopg2  # noqa: PLC0415 - lazy so module imports without psycopg2 installed (tests mock).
    import psycopg2.extras  # noqa: PLC0415

    conn = None
    t0 = time.perf_counter()
    run_uuid = uuid.UUID(run_id)
    # Tracks whether the final UPDATE that sets status='completed' has been
    # acked by Postgres. The same post-commit-cleanup-noise concern from
    # earlier asyncpg sessions still applies here: if conn.close() in the
    # finally block raises after we have already commit()ed the success
    # row, the outer except should NOT overwrite status to 'failed'.
    completed_committed = False

    try:
        # Open the synchronous connection inside the try block so that a DB
        # connect failure is caught and written as status='failed', rather
        # than propagating out and leaving the row permanently stuck in
        # 'pending'. make_sync_connection() is sync (no `await`).
        conn = make_sync_connection()
        print(f"[DEBUG] conn opened run_id={run_id}", flush=True)

        # Step 1: mark the run as in-progress so the frontend stops showing "pending".
        # run_uuid is wrapped in str() as a defensive cast: psycopg2 should
        # auto-adapt uuid.UUID via the global codec registered in
        # make_sync_connection, but on environments where that registration
        # silently fails the str() cast guarantees Postgres receives the
        # canonical hyphenated UUID text form, which the UUID column accepts.
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE benchmark_runs SET status = 'running' WHERE id = %s",
                (str(run_uuid),),
            )
        conn.commit()
        print(f"[DEBUG] status=running run_id={run_id}", flush=True)

        # Step 2: load the corpus. The corpus is never passed as an argument
        # to this function because serialising 100+ chunks (each carrying a
        # 1536-float embedding) across the thread boundary caused silent
        # hangs on Render before run_evaluation even began executing.
        # database.py's load_corpus() uses get_pool() which is bound to the
        # uvloop event loop and unusable here - query inline instead.
        # RealDictCursor returns rows as dict-like objects so the existing
        # `row["id"]` style of access still works.
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, content, embedding
                FROM corpus_chunks
                WHERE corpus_hash = %s
                ORDER BY chunk_index
                """,
                (corpus_hash,),
            )
            rows = cur.fetchall()
        corpus = [
            {
                "chunk_id": str(row["id"]),
                "content": row["content"],
                # pgvector.psycopg2.register_vector decodes the embedding
                # column as a numpy array; list() converts to plain floats.
                "embedding": list(row["embedding"]),
            }
            for row in rows
        ]
        print(f"[DEBUG] corpus loaded chunks={len(corpus)} run_id={run_id}", flush=True)

        # Step 3: initialise the retriever from the registry using the stored params.
        # retrieval_params contains top_k plus any strategy-specific parameters.
        # Passing **retrieval_params to the constructor works because every retriever
        # accepts top_k and its own strategy params as constructor kwargs.
        retriever_cls = retrieval_registry[retrieval_strategy]
        retriever = retriever_cls(corpus=corpus, **retrieval_params)
        top_k = retrieval_params.get("top_k", 5)
        results: list[RetrievalResult] = await retriever.retrieve(question, top_k)

        # Step 4: optionally compress each chunk to only query-relevant sentences.
        if compression_enabled:
            compressor = ContextualCompressor(
                min_relevance_length=compression_params.get("min_relevance_length", 50),
                llm_provider=OpenAIProvider(),
            )
            results = await compressor.compress(results, question)

        # Step 5: generate the answer that RAGAS will evaluate.
        # _generate_answer and _run_ragas are sync (not async) because they
        # run on a plain asyncio event loop with no anyio task scope.
        provider = OpenAIProvider()
        contexts = [r.content for r in results]
        generated_answer = _generate_answer(question, contexts, provider)

        # Step 6: run RAGAS metric computation synchronously.
        scores = _run_ragas(question, generated_answer, contexts)
        print(f"[DEBUG] RAGAS complete scores={scores} run_id={run_id}", flush=True)

        latency_ms = (time.perf_counter() - t0) * 1000.0

        # Serialise results for JSONB storage. The JSONB codec on the
        # connection will call json.dumps automatically, so pass Python
        # dicts/lists directly.
        retrieved_chunks_data = [
            {
                "chunk_id": r.chunk_id,
                "content": r.content,
                "score": r.score,
                "metadata": r.metadata,
            }
            for r in results
        ]

        # Step 7: write everything and mark as completed in a single statement
        # so the frontend never sees a partial state where scores are present but
        # status is still 'running'.
        print(f"[DEBUG] step7 before UPDATE run_id={run_id}", flush=True)
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE benchmark_runs SET
                    status           = 'completed',
                    retrieved_chunks = %s,
                    generated_answer = %s,
                    faithfulness     = %s,
                    context_utilization = %s,
                    answer_relevancy  = %s,
                    latency_ms        = %s
                WHERE id = %s
                """,
                (
                    # psycopg2.extras.Json wraps the Python value with the
                    # JSONB protocol marker; without it psycopg2 would try
                    # to send retrieved_chunks_data as a Python repr string
                    # and Postgres would reject the type cast.
                    psycopg2.extras.Json(retrieved_chunks_data),
                    generated_answer,
                    scores["faithfulness"],
                    scores["context_utilization"],
                    scores["answer_relevancy"],
                    latency_ms,
                    str(run_uuid),
                ),
            )
        conn.commit()
        # Set the flag immediately after commit() returns so any subsequent
        # teardown noise (e.g. conn.close() raising) does not get treated as
        # a real failure by the outer except.
        completed_committed = True
        print(f"[DEBUG] step7 UPDATE committed (completed_committed=True) run_id={run_id}", flush=True)
        print(f"[DEBUG] status=completed run_id={run_id}", flush=True)

    except BaseException as exc:
        # Catch BaseException (not just Exception) so that SystemExit,
        # KeyboardInterrupt, and GeneratorExit are also handled and always
        # result in a 'failed' row rather than a permanently stuck run.
        # IMPORTANT: if completed_committed is True, the status='completed'
        # UPDATE has already been durably persisted; the exception fired in
        # post-commit cleanup. Overwriting status to 'failed' here would
        # corrupt a successful run, so log-and-swallow.
        if completed_committed:
            print(
                f"[DEBUG] post-commit cleanup noise swallowed for run_id={run_id}: "
                f"{type(exc).__name__}: {exc}",
                flush=True,
            )
            logger.warning(
                "_run_evaluation_async: post-commit cleanup exception swallowed "
                "for run_id=%s (run already completed): %s",
                run_id,
                exc,
            )
            return
        print(f"[DEBUG] _run_evaluation_async FAILED run_id={run_id}: {exc}", flush=True)
        logger.exception(
            "_run_evaluation_async: run_id=%s failed: %s", run_id, exc
        )
        if conn is None:
            # Connection open itself failed; no DB handle is available to
            # write the failure status. Log and give up - we cannot do
            # anything else from a background thread without a connection.
            print(
                f"[DEBUG] conn is None for run_id={run_id}, skipping DB failure write",
                flush=True,
            )
            logger.error(
                "_run_evaluation_async: conn is None for run_id=%s,"
                " cannot write failed status",
                run_id,
            )
        else:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE benchmark_runs SET
                            status        = 'failed',
                            error_message = %s
                        WHERE id = %s
                        """,
                        (str(exc), str(run_uuid)),
                    )
                conn.commit()
            except Exception:
                logger.exception(
                    "_run_evaluation_async: could not write failed status to DB"
                    " for run_id=%s",
                    run_id,
                )

    finally:
        if conn is not None:
            print(f"[DEBUG] finally: before conn.close run_id={run_id}", flush=True)
            try:
                # psycopg2 conn.close() is synchronous. It never touches
                # asyncio so it cannot trip the Python 3.14 timeout bug,
                # but we still log-and-swallow any close error so the
                # function returns cleanly with the final row state intact.
                conn.close()
                print(f"[DEBUG] finally: conn.close ok run_id={run_id}", flush=True)
            except BaseException as close_exc:
                print(
                    f"[DEBUG] finally: conn.close RAISED "
                    f"{type(close_exc).__name__}: {close_exc} run_id={run_id}",
                    flush=True,
                )
                logger.exception(
                    "_run_evaluation_async: conn.close failed for run_id=%s",
                    run_id,
                )
        print(f"[DEBUG] _run_evaluation_async: finally block done run_id={run_id}", flush=True)


async def get_run(run_id: str) -> Optional[dict]:
    """
    Fetch a benchmark run row from the database by its UUID.

    Called by the results router on each frontend poll request. Returns None
    if no row with the given ID exists, which the router translates to a 404.

    Parameters
    ----------
    run_id : str
        UUID string identifying the benchmark run.

    Returns
    -------
    dict or None
        All columns from benchmark_runs as a plain dict with UUID and datetime
        values converted to strings. None if the run does not exist.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM benchmark_runs WHERE id = $1",
            uuid.UUID(run_id),
        )
    if row is None:
        return None
    return _row_to_dict(row)
