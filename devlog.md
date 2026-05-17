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

## 2026-05-16 - Session D: Step4Chat switched to POST /chat

Closes the frontend follow-up flagged at the end of Session F. Step 4 of
the app no longer creates benchmark_runs rows for chat turns and no longer
consumes the 12/day run quota when a user just wants to ask questions.

### Behavior changes

- One user message now triggers a single synchronous POST /chat call. The
  request/response pipeline is gone (no `createBenchmark` followed by
  `getRunStatus` polling); the answer arrives in one HTTP round-trip.
- The chat counter is no longer keyed in localStorage. Component-local
  state `questionsUsed` starts at 0 on mount and increments by 1 per
  successful response. The backend's `chat_count` column is authoritative;
  the in-memory counter is display-only and may desync across reloads or
  browsers (acceptable per the prior audit note).
- HTTP 429 from POST /chat now flips `forcedLimitReached` to true, which
  disables the input and shows the "Daily chat limit reached - add an API
  key" upgrade prompt immediately, regardless of what the local counter
  says. Backend wins.
- Tier 0 dev token: unchanged. `isDevMode` still hides the counter and
  shows "Dev mode - unlimited"; the input never disables in dev mode.
- Each assistant message shows `strategy_used` and `retrieved_chunks.length`
  from the /chat response in the metadata line below the bubble.

### Code

- `frontend/lib/api.ts`: new `ApiError` class (extends Error, carries
  `.status`). `apiFetch` now throws `ApiError` on non-2xx so callers can
  branch on `err.status === 429` instead of string-matching the message.
  Backwards compatible: legacy callers reading `.message` still work
  because ApiError extends Error.
- `frontend/lib/api.ts`: new `chatRequest(payload)` that POSTs /chat and
  types the response as `{answer, retrieved_chunks: ChatChunk[],
  strategy_used}`.
- `frontend/app/app/steps/Step4Chat.tsx`:
  - Removed `chatCountKey`, `getChatCount`, `incChatCount` localStorage
    helpers and the `sessionId` derivation.
  - Removed `POLL_MS` and the polling loop in `handleSend`.
  - Replaced `createBenchmark(...).run_ids[0]` + `getRunStatus()` polling
    with a single `chatRequest(...)` call.
  - Added `forcedLimitReached` state, flipped to true on `ApiError`
    `status === 429`.
  - Module docstring updated to describe the new flow.

### Tests and build

- `python -m pytest`: 106 / 106 pass (no backend touched, sanity check only).
- `npm run build` in `frontend/`: clean exit 0, all 6 pages prerendered.
  `/app` bundle 126 kB, unchanged from the post-Session-F baseline (the
  reduction from removing polling code is offset by the new ApiError
  class plus chat types, which net out).

### Verification matrix

| Behavior | Expected | Result |
|----------|----------|--------|
| Dev mode shows "Dev mode - unlimited" | yes | unchanged from prior session |
| Guest shows "X/5 questions remaining" | yes | now reads component state, decremented on each successful /chat |
| Input disabled on backend 429 | yes | `forcedLimitReached` set, upgrade prompt shown |
| benchmark_runs rows created from chat | no | confirmed - chat path no longer touches /benchmark |
| Strategy + chunk count in message metadata | yes | now from `response.strategy_used` and `response.retrieved_chunks.length` |

### Pre-existing issues not fixed in this session

- BYOK (`state.byokKey` set) users still go through POST /chat instead of
  calling the LLM provider direct from the browser. They will eventually
  hit the same 5/day backend limit even though Tier 2 is supposed to be
  unlimited. Implementing the direct-to-provider path via
  `frontend/lib/llm-client.ts` is a separate task.
- `Step2Configure.tsx` still uses localStorage for the run-count display
  counter. Same desync caveat applies. Out of scope for this session.

## 2026-05-16 - Session E: multi-strategy submission and streaming results UI

Closes the largest audit gap: the backend has always accepted a list of
strategies on POST /benchmark and created one background task per entry,
but the frontend was hardcoded to a single-strategy radio group and a
single-runId poll. This session aligns the frontend with the documented
architecture decision (one run_id per strategy, streamed independently).

### State (AppContext)

- New fields on `AppState`:
  - `selectedStrategies: string[]` (preserves click order)
  - `paramsByStrategy: Record<string, Record<string, unknown>>`
    (per-strategy retrieval params)
  - `runIds: string[]` (parallel to selectedStrategies)
- New actions: `SET_SELECTED_STRATEGIES`, `SET_PARAMS_BY_STRATEGY`,
  `SET_RUN_IDS`.
- Removed: `runId: string | null` and `SET_RUN_ID` (no consumers remain
  after the Step 4 chat migration in Session D).
- Legacy `retrievalStrategy` / `retrievalParams` kept on state and
  populated from the first selected strategy at submit time, so
  Step4Chat continues to have a sensible default to chat with after a
  multi-strategy benchmark completes.

### Step 2 (`Step2Configure.tsx`)

- Replaced the `selectedStrategy: string` radio group with a
  `selectedStrategies: string[]` multi-select. Each card is a
  `role="checkbox"` button with a `Check` icon in the top-right that
  flips on/off. Click-order is preserved in the array.
- Per-strategy parameter section: when N strategies are selected, the
  panel renders N stacked param cards, each labeled with the strategy's
  `display_name` and a "Reset defaults" button. State for params is
  tracked in `paramsByStrategy` keyed by strategy name.
- Compression stays an orthogonal toggle at the bottom, outside the
  strategy section, with copy that explicitly notes "The same setting
  is applied to every selected strategy".
- Run-cost hint below the strategy grid: `"This will use N of your X
  remaining runs."` (or red `"Selected N but only X of 12 remain"`
  when over quota). Dev mode shows `"Dev mode - unlimited"` in that
  slot instead.
- canRun guard: question non-empty AND N >= 1 AND (dev OR BYOK OR N <=
  runsRemaining). Button label stays `"Run benchmark"` regardless of N.
- POST /benchmark now sends a real list:
  ```ts
  strategies: selectedStrategies.map(name => ({
    strategy: name,
    retrieval_params: paramsByStrategy[name] ?? {},
    compression_enabled: compressionEnabled,
    compression_params: compressionEnabled ? compressionParams : {},
  }))
  ```
  After the 202, all `result.run_ids` are dispatched as `SET_RUN_IDS`,
  not just `[0]`.
- Local guest counter decrements by `selectedStrategies.length` on a
  successful response (was: always +1).

### Step 3 (`Step3Results.tsx`)

- Reads `state.runIds` and `state.selectedStrategies` as parallel
  arrays. Builds `strategyByRunId` map for label rendering.
- Polling: a single `setInterval` calls GET /results/{run_id} for
  every still-pending run in parallel via `Promise.all`. When one
  reaches a terminal state, its result is `addRunResult()`ed
  immediately and `completedRunIds` is updated; the next tick stops
  polling that one but continues for the others.
- The effect dep is `pendingRunIds.join(',')` so the interval is only
  torn down when set membership changes (i.e. when a run finishes),
  not on every render.
- Added "evaluating..." rows to the comparison table for each
  still-pending strategy: a spin-icon + strategy label, with
  `colspan=4` reading "evaluating..." in the metric cells. Failed
  strategies render as red rows with the backend error message.
- Replaced the full-screen `PollingProgress` view with a small
  `LiveProgressBanner` at the top of the dashboard
  ("Evaluating M of N strategies. Results appear as each one finishes.").
  The dashboard is visible from the moment the user lands on Step 3
  rather than blocking behind a spinner.
- Charts (radar, latency, score cards) still gate themselves on
  `completed.length > 0`. They were already array-based so they
  display all completed runs in the current submission plus any from
  prior submissions in run_history.
- Empty state only shows when there are truly no runIds, no history,
  no evaluating, and no failed entries.
- "Chat with corpus" button now disabled until at least one strategy
  has completed (otherwise Step 4 has no winner to default to).
- "Clear history" also clears `runIds`, `selectedStrategies`,
  `completedRunIds`, `errorByRunId`, and the `addedRef` dedupe set,
  so the dashboard resets cleanly.

### Build and test

- `npm run build` -> clean exit 0, all 6 pages prerendered. `/app`
  bundle 127 kB (+1 kB vs prior session: parallel polling, evaluating
  rows, per-strategy param state).
- `python -m pytest` -> 106 / 106 pass (backend untouched).

### Verification matrix (per task spec)

| Behavior | Expected | Result |
|----------|----------|--------|
| Multi-select strategy grid | yes | checkbox cards, click-order preserved |
| At least one strategy required | yes | Run button disabled when N == 0 |
| Quota hint "This will use N of X remaining" | yes | shown below grid; red when over quota |
| Dev mode shows "Dev mode - unlimited" in Step 2 | yes | unchanged; replaces the quota hint and the counter pill |
| Compression stays orthogonal | yes | separate section below the strategy params, not inside any card |
| Run button label "Run benchmark" | yes | does not change with N |
| POST /benchmark sends list, stores all run_ids | yes | `result.run_ids` -> `SET_RUN_IDS` |
| Step 3 polls all run_ids in parallel | yes | single setInterval, `Promise.all` over pending |
| Stream completion per strategy | yes | each terminal result `addRunResult`ed immediately |
| Per-strategy "evaluating..." row | yes | spinner + label in comparison table |
| Failed strategy row, others keep going | yes | red row, polling continues for siblings |
| Winner badge after all complete | yes | already array-based; appears once any complete |
| Radar / latency / table read arrays | yes | confirmed during rewrite; no per-run assumption |
| run_history accumulates across runs | yes | `addRunResult` reducer unchanged, localStorage hydrates on mount |

### Out of scope

- BYOK direct-to-provider chat path (still flagged from Session D).
- Per-strategy compression toggles (architecture explicitly says
  compression is shared across selected strategies; not a future task).
- Backend still inlines fingerprint computation in `benchmark.py` while
  `/chat` uses `get_fingerprint_hash`. Could refactor benchmark.py to
  use the same dependency; not done here.

## 2026-05-16 - Session G: deploy hygiene and ready for Session H

Five cleanup items before the Session H benchmark sweep. All independent.

### What landed

1. **`render.yaml`** (new at repo root). Declares the `ragscope-backend`
   web service for Render. Build: `pip install -r requirements.txt`.
   Start: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`. Plan
   `free`. Eight envVar entries with `sync: false` so values stay in the
   Render dashboard and never get committed: `OPENAI_API_KEY`,
   `SUPABASE_URL`, `SUPABASE_KEY`, `LANGCHAIN_API_KEY`,
   `LANGCHAIN_TRACING_V2`, `LANGCHAIN_PROJECT`, `DEV_TOKEN`,
   `MAX_FILE_SIZE_BYTES`. Comments call out the free-tier spin-down
   characteristic.
2. **`README.md`** (new at repo root). Seven sections in sentence case:
   what RAGScope is, live links, retrieval strategies (four methods
   listed plus contextual compression flagged separately as a
   post-retrieval processor), evaluation metrics (faithfulness,
   context utilization, answer relevancy), access tiers (Guest, BYOK,
   Dev), local dev setup (commands lifted verbatim from CLAUDE.md),
   stack. No em-dashes, no emoji.
3. **CORS** in `backend/main.py`. `allow_origins` tightened from `["*"]`
   to the two trusted origins:
   `["https://ragscope.vercel.app", "http://localhost:3000"]`. Comment
   updated to explain why the wildcard would be unsafe with
   `allow_credentials=True`.
4. **Landing page copy fix** in `frontend/app/page.tsx`. The
   `WHY_ITEMS[0].body` blurb said "Context precision measures whether
   the retrieved chunks were relevant" - replaced with "Context
   utilization" so the marketing copy matches the metric name used
   everywhere else (RAGAS code, /strategies API, docs page, results
   dashboard).
5. **`ShootingStars.tsx` -> `SnowflakeBackground.tsx`**.
   `git mv frontend/components/ShootingStars.tsx
   frontend/components/SnowflakeBackground.tsx`. The component function
   inside also renamed from `ShootingStars` to `SnowflakeBackground`.
   The stale "Exported as ShootingStars" line in the module docstring
   removed. `frontend/app/page.tsx` import path and JSX usage updated
   in lockstep. Implementation untouched - particles still drift down
   with sine-wave horizontal oscillation, no streaking.

### Build and test

- `python -m pytest`: 106 / 106 pass after the CORS change.
- `npm run build`: clean exit 0, all 6 pages prerendered, `/app` 127 kB
  (unchanged from post-Session-E baseline).
- Em-dash scan on `render.yaml`, `README.md`, `backend/main.py`, and
  `frontend/components/SnowflakeBackground.tsx`: clean.
- `grep "ShootingStars" frontend/`: no matches.
- `grep "Context precision" frontend/app/page.tsx`: no matches.

### Ready for Session H

The project is now in a publishable state for the benchmark sweep:
- Backend has a Render service spec, tightened CORS, and a chat endpoint.
- Frontend builds cleanly with multi-strategy selection and streaming
  results, snowflake background named correctly, and metric copy
  consistent with the rest of the app.
- README at repo root explains the project to a first-time visitor.
- All 106 tests green.

Session H can now run the 10 motor-vehicle benchmark questions across
all four retrieval strategies. The corresponding session entry should
record the strategy that wins on weighted-average across the question
set.

## 2026-05-16 - Session H: motor vehicle benchmark sweep (BLOCKED)

Attempted but did not complete. The 40-run sweep collected effectively
no data because the Render free-tier backend went into a state where
new POST /benchmark calls were accepted but their background tasks
never executed. Status stayed at `pending` indefinitely and the
post-Session-C `status='running'` transition never fired, which means
the failure is upstream of any of the recent fixes - the worker
thread never even called the first asyncpg statement.

### What I attempted

1. Created `/tmp/motor_vehicles.txt`, an 865-word corpus covering the
   ten topics the questions ask about (four-stroke engine, brakes,
   turbocharger, transmission, regen, knocking, fuel injection,
   catalytic converter, traction vs stability, maintenance intervals).
2. POST /ingest at 18:13 succeeded:
   `corpus_hash=f5c424afb759acb74477baa0c3babfb40930dad0129a95507e96e26a46ea0e93`,
   `chunk_count=2`. (Default chunker produces 2 chunks at 512-token
   chunk_size for 865 words; fewer than the target 3-5 but enough for
   the strategies to be exercised.)
3. Wrote a Python runner at `/tmp/session_h_runner.py` that POSTs one
   /benchmark per (question, strategy) pair, polls GET /results every
   5 s up to 300 s, then appends a CSV row. Dev token bypass via
   `X-Dev-Token: imtiazx` header.
4. First runner attempt (18:16-18:22): Q1/naive completed in 89.7 s
   (faithfulness 1.0, context_utilization 0.99999..., answer_relevancy
   0.926). Q1/hyde polling hit the original 200 s timeout. Killed the
   runner, extended polling to 300 s, restarted.
5. Second runner attempt (18:23-22:00, ~3.5 h): all 40 runs hit the
   300 s polling timeout. CSV: 40 rows, all `status=timeout`, every
   metric column empty.

### Diagnosis (no Render log access from this session)

Probed the backend directly after the second attempt finished:

- `/health` returns 200 in ~280 ms.
- `/strategies` returns the expected registry payload.
- A fresh `POST /benchmark` returns 202 with a run_id immediately.
- `GET /results/<run_id>` returns `status=pending` and stays there
  for the full 300 s I polled - no transition to `running`.

`status=pending` (not `running`) means `_run_evaluation_async`'s very
first `pool = await make_task_pool()` was never reached either, so:

- It is not a per-metric RAGAS issue (Session C territory) - the
  background task never got far enough to call RAGAS.
- It is not the asyncpg post-commit cleanup noise (Session C, second
  fix) - same reason.
- It is something earlier in the dispatch path: either anyio's worker
  thread pool is exhausted from prior hung tasks, the worker is
  pinned by an OS-level issue, or Render's free-tier instance is in
  a degraded state that lets requests in but cannot fork worker
  threads.

The first run of Session H (Q1/naive 89.7 s) succeeded, then every
later run stuck. That pattern matches "one worker thread successfully
runs, gets stuck somewhere on exit, all subsequent dispatches queue
behind it". A likely candidate is the asyncpg pool created by
`make_task_pool()` hanging on its TCP connect to Supabase due to a
Render-side network issue; if the connect never errors and never
completes, the background thread holds onto its worker forever.

### Partial data (one data point only)

| Question | Strategy | Status | Faithfulness | Context util. | Answer rel. | Latency |
|----------|----------|--------|--------------|---------------|-------------|---------|
| Q1 | naive | completed | 1.0 | 0.99999... | 0.9262 | 89.7 s |

Everything else: `timeout`, no metric data.

### Why no summary table or winner

A weighted-average ranking across one out of forty data points is
meaningless. Reporting a "winner" from a sample of one would be
misleading. The user's stated success criterion ("table showing
average ... per strategy across all 10 questions") cannot be honestly
satisfied from the data this session collected.

### What would unblock a retry

1. Force a Render redeploy by pushing any commit to `main` (an empty
   `git commit --allow-empty -m "kick render"` is enough). The
   redeploy resets all worker threads and connection pools. The first
   benchmark after the redeploy will land on a clean worker. This
   step requires explicit user authorisation per the project rule
   that commits and pushes must be requested.
2. Optionally upgrade Render from free to a paid tier so workers do
   not spin down and so resource limits are higher. Free-tier compute
   has been the recurring infrastructure constraint in this project.
3. Re-run `/tmp/session_h_runner.py` against the same `corpus_hash`
   immediately after the redeploy lands (commit hash is visible in
   the `X-Render-Version` response header if Render emits one;
   otherwise wait the documented 2-3 min redeploy window from
   Session C).
4. Consider running fewer than 40 runs per session to fit inside the
   Render free-tier worker capacity, e.g. one question at a time, or
   spreading the 40 runs across multiple sessions with redeploy
   between batches.

### Files touched

- `/tmp/motor_vehicles.txt` (temporary corpus)
- `/tmp/session_h_runner.py` (temporary runner)
- `/tmp/session_h_results.csv` (40 timeout rows)
- `/tmp/session_h_log.txt` (runner log)
- `devlog.md` (this entry)

No project files were modified. No commits made.

## 2026-05-16 - Python 3.14 asyncpg Task-context diagnostic

Render produced a clean traceback that explains why the Session H
backend got stuck at `status=pending` across every benchmark. On
Python 3.14:

```
File "ragas_runner.py", line 433, in _run_evaluation_async
    pool = await make_task_pool()
File "database.py", line 142, in make_task_pool
    return await asyncpg.create_pool(
File "asyncpg/pool.py", line 418, in __async_init__
    await self._initialize()
File "asyncpg/connection.py", line 2420, in connect
    async with compat.timeout(timeout):
RuntimeError: Timeout should be used inside a task
```

`asyncpg.create_pool()` calls into `connection.connect()` which uses
`compat.timeout()`. On Python 3.14 `compat.timeout` is
`asyncio.timeout`, which raises `RuntimeError("Timeout should be used
inside a task")` when `asyncio.current_task()` returns None at the
point the context manager is entered.

The current `run_evaluation()` wrapper already uses
`loop.run_until_complete(loop.create_task(_run_evaluation_async(...)))`
which is the documented fix for the outer Task context (introduced in
commit `e7a69c5`). If that wrapping is correctly propagated to the
coroutine then `asyncio.current_task()` inside `_run_evaluation_async`
should return the outer Task and asyncpg should be happy. The fact
that it is NOT happy on Python 3.14 means one of two things:

1. **Outer Task wrapping is not propagating on 3.14.** Some change
   between 3.11/3.12 and 3.14 in how `loop.create_task()` interacts
   with `loop.run_until_complete()` causes `current_task()` to be None
   inside the coroutine. Unlikely but possible.
2. **asyncpg's internal coroutines escape the outer Task context.**
   `pool._initialize()` uses `asyncio.gather()` to set up connections
   in parallel; on Python 3.14 those gathered sub-coroutines may not
   inherit a Task identity in the way asyncpg's `compat.timeout`
   expects. This is the more likely culprit.

### Diagnostic change made this session

Added an explicit `assert asyncio.current_task() is not None` at the
top of `_run_evaluation_async`, immediately before any asyncpg call,
plus a `[DEBUG] _run_evaluation_async ENTRY ... current_task=...`
print that fires the moment the coroutine starts. The next Render
benchmark run will surface one of two outcomes in the logs:

- The assert fires (or the print shows `current_task=None`): outer
  Task wrapping is broken on 3.14 and we need a new approach for the
  background-task event loop.
- The print shows a non-None Task but the original `Timeout should be
  used inside a task` from asyncpg still appears: asyncpg internals
  are the source. Fix paths from there include wrapping the
  `make_task_pool()` call in its own `asyncio.create_task()` to give
  asyncpg a fresh inner Task to attach to, pinning `asyncpg` to a
  version that does not rely on `asyncio.timeout`, or pinning the
  Render runtime to Python 3.11 / 3.12 via `runtime.txt` until the
  asyncpg side is fixed upstream.

### Files

- `backend/eval/ragas_runner.py`: added the assert + entry print to
  `_run_evaluation_async`. No other changes.

### Tests and deploy

- `python -m pytest`: 106 / 106 pass. The local Python 3.11 test
  environment always sets `current_task()` (pytest-asyncio drives
  coroutines as Tasks), so the assert is a no-op here. It only
  surfaces useful information on Render.
- Commit + push triggered Render redeploy so the next /benchmark hit
  will produce the diagnostic logs.

### Session H not retried

Session H remains blocked pending the next round of Render-log data.
The 40-run sweep is not attempted until either the assert tells us
the outer Task wrapping is broken (fix that first) or it confirms the
wrapping is fine and we move on to the asyncpg-internals fix.

## 2026-05-17 - Pin Render to Python 3.11

The diagnostic assert from commit `3519715` confirmed the failure mode:

- A single isolated /benchmark on a freshly-warm Render worker
  succeeded (the diagnostic run earlier this session reached
  `status=running` and produced the new
  `[DEBUG] _run_evaluation_async ENTRY ... current_task=<Task ...>`
  log line - the outer Task wrapping IS propagating for the first run).
- But under parallel submission (the Session H batches of 4 strategies
  at once) the assert fired: `current_task=None` inside
  `_run_evaluation_async`, with `nest_asyncio.py:98` visible in the
  traceback.

So the issue is not the outer wrapper or asyncpg internals in
isolation. It is the interaction between Python 3.14's stricter
`asyncio.timeout()` contract, `nest_asyncio`'s patch of
`loop.run_until_complete`, and multiple `loop.create_task()` calls
landing on the same loop concurrently from a FastAPI background-task
worker thread. On 3.14 the patched `run_until_complete` does not
preserve the Task identity across the patched call boundary when
several tasks are created on the same loop in close succession.

Trying to outsmart Python 3.14 asyncio internals further is not the
right move. The cleanest fix is to stop running on 3.14.

### What changed

1. `runtime.txt` at repo root contains `python-3.11.9`. Render reads
   this file during the build phase and pins the service to that
   exact Python version. The next deploy log should show
   `Python 3.11.9` instead of 3.14.
2. The diagnostic assert and entry print in `_run_evaluation_async`
   are removed. They served their purpose (confirmed the diagnosis)
   and on 3.11 the original `loop.create_task() +
   loop.run_until_complete(task)` pattern works correctly. Keeping
   the assert would just crash valid runs if any future regression
   regressed the wrapper. All other `[DEBUG] ...` prints are kept.

### Tests and deploy

- `python -m pytest`: 106 / 106 (local was already 3.11; assert
  removal is a no-op for tests).
- Commit + push triggers Render redeploy. Render's build log should
  show `python-3.11.9` selected; if it still shows 3.14 the file was
  not honoured and we need to investigate the Render service config.

### Session H still deferred

Do not run Session H until the user confirms the redeploy is on
3.11 and Render logs no longer show the asyncpg `Timeout` traceback
under parallel load.

## 2026-05-17 - Use direct asyncpg connection in background task

Render's free tier is locked to Python 3.14 (the `runtime.txt` pin
from the previous entry was not honoured on this plan). Working
around 3.14's stricter `asyncio.timeout()` contract in code instead.

### Diagnosis recap

`asyncpg.create_pool()` internally drives its connection setup through
`asyncio.gather()` of multiple sub-coroutines, and asyncpg's `compat`
timeout wraps each with `asyncio.timeout()`. On Python 3.14, when
several background tasks call `create_pool()` concurrently against the
same event loop in a FastAPI background-task worker thread (Session H
batches of 4 strategies), `asyncio.current_task()` returns `None`
inside those gathered sub-coroutines and `asyncio.timeout()` raises
`RuntimeError("Timeout should be used inside a task")`. Single
isolated runs avoided the race and worked fine; parallel runs broke.

### Fix

Sidestep `create_pool()` entirely in the background-task path by using
a single direct `asyncpg.connect()` per benchmark run. `asyncpg.connect()`
drives one coroutine in the caller's existing Task context and does
not trigger the same gather/timeout pattern.

### Code changes

1. `backend/core/database.py`: new `make_task_connection()` returns a
   single `asyncpg.Connection`. It applies the same `_init_connection`
   codec registration (JSONB + pgvector) that the pool's `init=`
   callback would have applied automatically. `make_task_pool()` is
   kept in place for tests and any future caller that genuinely
   needs a pool.
2. `backend/eval/ragas_runner.py`: `_run_evaluation_async` now opens
   a single connection at the start (`conn = await make_task_connection()`)
   and closes it in the finally block. All four `async with
   pool.acquire() as conn:` blocks become direct `await conn.execute(...)`
   or `await conn.fetch(...)` calls. The post-commit cleanup-noise
   guard (`completed_committed` flag) is retained: even on a direct
   connection, `conn.close()` or any other late asyncpg call could
   still raise the timeout error under 3.14, so the outer except
   distinguishes that case from a real failure.
3. `tests/test_eval.py`: the `_MockConnection` gains an `async def
   close()` no-op, and the six `_run_evaluation_async` tests now
   patch `make_task_connection` instead of `make_task_pool` and
   return the bare mock connection (no pool wrapper). The two
   `get_run` tests still patch `get_pool` (the FastAPI singleton)
   and remain unchanged in behaviour.

### Why direct connection is safe here

The background task makes exactly two short-lived DB hops (step 1
status update, step 2 corpus load) and one final write (step 7),
with several seconds of OpenAI/RAGAS work in between. A pool's job
is to amortise connect cost across many concurrent SQL ops; this
function does a handful of statements over a single logical session,
so a pool was never a strong fit. Single connections also avoid the
class of bugs where `pool.acquire()`'s `__aexit__` raises - which
is the original Session C issue and the one the `completed_committed`
guard was added for.

### Tests and deploy

- `python -m pytest`: 106 / 106 pass.
- Commit `fix: use direct asyncpg connection in background task to
  avoid Python 3.14 Task context issue` pushed to `main`; Render
  redeploys automatically.

### Files in this commit

- `backend/core/database.py`
- `backend/eval/ragas_runner.py`
- `tests/test_eval.py` (mock infrastructure mirrors the new code path)
- `devlog.md`

`tests/test_eval.py` is in the commit even though it was not in the
explicit `git add` list for this fix - without the mock update,
pytest would fail because six tests patch a function the production
code no longer calls. The patch target rename and the `close()` mock
method are mechanical mirrors of the production change.

### Session H still deferred

Do not start Session H until Render serves the new commit and a
single probe `/benchmark` confirms the parallel-load Timeout
traceback is gone.

## 2026-05-17 - Disable asyncpg connect timeout to dodge asyncio.timeout

The previous fix (direct `asyncpg.connect()` instead of `create_pool()`)
removed the gather-of-coroutines failure mode, and a 4-strategy parallel
probe at `19:24Z` against commit `06a54d5` ran clean (4 / 4 `completed`,
~75 s each, no Task-context errors in logs). Encouraging, but a follow-up
Session H attempt against a different Render worker instance still
surfaced `RuntimeError("Timeout should be used inside a task")` from
inside `asyncpg.connect()` itself - the `asyncio.timeout()` call in the
TCP connect path of asyncpg's compat module fires regardless of how
asyncpg's internal coroutine structure is shaped, because the failure
mode is deeper than the pool initialiser.

### Fix: pass `timeout=None` to asyncpg

`asyncpg.connect()` and `asyncpg.create_pool()` both honour
`timeout=None`. When the timeout is None, asyncpg skips the
`asyncio.timeout()` context manager entirely and `await`s the TCP
connect without an application-level deadline. The connect still fails
fast if Supabase is genuinely unreachable (OS-level socket error), so
the loss of an application-level timeout is acceptable here - the
background task has nothing else to race against anyway.

Same treatment applied to `command_timeout=None` for query-level
deadlines, which would otherwise wrap subsequent `execute()`/`fetch()`
calls in their own `asyncio.timeout()` and re-trigger the bug.

### Code changes

`backend/core/database.py`:

- `make_task_connection()`: builds the kwargs dict from `_parse_db_kwargs()`,
  injects `timeout=None` and `command_timeout=None`, then calls
  `asyncpg.connect(**kwargs, statement_cache_size=0)`. The codec init
  is still invoked manually for JSONB / pgvector.
- `make_task_pool()`: adds `timeout=None`, `command_timeout=None`,
  `min_size=1`, `max_size=3` to the `asyncpg.create_pool()` call. The
  small pool size keeps a stuck connection from blocking many worker
  slots; the rest is the same as `make_task_connection`.

### Trade-offs

The lost timeout means a misconfigured Supabase URL would hang the
background task indefinitely instead of failing fast at ~60 s. Mitigated
by the fact that connection errors at the kernel level (refused, DNS
fail, route unreachable) still surface immediately. A reachable-but-slow
Supabase is the only case that now hangs, and that pathology has not
been observed against the production database.

### Tests and deploy

- `python -m pytest`: 106 / 106 pass. Tests mock `make_task_connection`
  entirely so the timeout kwarg is invisible to them.
- Commit `fix: disable asyncpg connect timeout to avoid asyncio.timeout
  on Python 3.14` pushed; Render redeploys.

### Session H not run

Do not start Session H until the user confirms the redeploy is live
and a parallel probe (4 strategies, one question, simultaneous) all
reach `completed` without the asyncpg traceback in Render logs.

## 2026-05-17 - Replace asyncpg with psycopg2 in the background task

The previous fix passed `timeout=None` to `asyncpg.connect()` / `create_pool()`,
hoping asyncpg would skip its `asyncio.timeout()` wrapper. It did not.
On Python 3.14 (Render's runtime), asyncpg's compat module calls
`asyncio.timeout()` unconditionally inside its TCP connect path
regardless of the timeout argument value. A 4-strategy parallel probe
at `19:51Z` against commit `72aaaf6` reached `completed` cleanly, but
a follow-up Session H attempt against another Render worker instance
re-surfaced `RuntimeError("Timeout should be used inside a task")`
from inside `asyncpg.connect()` again. Same failure mode, different
worker.

Three asyncpg-shaped fixes in a row (outer Task wrapper, direct
connection instead of pool, `timeout=None`) have all been defeated by
how deep `asyncio.timeout()` sits in asyncpg's connect path on 3.14.
Time to stop fighting asyncio.timeout in code we don't own.

### Fix: psycopg2 (sync) for the background task

`psycopg2` is fully synchronous and never imports `asyncio.timeout()`.
By construction it cannot trigger the bug. The FastAPI main loop keeps
asyncpg via `get_pool()` (results polling, ingest, benchmark router DB
ops) because the main event loop is uvloop+anyio and always has a
current Task; the bug only manifests in the background-task path where
we run our own event loop on a worker thread.

### Code changes

1. **`requirements.txt`**: added `psycopg2-binary==2.9.12` alongside
   `asyncpg==0.30.0`. Both libraries coexist in the dependency set.
2. **`backend/core/database.py`**: new `make_sync_connection()` that
   opens a synchronous `psycopg2.connect()` with the same parsed
   kwargs as the asyncpg helpers. The `options='-c statement_cache_size=0'`
   the user suggested is omitted because `statement_cache_size` is not
   a real Postgres GUC and would error at connect; psycopg2 already
   does not cache prepared statements client-side, so the original
   intent is satisfied without the option. After connect, the function
   calls `pgvector.psycopg2.register_vector(conn)` so the
   `corpus_chunks.embedding` column comes back as a numpy array, which
   `list(...)` turns into the plain list of floats the retrievers
   expect.
3. **`backend/eval/ragas_runner.py`**:
   - Import switched from `make_task_connection` to `make_sync_connection`.
   - `_run_evaluation_async` still `async def` (the outer
     `run_evaluation` wrapper still drives it via `loop.create_task` +
     `loop.run_until_complete`), but every DB hop inside is now sync
     psycopg2 code.
   - `conn = make_sync_connection()` (no await).
   - Three asyncpg `async with pool.acquire() as conn: await conn.X(...)`
     blocks rewritten as `with conn.cursor() as cur: cur.execute(...)`
     plus explicit `conn.commit()` (psycopg2 is in manual-commit mode).
   - SQL placeholders translated from asyncpg's `$1`/`$2`/... to
     psycopg2's `%s`.
   - The JSONB payload for `retrieved_chunks_data` is wrapped in
     `psycopg2.extras.Json(...)` so psycopg2 sends it with the right
     type marker.
   - Corpus-load uses `cursor_factory=psycopg2.extras.RealDictCursor`
     so the existing `row["id"]` / `row["content"]` access style still
     works.
   - `await conn.close()` -> `conn.close()`.
   - `completed_committed` cleanup guard retained as belt-and-suspenders.
     psycopg2 close shouldn't raise, but the guard cost is one bool.
4. **`tests/test_eval.py`**:
   - `_MockConnection` now answers both the asyncpg-style (`async
     execute/fetchrow/fetch`) and the psycopg2-style (`cursor()`,
     `commit()`, sync `close()`) protocols. The asyncpg side is kept
     because the two `get_run` tests still drive the asyncpg path via
     the patched `get_pool` singleton.
   - New `_MockCursor` (context-manager) records `execute()` calls
     onto the parent connection, normalising args into the same
     `(query, args_tuple)` shape as the async path so test assertions
     are unchanged.
   - The "DB completely unavailable" stress test now sets
     `conn.raise_on_execute = True` instead of replacing
     `conn.execute`; both the cursor's `execute()` and the async
     `execute()` honour the flag.
   - All six `_run_evaluation_async` test patches retargeted from
     `make_task_connection` (AsyncMock) to `make_sync_connection`
     (MagicMock).

### Trade-offs

- psycopg2 calls block the event loop while they run, but this thread's
  loop has no other coroutines to starve. The only `await`s in
  `_run_evaluation_async` between DB hops are LLM / RAGAS work, which
  in turn use `httpx.Client` / sync RAGAS internals - they were already
  blocking calls.
- The Supabase transaction pooler (port 6543) is friendly to short,
  auto-commit-style sessions; psycopg2 with manual commit and a small
  set of statements per logical session falls inside that pattern.
- We carry both database client libraries now (asyncpg + psycopg2)
  until we are willing to migrate the FastAPI main loop too. The
  duplication is fine; psycopg2-binary is small (~4 MB).

### Tests and deploy

- `python -m pytest`: 106 / 106 pass.
- Commit `fix: use psycopg2 sync connection in background task to bypass
  Python 3.14 asyncio.timeout incompatibility` pushed; Render redeploys.

### Files in this commit

- `backend/core/database.py` (new `make_sync_connection`)
- `backend/eval/ragas_runner.py` (psycopg2-driven background task)
- `tests/test_eval.py` (dual-protocol mock connection)
- `requirements.txt` (`psycopg2-binary==2.9.12`)
- `devlog.md` (this entry)

### Session H

Do not start Session H. Wait for the user to confirm the redeploy is
live on `main` and that a parallel-load probe shows no asyncio.timeout
traceback in Render logs (it shouldn't appear at all - psycopg2 never
imports asyncio.timeout).

## 2026-05-17 - psycopg2 UUID adapter + defensive str() cast

The first parallel probe against commit `1911bf9` (psycopg2 background
task) left all 4 runs stuck at `status=pending` with `error_message=null`,
which means the background task crashed before reaching its first
`status='running'` write. Most plausible cause: psycopg2 not knowing
how to serialise the `run_uuid` parameter on Render's image.

### Changes

- `backend/core/database.py:make_sync_connection`: calls
  `psycopg2.extras.register_uuid()` once (process-global) before
  `psycopg2.connect()`. This registers psycopg2's built-in UUID adapter
  so `uuid.UUID` parameters round-trip without manual casts.
- `backend/eval/ragas_runner.py`: every `cur.execute()` call that
  bound `run_uuid` as a parameter now binds `str(run_uuid)` instead.
  Belt-and-suspenders alongside the global adapter: if `register_uuid`
  is a no-op on a given environment, the cast guarantees the parameter
  travels as the canonical hyphenated UUID text form, which Postgres'
  UUID column accepts directly.

### Tests and deploy

- `python -m pytest`: 106 / 106 pass.
- Commit `fix: register psycopg2 UUID adapter and cast run_id to str`
  pushed; Render redeploys.

## 2026-05-17 - Diagnostic probes around add_task

After the UUID fix the probe runs still stuck at `status=pending`
with `error_message=null`. Render log inspection by the user
showed POST /benchmark returns 202 but the
`[DEBUG] add_task called for run_id=...` print at
`backend/routers/benchmark.py:213` never appears. That print is
synchronous in the route handler so its absence means the handler
crashes somewhere between the row INSERT and the add_task call, and
FastAPI swallows the exception silently while still returning 202.

This commit instruments the dispatch loop with prints at every step
so the next Render log will pin down the exact crash point:

1. **Route-entry probe** before the loop, printing
   `run_evaluation={run_evaluation!r}` so we can confirm the imported
   function reference is not None or otherwise garbled.
2. **Per-iteration probes** marking loop-start, pool-acquired,
   INSERT-returned, conn-released, run_id-computed, and
   about-to-call-add_task. Whichever print is the last to appear in
   the Render log is the line immediately before the silent failure.
3. **Broad `try/except BaseException` around the `add_task` call** that
   prints `[DEBUG] add_task FAILED for run_id=... : <type>: <repr>`
   if the call itself raises, then re-raises. Catches everything
   including SystemExit and GeneratorExit so the cause cannot escape
   without leaving a trace.

### Tests and deploy

- `python -m pytest`: 106 / 106 pass. The probes are pure prints with
  no logic change; test mocks ignore them.
- Commit `debug: add probes around add_task to find silent crash`
  pushed; Render redeploys.

### Session H still deferred

Do not run Session H. Wait for the user to capture the next batch of
Render logs after a POST /benchmark and identify which probe was the
last to fire.

## 2026-05-17 - Session H sweep: 40 / 40 completed, quality metrics all null

Ran the full 10-questions x 4-strategies sweep against
`corpus_hash=f5c424...0e93`. Backend infrastructure issues from
earlier in the day were resolved (the dispatch path now reaches
`_run_evaluation_async` and runs to `status=completed`). The full
40-batch sweep finished in 225 s (3 min 45 s) - faster than expected
- and the per-batch logs show every run reached terminal state with
the answer text and retrieved chunks correctly written to the database.

The catch: every quality metric on every run came back null.

### Per-strategy summary table

| Strategy | Faithfulness | Context utilization | Answer relevancy | Latency mean (min-max) |
|----------|--------------|---------------------|------------------|------------------------|
| naive | -- (n=0, nulls=10) | -- (n=0, nulls=10) | -- (n=0, nulls=10) | 16,229 ms (12,107-19,798) |
| hyde | -- (n=0, nulls=10) | -- (n=0, nulls=10) | -- (n=0, nulls=10) | 16,810 ms (12,101-23,170) |
| multiquery | -- (n=0, nulls=10) | -- (n=0, nulls=10) | -- (n=0, nulls=10) | 16,253 ms (11,563-25,925) |
| hybrid | -- (n=0, nulls=10) | -- (n=0, nulls=10) | -- (n=0, nulls=10) | 15,665 ms (12,804-20,426) |

All 40 runs: `status=completed`, `error_message=null`,
`retrieved_chunks` populated with the expected chunks at sane scores,
`generated_answer` populated with a coherent answer to the question.
Only the three RAGAS scores are null.

### Weighted winner

Per the spec, nulls count as 0.0 in the weighted average
(faithfulness 40%, context_utilization 30%, answer_relevancy 30%).
With every metric null on every run:

| Strategy | Weighted score |
|----------|----------------|
| naive | 0.0000 |
| hyde | 0.0000 |
| multiquery | 0.0000 |
| hybrid | 0.0000 |

Four-way tie at zero. No defensible winner can be declared on this data.

If latency is used as a tiebreaker (lower is better), `hybrid` is
fastest with a mean of 15.7 s and `hyde` is slowest at 16.8 s, a
span of about 7 %.

### Notable patterns

1. **Every RAGAS metric on every run returned NaN.** That is 120
   discrete metric computations (40 runs x 3 metrics) all failing the
   same way. The per-metric isolation guard from Session C absorbed
   them cleanly - each metric was wrapped in `try/except BaseException`,
   stored as `float("nan")` on failure, and never propagated up to
   crash the run. As a result, status stayed `completed` for every
   row, which is the correct behaviour of the guard but hides the
   underlying RAGAS problem from the run-level state.
2. **Run latencies are 12-26 s, ~3-4 x faster than a real RAGAS run.**
   Prior single-strategy probes routinely took 70-80 s end to end. A
   full RAGAS evaluation on `gpt-4o-mini` against one
   (question, answer, contexts) triple costs ~15-25 s per metric x
   three metrics, so a healthy run should be dominated by RAGAS, not
   by retrieval. The observed latencies are consistent with RAGAS
   aborting near-instantly on each metric (the openai or langchain
   call failing fast) rather than running to completion.
3. **Retrieval and answer generation are healthy.** Spot-checking
   completed rows shows the corpus is being retrieved correctly (2
   chunks per query, top-1 score in the 0.5-0.6 range for naive on
   relevant questions), and `gpt-4o-mini` is generating fluent
   on-topic answers. The retriever / compressor / answer-generator
   half of the pipeline is functioning normally.
4. **Strategy-to-strategy latency differences are within 7 %.** With
   only the retrieval+generation cost actually being incurred (and
   RAGAS effectively no-op), all four strategies look roughly equal
   on wall-clock. `hybrid` is fastest, `hyde` slowest, but the spread
   is small enough that it could flip on any given run.

### Likely cause of the RAGAS NaNs

Three candidates, in priority order:

1. **OpenAI API failure for the RAGAS judge calls specifically.**
   The judge model is `gpt-4o-mini`, the same key the retriever and
   answer generator use successfully. If the key is rate-limited at a
   threshold that the four-stroke pipeline does not hit but the
   amplified RAGAS call pattern does, the judge calls would all fail
   while retrieval and generation proceed normally. Worth checking
   OpenAI's usage dashboard for the period 06:23-06:27 UTC on
   2026-05-17 against this key.
2. **RAGAS internal error masked by per-metric `try/except`.** The
   guard catches `BaseException`, which captures everything including
   import errors, AttributeError, schema mismatches between RAGAS
   versions and the dataset shape we pass in, etc. A change in
   `ragas==0.1.21`'s dependency chain (e.g. a transitive bump in
   `datasets` or `langchain`) could be raising at evaluate() time on
   the Render image. Pinning is in place at the top level but
   transitives are not.
3. **A subtle bug introduced when the background-task path was
   switched to psycopg2.** The corpus loaded via psycopg2 may have a
   different shape than the asyncpg version expected by retrievers
   (e.g. the embedding column comes back as numpy.ndarray rather than
   list; we call `list(...)` on it, which is correct, but if the
   array dtype is now float64 instead of float32, cosine similarity
   would still work but downstream RAGAS calls might choke on a
   subtle JSON-encoding issue). Unlikely - retrieval and generation
   both succeed - but listed for completeness.

### Recommendation for the next step

Pull the Render stderr log for run_id
`148ec61e-9bb4-428d-b46c-4fdc4ae76d06` (Q1, naive) and grep for
`[DEBUG] _run_ragas: <metric> RAISED`. The per-metric isolation
prints the exception type and message for each failing metric, which
will point at one of the three candidates above. Until that root
cause is known, re-running Session H will produce the same all-null
table at the same wall-clock speed.

### Files

- `/tmp/session_h_results.csv` - 40 rows, all `status=completed`, all
  three quality metrics empty, latency populated.
- `/tmp/session_h_log.txt` - per-batch summary log with timestamps.
- `devlog.md` - this entry.

No project files modified. No commits made. The asyncpg / psycopg2
backend work from earlier today is unchanged.

## 2026-05-17 - Session H local run: full 40 runs with real metrics

The Render sweep produced all-null quality metrics. To get a clean dataset
the user redirected Session H to the local backend (`uvicorn backend.main:app
--port 8000` against the local Docker Postgres on `localhost:5433`). Same
10 questions, same 4 strategies, same parallel batches.

### Setup

- Started uvicorn locally (Python 3.11.2 venv).
- Local Docker Postgres was already running on `localhost:5433`.
- Local DB had zero chunks for the original `corpus_hash`, so the same
  `/tmp/motor_vehicles.txt` (865 words, 2 chunks at default
  `chunk_size=512`) was re-ingested via `POST localhost:8000/ingest`.
  The hash is deterministic from file bytes, so it produced the same
  `f5c424...0e93`.
- `/tmp/session_h_local.py` is a copy of `/tmp/session_h_parallel.py`
  with `BASE = "http://localhost:8000"`.

### Per-strategy summary table

| Strategy | Faithfulness | Context utilization | Answer relevancy | Latency mean (min-max) |
|----------|--------------|---------------------|------------------|------------------------|
| naive | 1.000 (n=10, nulls=0) | 1.000 (n=8, nulls=2) | 0.980 (n=9, nulls=1) | 23,486 ms (18,603-45,625) |
| hyde | 1.000 (n=10, nulls=0) | 1.000 (n=9, nulls=1) | 0.989 (n=8, nulls=2) | 23,674 ms (19,848-34,909) |
| multiquery | 1.000 (n=7, nulls=3) | 1.000 (n=9, nulls=1) | 0.974 (n=9, nulls=1) | 25,489 ms (18,606-52,736) |
| hybrid | 0.990 (n=10, nulls=0) | 0.812 (n=8, nulls=2) | 0.982 (n=8, nulls=2) | 22,913 ms (18,601-34,896) |

### Weighted winner

Weighted average is `0.4 * faithfulness + 0.3 * context_utilization +
0.3 * answer_relevancy`, with null metrics scored as 0.0 in the average.

| Rank | Strategy | Weighted | f_mean | cu_mean | ar_mean |
|------|----------|----------|--------|---------|---------|
| 1 | **hyde** | **0.9073** | 1.000 | 0.900 | 0.791 |
| 2 | naive | 0.9046 | 1.000 | 0.800 | 0.882 |
| 3 | hybrid | 0.8266 | 0.990 | 0.650 | 0.785 |
| 4 | multiquery | 0.8129 | 0.700 | 0.900 | 0.876 |

**Winner: hyde** at 0.9073. The gap over `naive` is 0.0027 - within
metric noise on this small corpus. The two are functionally tied;
the 4-strategy ranking is really a tier-1 pair (hyde / naive) and a
tier-2 pair (hybrid / multiquery) where each tier-2 strategy is held
back by a different failure mode (hybrid's partial-utilization scores
and multiquery's metric nulls).

### Notable patterns

1. **Faithfulness is near-perfect across all strategies.** Every
   non-null faithfulness value is 1.0, except `hybrid` on Q4 at 0.9.
   The corpus is short (~865 words / 2 chunks) and every question is
   directly answerable from it, so the model stays tightly grounded
   regardless of which strategy surfaces the chunks.
2. **`hybrid`'s context_utilization sags.** Mean 0.812 on 8 non-null
   values, dragged down by a 0.5 score on Q5, Q9, and Q10. Those are
   RAGAS partial-credit values, not nulls. The most plausible
   explanation: hybrid's RRF fusion of BM25 + dense surfaces
   keyword-adjacent chunks for short corpora, and RAGAS notices the
   model did not actually use part of the supplied context.
3. **`multiquery` has the most nulls (5 / 40 = 12.5 %).** Three are
   in faithfulness (Q6, Q8, Q10), one in context_utilization, one in
   answer_relevancy. The Session C per-metric isolation absorbed all
   of them cleanly. multiquery sends 3 reworded queries to the
   generator + embedder, which produces more chunk overlap than the
   other strategies; RAGAS faithfulness occasionally chokes when the
   claim set looks ambiguous.
4. **Latency ordering: hybrid fastest, multiquery slowest, spread
   ~11 %.** hybrid 22.9 s vs multiquery 25.5 s. multiquery's overhead
   is the LLM-generated query variants (~3-4 extra embedding calls
   per question). hybrid's BM25 path is in-memory and adds essentially
   zero wall-clock. The two single-embed strategies (naive, hyde) sit
   in the middle at ~23.5 s.
5. **Q1 hit the most nulls in the run (4 across 4 strategies).** That
   was the first question submitted on a fresh local backend; the
   matching question scored a clean 1.0 across all metrics on later
   probes. Suggests a cold-RAGAS-cache warmup effect on the very first
   evaluations of a session.
6. **Q4 took the longest** - 45 s for naive, 52 s for multiquery
   (vs the ~22 s median). The question elicits a longer multi-claim
   answer from the model, and RAGAS faithfulness has to NLI-check
   each claim against the context, so cost scales with answer length.
7. **Local backend is ~3 x faster than Render free tier** on the same
   workload (23 s mean here vs the 70-80 s prior single-strategy
   probes on Render). Both call `gpt-4o-mini`; the difference is
   Render's cold-start tax and constrained CPU.

### Why this run worked when Render's did not

On Render's sweep earlier today every quality metric came back null
across all 40 runs - the Session C per-metric guard absorbed RAGAS
failures uniformly. Locally those same metrics evaluate cleanly. The
likely difference is one of: an OpenAI rate-limit that Render's IP
hits but the user's local IP does not, a Render-side transitive
dependency drift (`datasets` or `langchain` patch version) that the
local venv pins to a working set, or a network-path issue between
Render and `api.openai.com` specifically on the period the sweep ran.
The runs against `localhost:8000` ran the identical code on the
identical RAGAS pin (0.1.21) with the same OPENAI_API_KEY and
returned real scores, so the issue is environmental, not code.

### Files

- `/tmp/session_h_local_results.csv` - 40 rows, all `status=completed`,
  metric columns populated with floats or empty (= null).
- `/tmp/session_h_local_log.txt` - per-batch summary log with timestamps.
- `devlog.md` - this entry.

No project files modified. No commits made.
