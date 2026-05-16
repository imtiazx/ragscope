"""
Chat router for RAGScope.

Handles POST /chat: runs a single retrieval-augmented question against a
previously-ingested corpus and returns the generated answer immediately. No
benchmark_runs row is created and no RAGAS evaluation is performed. This is
the live conversational surface that Step 4 of the frontend drives.

Rate limiting is independent of the benchmark counter. A guest user gets
DAILY_CHAT_LIMIT (5) chat questions per calendar day, tracked in
rate_limit_counters.chat_count keyed by (fingerprint_hash, date). The Tier 0
dev token bypasses the limit unconditionally. The counter is incremented
BEFORE retrieval starts so an attempted question always costs one regardless
of whether retrieval or answer generation later fails - matching the
deduct-on-attempt semantics used by /benchmark.

Implementation notes:
- The route uses make_task_pool() to create a fresh asyncpg pool per request
  rather than sharing the module-level singleton. This isolates long-running
  chat connections from other endpoints and matches the pattern documented
  by the user for /chat. The pool is always closed in a finally block.
- The retriever, optional contextual compressor, and answer generator are
  the same components the background eval pipeline uses, so retrieval
  behaviour is identical to a /benchmark run. The chat route just skips the
  RAGAS scoring step.
- Logger messages include only the first 16 chars of fingerprint_hash (or
  the literal 'dev' for Tier 0) plus strategy, question length, and answer
  length. Full hashes and content are never logged.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.core.auth import get_dev_access
from backend.core.database import make_task_pool
from backend.core.rate_limiter import DAILY_CHAT_LIMIT, get_fingerprint_hash
from backend.eval.ragas_runner import _generate_answer
from backend.llm.openai_provider import OpenAIProvider
from backend.retrieval.contextual_compression import ContextualCompressor
from backend.retrieval.registry import registry as retrieval_registry

router = APIRouter()
logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    """
    JSON body accepted by POST /chat.

    Mirrors the per-strategy fields of BenchmarkRequest but is flat: a chat
    request always targets exactly one retrieval strategy. corpus_hash must
    refer to a corpus previously ingested via POST /ingest.
    """

    corpus_hash: str
    question: str
    retrieval_strategy: str
    retrieval_params: dict = {}
    compression_enabled: bool = False
    compression_params: dict = {}


class ChatChunk(BaseModel):
    """
    One retrieved chunk in the chat response.

    Shape matches the JSONB rows produced by /benchmark's retrieved_chunks
    field so the frontend can render chunk lists with the same component
    regardless of which endpoint produced them.
    """

    chunk_id: str
    content: str
    score: float
    metadata: dict = {}


class ChatResponse(BaseModel):
    """
    Response body returned by POST /chat.

    Carries the generated answer plus the chunks the retriever surfaced so
    the frontend can show provenance ("answer derived from N chunks") and
    optionally render the source passages.
    """

    answer: str
    retrieved_chunks: list[ChatChunk]
    strategy_used: str


@router.post("/chat", response_model=ChatResponse)
async def chat(
    body: ChatRequest,
    dev_access: bool = Depends(get_dev_access),
    fingerprint_hash: str = Depends(get_fingerprint_hash),
) -> ChatResponse:
    """
    Run retrieval and answer generation for a single chat question.

    Pipeline:
      1. Validate the requested retrieval strategy exists in the registry.
      2. Open a fresh task pool for this request (closed in finally).
      3. Confirm the corpus_hash has at least one stored chunk.
      4. Unless dev_access is True, read today's chat_count for the
         fingerprint and refuse with HTTP 429 if it already meets the
         daily limit. Otherwise increment the counter by one before any
         expensive work begins.
      5. Load all chunks for the corpus into memory.
      6. Construct the requested retriever with the user's params and call
         its retrieve() method.
      7. If compression_enabled, run ContextualCompressor over the result.
      8. Generate an answer from the (possibly compressed) chunks using the
         same _generate_answer helper the eval pipeline uses.
      9. Return ChatResponse.

    Parameters
    ----------
    body : ChatRequest
        Request body containing corpus_hash, question, strategy, and params.
    dev_access : bool
        Injected by Depends(get_dev_access). True if the X-Dev-Token header
        passes validation; bypasses the chat_count limit unconditionally.
    fingerprint_hash : str
        Injected by Depends(get_fingerprint_hash). SHA-256 of
        f"{ip}:{x_fingerprint}". Used as the rate-limit key.

    Returns
    -------
    ChatResponse
        answer is the LLM-generated answer string. retrieved_chunks lists
        every chunk surfaced by the retriever (after optional compression).
        strategy_used echoes body.retrieval_strategy for the client.

    Raises
    ------
    HTTPException 400
        Unknown retrieval_strategy.
    HTTPException 404
        corpus_hash has no stored chunks - call POST /ingest first.
    HTTPException 429
        Guest tier daily chat limit reached and dev_access is False.
    """
    # Step 1: validate strategy first so a bad strategy never opens a pool.
    if body.retrieval_strategy not in retrieval_registry:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown retrieval strategy {body.retrieval_strategy!r}. "
                f"Available strategies: {sorted(retrieval_registry.keys())}"
            ),
        )

    # Step 2: dedicated pool per request. asyncpg pools are tied to the event
    # loop that created them; /chat creates and closes its own so it never
    # shares connections with /benchmark, /ingest, or background tasks.
    pool = await make_task_pool()
    try:
        # Step 3: corpus_exists check using the request pool directly. This
        # uses the per-request pool rather than the singleton (matches the
        # documented pattern for /chat).
        async with pool.acquire() as conn:
            corpus_row = await conn.fetchrow(
                "SELECT 1 FROM corpus_chunks WHERE corpus_hash = $1 LIMIT 1",
                body.corpus_hash,
            )
        if corpus_row is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"Corpus {body.corpus_hash!r} not found. "
                    "Call POST /ingest first to upload and index the document corpus."
                ),
            )

        # Step 4: rate limit check, then increment. The check and increment
        # are separate statements rather than a CTE because the increment is
        # only run after the check passes - this avoids briefly bumping the
        # counter for a request that ends up rejected, which would let a
        # determined attacker drain the quota via repeated 429s.
        if not dev_access:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT chat_count FROM rate_limit_counters
                    WHERE fingerprint_hash = $1 AND date = CURRENT_DATE
                    """,
                    fingerprint_hash,
                )
            current_count = int(row["chat_count"]) if row is not None else 0
            if current_count >= DAILY_CHAT_LIMIT:
                raise HTTPException(
                    status_code=429,
                    detail=(
                        f"Daily chat limit of {DAILY_CHAT_LIMIT} questions reached. "
                        "Your limit resets at midnight UTC. Paste your own API key "
                        "in Settings to chat without limits."
                    ),
                )
            # Charge on attempt: increment before retrieval starts so a long
            # retrieval that the user abandons still consumes a question.
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO rate_limit_counters (fingerprint_hash, date, chat_count)
                    VALUES ($1, CURRENT_DATE, 1)
                    ON CONFLICT (fingerprint_hash, date)
                    DO UPDATE SET chat_count = rate_limit_counters.chat_count + 1
                    """,
                    fingerprint_hash,
                )

        # Step 5: load the full corpus. Inlined rather than calling
        # database.load_corpus() because that helper uses get_pool(), and
        # /chat is supposed to stay on its dedicated per-request pool.
        async with pool.acquire() as conn:
            chunk_rows = await conn.fetch(
                """
                SELECT id, content, embedding
                FROM corpus_chunks
                WHERE corpus_hash = $1
                ORDER BY chunk_index
                """,
                body.corpus_hash,
            )
        corpus = [
            {
                "chunk_id": str(row["id"]),
                "content": row["content"],
                "embedding": list(row["embedding"]),
            }
            for row in chunk_rows
        ]

        # Step 6: build the retriever from registry and run retrieval.
        # retrieval_params is passed through to the constructor; the frontend
        # is responsible for sending only keys that appear in the strategy's
        # param_schema (which it pulls from GET /strategies).
        retriever_cls = retrieval_registry[body.retrieval_strategy]
        retriever = retriever_cls(corpus=corpus, **body.retrieval_params)
        top_k = body.retrieval_params.get("top_k", 5)
        results = await retriever.retrieve(body.question, top_k)

        # Step 7: optional contextual compression. Reuses the same compressor
        # the eval pipeline uses so chat answers and benchmark answers see
        # identical context preparation.
        if body.compression_enabled:
            compressor = ContextualCompressor(
                min_relevance_length=body.compression_params.get("min_relevance_length", 50),
                llm_provider=OpenAIProvider(),
            )
            results = await compressor.compress(results, body.question)

        # Step 8: answer generation. _generate_answer uses provider.complete_sync()
        # internally, which blocks the event loop briefly during the LLM call.
        # Tier 1 chat is rate-limited to 5/day per user, so the blocking is
        # acceptable for the expected concurrency on Render's free tier.
        provider = OpenAIProvider()
        contexts = [r.content for r in results]
        answer = _generate_answer(body.question, contexts, provider)

        # Telemetry: log identity prefix and sizes only. Never log raw
        # fingerprint, full question text, or full answer text.
        fp_prefix = "dev" if dev_access else fingerprint_hash[:16]
        logger.info(
            "chat: fp=%s strategy=%s q_len=%d a_len=%d chunks=%d compression=%s",
            fp_prefix,
            body.retrieval_strategy,
            len(body.question),
            len(answer),
            len(results),
            body.compression_enabled,
        )

        # Step 9: shape the response. retrieved_chunks mirrors the JSONB
        # shape stored by /benchmark so the frontend renders both with the
        # same component.
        return ChatResponse(
            answer=answer,
            retrieved_chunks=[
                ChatChunk(
                    chunk_id=r.chunk_id,
                    content=r.content,
                    score=r.score,
                    metadata=r.metadata,
                )
                for r in results
            ],
            strategy_used=body.retrieval_strategy,
        )
    finally:
        await pool.close()
