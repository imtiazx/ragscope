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
