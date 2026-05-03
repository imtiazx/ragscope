"""
Benchmark router for RAGScope.

Handles POST /benchmark: validates the corpus and retrieval strategy,
creates a benchmark_runs row with status='pending', loads the corpus from
the database, and fires the evaluation pipeline as a FastAPI BackgroundTask.
Returns the run_id immediately with HTTP 202 so the client can begin polling
GET /results/{run_id} without waiting for the evaluation to complete.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.core.database import corpus_exists, get_pool, load_corpus
from backend.core.rate_limiter import check_rate_limit
from backend.eval.ragas_runner import run_evaluation
from backend.retrieval.registry import registry as retrieval_registry

router = APIRouter()


class BenchmarkRequest(BaseModel):
    """
    JSON body accepted by POST /benchmark.

    All strategy-specific parameters are passed as dicts whose keys must
    match the param_schema of the chosen strategy. The frontend reads those
    schemas from GET /strategies to build the configuration form.
    """

    corpus_hash: str
    question: str
    retrieval_strategy: str
    retrieval_params: dict = {}
    chunker_strategy: str = "fixed_size"
    chunker_params: dict = {}
    compression_enabled: bool = False
    compression_params: dict = {}


@router.post("/benchmark", dependencies=[Depends(check_rate_limit)])
async def create_benchmark(
    body: BenchmarkRequest,
    background_tasks: BackgroundTasks,
) -> JSONResponse:
    """
    Create a new benchmark run and start evaluation in the background.

    Validates the request, persists an initial 'pending' row, loads the
    pre-embedded corpus from the database, then hands control back to the
    caller immediately with HTTP 202. The evaluation (retrieval, optional
    compression, answer generation, RAGAS scoring) continues as a background
    task after the response is sent.

    Parameters
    ----------
    body : BenchmarkRequest
        JSON body containing corpus_hash, question, and strategy configuration.
    background_tasks : BackgroundTasks
        FastAPI's background task registry. The evaluation coroutine is
        registered here rather than awaited so it runs after the response.

    Returns
    -------
    JSONResponse
        HTTP 202 with {"run_id": str} so the client can poll for results.

    Raises
    ------
    HTTPException 404
        If no corpus with the given corpus_hash exists in the database.
        The client must call POST /ingest first.
    HTTPException 400
        If retrieval_strategy is not a registered retrieval strategy.
        The client should consult GET /strategies for valid options.
    """
    # Validate that the corpus was previously ingested.
    # run_evaluation would fail at retrieval time without this check, but
    # catching it here gives the client a clear 404 immediately.
    if not await corpus_exists(body.corpus_hash):
        raise HTTPException(
            status_code=404,
            detail=(
                f"Corpus {body.corpus_hash!r} not found. "
                "Call POST /ingest first to upload and index the document corpus."
            ),
        )

    # Validate the retrieval strategy before writing anything to the database.
    if body.retrieval_strategy not in retrieval_registry:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown retrieval strategy {body.retrieval_strategy!r}. "
                f"Available strategies: {sorted(retrieval_registry.keys())}"
            ),
        )

    # Create the benchmark_runs row with status='pending'.
    # RETURNING id captures the Postgres-generated UUID so we can include it
    # in the 202 response without a separate SELECT.
    pool = await get_pool()
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
            body.retrieval_strategy,
            body.chunker_strategy,
            body.retrieval_params,
            body.chunker_params,
            body.compression_enabled,
            body.compression_params,
            body.corpus_hash,
            body.question,
        )

    run_id = str(row["id"])

    # Load the corpus now so run_evaluation receives it ready-to-use.
    # This adds a small latency to the 202 response but avoids the
    # background task needing its own database connection for corpus loading.
    corpus = await load_corpus(body.corpus_hash)

    # Register the evaluation as a background task.
    # BackgroundTasks.add_task() accepts a callable and its arguments. FastAPI
    # calls it after the HTTP response is fully sent, so the client receives
    # its 202 without waiting for the potentially 30-second evaluation.
    background_tasks.add_task(
        run_evaluation,
        run_id=run_id,
        retrieval_strategy=body.retrieval_strategy,
        chunker_strategy=body.chunker_strategy,
        retrieval_params=body.retrieval_params,
        chunker_params=body.chunker_params,
        compression_enabled=body.compression_enabled,
        compression_params=body.compression_params,
        corpus=corpus,
        question=body.question,
        corpus_hash=body.corpus_hash,
    )
    print(f"[DEBUG] add_task called for run_id={run_id}", flush=True)

    return JSONResponse(status_code=202, content={"run_id": run_id})
