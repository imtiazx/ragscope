"""
Benchmark router for RAGScope.

Handles POST /benchmark: validates the corpus and all requested retrieval
strategies, enforces the guest-tier daily run limit, creates one
benchmark_runs row per strategy, fires one background evaluation task per
strategy, and returns all run_ids immediately with HTTP 202 so the client
can begin polling GET /results/{run_id} for each one independently.

Selecting N strategies counts as N runs against the guest daily limit. The
limit check (read-only) happens before any rows are created; the counter
increment happens after all rows and tasks are registered. If any strategy
is invalid the request is rejected with HTTP 400 before any rows are written.

Compression is an orthogonal post-retrieval toggle. Enabling or disabling it
does not count as an additional run and does not affect the rate limit check.
"""

import hashlib

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.core.auth import get_dev_access
from backend.core.database import corpus_exists, get_pool, get_run_count, increment_run_count
from backend.core.rate_limiter import DAILY_RUN_LIMIT
from backend.eval.ragas_runner import run_evaluation
from backend.retrieval.registry import registry as retrieval_registry

router = APIRouter()


class StrategyConfig(BaseModel):
    """
    Per-strategy configuration for a single retrieval run within a multi-strategy request.

    Each item in the strategies list carries its own strategy name, retrieval
    parameters, and compression settings. The corpus_hash, question, and chunker
    configuration are shared across all strategies in the same request and live
    at the top level of BenchmarkRequest.
    """

    strategy: str
    retrieval_params: dict = {}
    compression_enabled: bool = False
    compression_params: dict = {}


class BenchmarkRequest(BaseModel):
    """
    JSON body accepted by POST /benchmark.

    strategies is a list of StrategyConfig objects. Each element results in
    one benchmark_runs row and one background evaluation task. Selecting N
    strategies counts as N runs against the guest daily limit.

    corpus_hash, question, chunker_strategy, and chunker_params are shared
    across all strategies in the request.
    """

    corpus_hash: str
    question: str
    chunker_strategy: str = "fixed_size"
    chunker_params: dict = {}
    strategies: list[StrategyConfig]


@router.post("/benchmark")
async def create_benchmark(
    body: BenchmarkRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    dev_access: bool = Depends(get_dev_access),
    x_fingerprint: str = Header(default=""),
) -> JSONResponse:
    """
    Create benchmark runs for one or more retrieval strategies.

    Validates the corpus, validates all strategy names, enforces the guest
    daily run limit based on the total number of strategies requested, creates
    one benchmark_runs row per strategy, fires one background task per strategy,
    then increments the rate limit counter by the total strategy count.

    Returns HTTP 202 with a list of run_ids. The client polls
    GET /results/{run_id} for each run_id independently.

    Parameters
    ----------
    body : BenchmarkRequest
        JSON body with shared corpus/question fields and a list of per-strategy
        configurations.
    request : Request
        FastAPI request, used to extract the client IP for fingerprinting.
    background_tasks : BackgroundTasks
        FastAPI registry for background tasks.
    dev_access : bool
        True if the X-Dev-Token header passes validation. Bypasses rate limits.
    x_fingerprint : str
        Browser fingerprint value from the X-Fingerprint header, combined with
        the client IP to derive the rate-limit key.

    Returns
    -------
    JSONResponse
        HTTP 202 with {"run_ids": [str, ...]} - one entry per strategy.

    Raises
    ------
    HTTPException 404
        Corpus has not been ingested. Call POST /ingest first.
    HTTPException 400
        At least one strategy name is not in the retrieval registry.
    HTTPException 422
        No strategies provided in the list.
    HTTPException 429
        Guest tier daily limit exceeded for the number of strategies requested.
    """
    if not body.strategies:
        raise HTTPException(status_code=422, detail="strategies list must not be empty.")

    # Validate that the corpus was previously ingested before touching anything else.
    if not await corpus_exists(body.corpus_hash):
        raise HTTPException(
            status_code=404,
            detail=(
                f"Corpus {body.corpus_hash!r} not found. "
                "Call POST /ingest first to upload and index the document corpus."
            ),
        )

    # Validate every strategy name before any rows are created so the client
    # gets a clear 400 rather than a partially-created state.
    for item in body.strategies:
        if item.strategy not in retrieval_registry:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unknown retrieval strategy {item.strategy!r}. "
                    f"Available strategies: {sorted(retrieval_registry.keys())}"
                ),
            )

    # Rate limit check for guest users. Dev token holders bypass this entirely.
    # Compression enable/disable is orthogonal and does not affect this count.
    n_strategies = len(body.strategies)
    fingerprint_hash: str | None = None

    if not dev_access:
        client_ip: str = request.client.host if request.client else "unknown"
        raw_identity = f"{client_ip}:{x_fingerprint}"
        fingerprint_hash = hashlib.sha256(raw_identity.encode()).hexdigest()

        current_count = await get_run_count(fingerprint_hash)
        remaining = DAILY_RUN_LIMIT - current_count

        if n_strategies > remaining:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Requested {n_strategies} strategy run(s) but only "
                    f"{remaining} of {DAILY_RUN_LIMIT} daily runs remain. "
                    "Your limit resets at midnight UTC. Paste your own API key "
                    "in Settings to run unlimited benchmarks."
                ),
            )

    # Create one benchmark_runs row and one background task per strategy.
    # The corpus is NOT loaded here. Each background task fetches the corpus
    # from the database using its own pool so that large embedding vectors
    # (100+ chunks x 1536 floats) are never serialised across a thread boundary
    # as a task argument, which caused silent hangs on Render's free tier.
    pool = await get_pool()
    run_ids: list[str] = []

    for item in body.strategies:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO benchmark_runs (
                    retrieval_strategy,  chunker_strategy,
                    retrieval_params,    chunker_params,
                    compression_enabled, compression_params,
                    corpus_hash,         question
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id
                """,
                item.strategy,
                body.chunker_strategy,
                item.retrieval_params,
                body.chunker_params,
                item.compression_enabled,
                item.compression_params,
                body.corpus_hash,
                body.question,
            )

        run_id = str(row["id"])
        run_ids.append(run_id)

        background_tasks.add_task(
            run_evaluation,
            run_id=run_id,
            retrieval_strategy=item.strategy,
            chunker_strategy=body.chunker_strategy,
            retrieval_params=item.retrieval_params,
            chunker_params=body.chunker_params,
            compression_enabled=item.compression_enabled,
            compression_params=item.compression_params,
            question=body.question,
            corpus_hash=body.corpus_hash,
        )
        print(f"[DEBUG] add_task called for run_id={run_id} strategy={item.strategy}", flush=True)

    # Increment the counter by the total number of strategies, not by 1.
    # This happens after all rows and tasks are registered so a partial failure
    # does not consume quota for tasks that were never created.
    if not dev_access and fingerprint_hash is not None:
        await increment_run_count(fingerprint_hash, delta=n_strategies)

    return JSONResponse(status_code=202, content={"run_ids": run_ids})
