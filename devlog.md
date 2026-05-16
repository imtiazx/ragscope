# RAGScope devlog

## 2026-05-16 - Session C fix confirmed on Render

The background eval task is fully resolved on Render. End-to-end smoke test
ran against `https://ragscope-backend.onrender.com` after commit `a90edc8`:

- POST `/ingest` returned 200, `chunk_count=1`
- POST `/benchmark` (strategy=naive) returned 202 with one run_id
- Polled GET `/results/{run_id}` until terminal state
- Final state: `status=completed`, `error_message=null`, `latency_ms=72308`
- All three metrics non-null floats:
  - `faithfulness = 1.0`
  - `context_utilization = 0.9999999999`
  - `answer_relevancy = 0.9688423655062975`

### What it took to land

Two follow-up commits on top of `e7a69c5` (the `loop.create_task()` wrapper).

1. **`5aba230`** - per-metric isolation in `_run_ragas`. RAGAS 0.1.21 evaluates
   all metrics inside one `evaluate()` call, and its internal worker coroutines
   call `asyncio.timeout()`. When current_task is None in that worker, the
   whole call raises and aborts the run. Splitting into three sequential
   `evaluate(dataset, metrics=[m])` calls, each wrapped in `try/except
   BaseException`, isolates failures and writes `NaN` for the failing metric
   instead of killing the pipeline. Added `current_task()` probes before each
   per-metric call so Render logs show whether the task context survives.

2. **`a90edc8`** - post-commit cleanup noise guard. The first smoke test after
   `5aba230` showed all three metrics computed correctly, but status still
   flipped to `failed` with `error_message="Timeout should be used inside a
   task"`. The error fired in asyncpg's connection release *after* the step 7
   `status='completed'` UPDATE had already committed; the outer except then
   overwrote a successful run as failed. Added a `completed_committed` flag
   set inside the step 7 async-with right after `conn.execute()` returns. The
   outer except checks it and, if set, logs the cleanup exception and returns
   without modifying the row.

### Pytest

106 tests, 106 passed after each change. Mocks in `tests/test_eval.py` patch
`_run_ragas` at module level, so the per-metric refactor and the
post-commit flag did not require test changes.

### Caveat

Render free-tier deploys cause a ~2-3 min window during which incoming
benchmark requests can be accepted but their background tasks get lost
(server is being recycled). Two earlier smoke-test runs in this session
stayed at `status=pending` for 230s+ for exactly this reason, then the
next fresh request after redeploy succeeded. This is a Render infra
characteristic, not an application bug, but worth knowing for future
smoke tests: wait until the deploy is fully settled before submitting.

## 2026-05-16 - Session F: /chat endpoint and chat_count column

Closes the long-standing gap flagged in the audit: `backend/routers/chat.py`
did not exist, and `rate_limit_counters` had no `chat_count` column even
though `DAILY_CHAT_LIMIT = 5` was defined in `rate_limiter.py`. Step 4 of
the frontend had been routing chat questions through `/benchmark`, which
created stray `benchmark_runs` rows and consumed the 12/day run quota
instead of the 5/day chat quota.

### Schema

- `backend/core/database.py` `create_tables()` now declares
  `chat_count INTEGER NOT NULL DEFAULT 0` in the rate_limit_counters DDL,
  and follows the CREATE TABLE with an idempotent
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS chat_count ...` so any existing
  deployment that already created the table without the column picks up
  the column on next startup without manual intervention.
- The same migration was applied directly to the local Docker Postgres at
  `localhost:5433` via a one-off asyncpg session. Column verified present
  via `information_schema.columns`.
- **Production Supabase**: the `.env` SUPABASE_URL in this checkout points
  to the local Docker container, so I could not reach the production
  database from this session. The Supabase SQL editor still needs to run
  the same statement:
  ```sql
  ALTER TABLE rate_limit_counters
  ADD COLUMN IF NOT EXISTS chat_count INTEGER NOT NULL DEFAULT 0;
  ```
  Once that is executed, the next deploy (which calls `create_tables()`
  on startup) becomes a no-op for this concern.

### Endpoint

- New file `backend/routers/chat.py`. POST /chat accepts
  `{corpus_hash, question, retrieval_strategy, retrieval_params,
  compression_enabled, compression_params}` and returns
  `{answer, retrieved_chunks, strategy_used}`.
- Errors: 400 unknown strategy, 404 corpus not ingested, 429 daily chat
  limit reached (Tier 1).
- Tier 0 dev token bypasses the limit, matching `/benchmark`.
- Pool: per-request `make_task_pool()` opened on entry, closed in a
  `finally` block. No singleton pool usage from this route.
- Rate limit: a single SELECT reads today's `chat_count`; if >= 5 the
  request is rejected with 429 *before* the counter is touched. On the
  pass path, an upsert increments `chat_count` by one before retrieval
  runs (deduct-on-attempt semantics matching /benchmark).
- Pipeline: builds the retriever from `retrieval_registry`, optionally
  runs `ContextualCompressor`, then calls the existing
  `_generate_answer` helper. Same components the eval pipeline uses, just
  without RAGAS scoring.
- Logging: `logger.info` with fingerprint prefix (first 16 chars or "dev"),
  strategy, question length, answer length, chunk count, and compression
  flag. Never logs raw fingerprint or question/answer text.

### Supporting changes

- `backend/core/rate_limiter.py` gains `get_fingerprint_hash(request,
  x_fingerprint)` as a small FastAPI dependency that returns the SHA-256
  of `f"{client_ip}:{x_fingerprint}"`. /chat uses it via `Depends(...)`.
  /benchmark still inlines the same computation for backwards-compat;
  swapping that over would be a follow-up.
- `backend/main.py` imports the new `chat` router and registers it via
  `app.include_router(chat.router)` next to the existing three.

### Pytest and frontend build

- `python -m pytest` -> 106/106 pass.
- `npm run build` in `frontend/` -> success, all 6 pages prerendered,
  bundle sizes unchanged from the prior build.

### Frontend follow-up not done in this session

`frontend/app/app/steps/Step4Chat.tsx` still calls `createBenchmark()` for
each chat turn rather than POST /chat. That migration is the natural next
step but is out of scope for Session F (which was backend-only per the
task instructions: "Do not touch any frontend files"). Until the frontend
switches, the new endpoint is unused in production traffic.
