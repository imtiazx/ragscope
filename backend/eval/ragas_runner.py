"""
RAGAS evaluation runner for RAGScope.

Implements the background task that executes a full benchmark run: retrieval,
optional contextual compression, answer generation, and RAGAS metric
computation. Results are persisted to the benchmark_runs table so the frontend
can poll for them by run_id.

Public entry point: run_evaluation() is a regular (non-async) function.
FastAPI's BackgroundTasks dispatcher runs non-async callables in a thread pool
via anyio. That thread has no asyncio event loop, so any awaitable called
directly from it raises "There is no current event loop in thread". The sync
wrapper calls asyncio.run(), which creates a fresh event loop for the thread
and drives the async implementation to completion inside it.

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
from backend.core.database import get_pool, make_task_pool
from backend.llm.openai_provider import OpenAIProvider
from backend.retrieval.base import RetrievalResult
from backend.retrieval.registry import registry as retrieval_registry
from backend.retrieval.contextual_compression import ContextualCompressor

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

async def _generate_answer(
    question: str,
    contexts: list[str],
    provider: object,
) -> str:
    """
    Generate an answer to the question using the retrieved contexts.

    Constructs a RAG prompt with all retrieved (and optionally compressed)
    chunk contents, then calls the LLM to produce an answer. This answer is
    what RAGAS evaluates for faithfulness and answer relevancy.

    Parameters
    ----------
    question : str
        The user's original question.
    contexts : list[str]
        Text content of retrieved chunks, in retrieval rank order.
    provider : object
        An object with an async complete(prompt: str) -> str method.

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
    return await provider.complete(prompt)


async def _run_ragas(
    question: str,
    answer: str,
    contexts: list[str],
) -> dict:
    """
    Run RAGAS evaluation and return the three metric scores.

    Imports RAGAS and its datasets dependency lazily so this module is
    importable without those packages installed (tests mock this function).
    ragas_evaluate() is called synchronously because this function is only
    ever reached from _run_evaluation_async, which itself runs inside
    asyncio.run() in a dedicated background thread with no other coroutines
    competing on its event loop.

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
        Keys: faithfulness, context_utilization, answer_relevancy (all float).
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

    # Call ragas_evaluate synchronously. asyncio.to_thread() was previously
    # used here to avoid blocking the FastAPI main event loop, but run_evaluation
    # now drives _run_evaluation_async via asyncio.run() in a dedicated background
    # thread -- so this event loop has no other coroutines to starve. Dispatching
    # to a second thread via asyncio.to_thread() creates a new worker thread with
    # no event loop; RAGAS and its langchain/nest_asyncio internals call
    # asyncio.get_event_loop() from that thread, which raises RuntimeError on
    # Python 3.12+. Calling synchronously keeps everything on the same thread
    # where asyncio.run() has already set up the event loop.
    def _sync_eval():
        return ragas_evaluate(
            dataset,
            metrics=[
                ragas_faithfulness,
                ragas_context_utilization,
                ragas_answer_relevancy,
            ],
        )

    result = _sync_eval()

    return {
        "faithfulness": float(result["faithfulness"]),
        "context_utilization": float(result["context_utilization"]),
        "answer_relevancy": float(result["answer_relevancy"]),
    }


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

async def run_evaluation(
    run_id: str,
    retrieval_strategy: str,
    chunker_strategy: str,
    retrieval_params: dict,
    chunker_params: dict,
    compression_enabled: bool,
    compression_params: dict,
    corpus: list[dict],
    question: str,
    corpus_hash: str,
) -> None:
    """
    Async entry point registered with FastAPI BackgroundTasks.

    Declared async so FastAPI awaits it directly on the main event loop
    rather than dispatching it to anyio's thread pool. The sync wrapper
    approach (asyncio.run / anyio.run inside a worker thread) caused two
    separate production failures:
      - asyncio.run(): "Can't patch loop of type uvloop.Loop" from nest_asyncio
      - anyio.run(): "Timeout should be used inside a task" because FastAPI's
        anyio token on the thread conflicted with a nested anyio.run() call

    Awaiting _run_evaluation_async directly avoids both issues entirely.

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
    corpus : list[dict]
        Pre-embedded chunks with chunk_id, content, and embedding keys.
    question : str
        The benchmark question to answer and evaluate.
    corpus_hash : str
        Hash identifying the corpus, stored for provenance.
    """
    print(f"[DEBUG] run_evaluation entered run_id={run_id}", flush=True)
    logger.info(
        "run_evaluation: starting run_id=%s strategy=%s",
        run_id,
        retrieval_strategy,
    )
    try:
        await _run_evaluation_async(
            run_id=run_id,
            retrieval_strategy=retrieval_strategy,
            chunker_strategy=chunker_strategy,
            retrieval_params=retrieval_params,
            chunker_params=chunker_params,
            compression_enabled=compression_enabled,
            compression_params=compression_params,
            corpus=corpus,
            question=question,
            corpus_hash=corpus_hash,
        )
    except BaseException as exc:
        # _run_evaluation_async writes status='failed' and returns normally.
        # This outer handler catches anything that still escapes (e.g. an
        # error inside the async error handler itself). FastAPI swallows
        # exceptions from background tasks silently, so log here.
        print(f"[DEBUG] run_evaluation CRASHED: {exc}", flush=True)
        logger.exception(
            "run_evaluation: unhandled crash for run_id=%s: %s", run_id, exc
        )


async def _run_evaluation_async(
    run_id: str,
    retrieval_strategy: str,
    chunker_strategy: str,
    retrieval_params: dict,
    chunker_params: dict,
    compression_enabled: bool,
    compression_params: dict,
    corpus: list[dict],
    question: str,
    corpus_hash: str,
) -> None:
    """
    Async implementation of a full benchmark run.

    Called exclusively via run_evaluation() which drives it with asyncio.run().
    Creates its own database pool via make_task_pool() rather than reusing the
    module-level singleton from get_pool(). asyncpg pools are bound to the event
    loop they were created on; the singleton belongs to the FastAPI main event
    loop and cannot be used from the separate event loop created by asyncio.run().

    NEVER raises an exception -- all failures are caught, written to the database
    as status='failed' with an error_message, and the function returns normally.

    Execution flow:
      1. Set status='running'
      2. Initialise retriever and run retrieval
      3. Optionally apply contextual compression
      4. Generate an answer from retrieved contexts via LLM
      5. Run RAGAS evaluation for all three metrics
      6. Write scores, answer, and chunks to the database; set status='completed'

    Parameters match run_evaluation() exactly.
    """
    pool = None
    t0 = time.perf_counter()
    run_uuid = uuid.UUID(run_id)

    try:
        # Pool creation is inside the try block so that a DB connection failure
        # is caught and written as status='failed', rather than propagating out
        # through asyncio.run() and leaving the row permanently stuck in 'pending'.
        pool = await make_task_pool()

        # Step 1: mark the run as in-progress so the frontend stops showing "pending".
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE benchmark_runs SET status = 'running' WHERE id = $1",
                run_uuid,
            )

        # Step 2: initialise the retriever from the registry using the stored params.
        # retrieval_params contains top_k plus any strategy-specific parameters.
        # Passing **retrieval_params to the constructor works because every retriever
        # accepts top_k and its own strategy params as constructor kwargs.
        retriever_cls = retrieval_registry[retrieval_strategy]
        retriever = retriever_cls(corpus=corpus, **retrieval_params)
        top_k = retrieval_params.get("top_k", 5)
        results: list[RetrievalResult] = await retriever.retrieve(question, top_k)

        # Step 3: optionally compress each chunk to only query-relevant sentences.
        if compression_enabled:
            compressor = ContextualCompressor(
                min_relevance_length=compression_params.get("min_relevance_length", 50),
                llm_provider=OpenAIProvider(),
            )
            results = await compressor.compress(results, question)

        # Step 4: generate the answer that RAGAS will evaluate.
        provider = OpenAIProvider()
        contexts = [r.content for r in results]
        generated_answer = await _generate_answer(question, contexts, provider)

        # Step 5: run RAGAS metric computation via the thread-pool wrapper.
        scores = await _run_ragas(question, generated_answer, contexts)

        latency_ms = (time.perf_counter() - t0) * 1000.0

        # Serialise results for JSONB storage. The JSONB codec on the pool
        # will call json.dumps automatically, so pass Python dicts/lists directly.
        retrieved_chunks_data = [
            {
                "chunk_id": r.chunk_id,
                "content": r.content,
                "score": r.score,
                "metadata": r.metadata,
            }
            for r in results
        ]

        # Step 6 + 7: write everything and mark as completed in a single statement
        # so the frontend never sees a partial state where scores are present but
        # status is still 'running'.
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE benchmark_runs SET
                    status           = 'completed',
                    retrieved_chunks = $1,
                    generated_answer = $2,
                    faithfulness     = $3,
                    context_utilization = $4,
                    answer_relevancy  = $5,
                    latency_ms        = $6
                WHERE id = $7
                """,
                retrieved_chunks_data,
                generated_answer,
                scores["faithfulness"],
                scores["context_utilization"],
                scores["answer_relevancy"],
                latency_ms,
                run_uuid,
            )

    except BaseException as exc:
        # Catch BaseException (not just Exception) so that SystemExit,
        # KeyboardInterrupt, and GeneratorExit are also handled and always
        # result in a 'failed' row rather than a permanently stuck run.
        logger.exception(
            "_run_evaluation_async: run_id=%s failed: %s", run_id, exc
        )
        try:
            # If pool creation was what failed, try to open a fresh connection
            # just to write the failure status. If this also fails, log it and
            # give up -- there is nothing more we can do from a background thread.
            if pool is None:
                pool = await make_task_pool()
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE benchmark_runs SET
                        status        = 'failed',
                        error_message = $1
                    WHERE id = $2
                    """,
                    str(exc),
                    run_uuid,
                )
        except Exception:
            logger.exception(
                "_run_evaluation_async: could not write failed status to DB"
                " for run_id=%s",
                run_id,
            )

    finally:
        if pool is not None:
            await pool.close()


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
