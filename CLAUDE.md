# RAGScope - CLAUDE.md

Read this file completely before touching any file in this repo.

---

## What this project is

A public RAG benchmarking harness. Not a RAG app. The point is measurement.
Users paste a document corpus, run it through 4 retrieval strategies, and see
exactly which strategy wins on faithfulness, latency, and context utilization.

This is NOT an agentic system. It is a deterministic evaluation pipeline.

---

## Stack

- Backend: FastAPI, Python 3.11, uvicorn
- Vector store: pgvector via Supabase (prod) / Docker Postgres + pgvector (local)
- Postgres client: asyncpg (async, matches FastAPI async context)
- Sparse index: rank-bm25, pure Python, no Elasticsearch
- Embeddings: text-embedding-3-small (OpenAI)
- Eval framework: ragas, pinned to 0.1.21
- LLM judge for RAGAS: gpt-4o-mini via OPENAI_API_KEY
- Outbound HTTP: httpx (async, used in all LLM provider classes)
- Tracing: LangSmith via langsmith package only (no langchain-core dependency)
- Frontend: Next.js 14, Tailwind CSS, recharts, framer-motion, shadcn/ui
- Deployment: Railway (backend, primary host), Vercel (frontend), Supabase (DB).
  Required deploy files at repo root: Dockerfile, railway.toml.

---

## Hard rules

- No em-dashes anywhere in code or UI copy. Use "-" or ":" instead.
- No emojis anywhere in code or UI copy
- No hardcoded API keys - all secrets from .env or browser localStorage
- BYOK keys never leave the browser - Tier 2 LLM calls go direct from frontend
- All RAGAS eval runs are async background tasks, never blocking a request thread
- Background task must always resolve benchmark_runs row to completed or failed - never leave it in pending or running permanently
- Measure latency with time.perf_counter(), not time.time()
- Every new ingestor, chunker, retriever, or LLM provider must extend its base
  class and use @register - never hardcode strategy lists anywhere
- Run `python -m pytest` before considering any backend task complete
- Run `npm run build` before considering any frontend task complete
- Every file must have a module-level docstring explaining what it does and why
  it exists. Every class must have a docstring. Every method must have a
  docstring explaining parameters, return value, and any non-obvious behavior.
  Comments inside method bodies for any logic that is not immediately obvious
  to a Python beginner.
- Background thread event loop: always use loop = asyncio.DefaultEventLoopPolicy().new_event_loop(), then loop.run_until_complete(...), then loop.close() in a finally block. Never use anyio.run() inside a FastAPI background task thread. Never call nest_asyncio.apply() against a uvloop instance.
- DB access in background task (_run_evaluation_async) must use make_sync_connection()
  (psycopg2 synchronous). Never use asyncpg pool or connection inside the background
  task. asyncpg breaks on Python 3.14 due to asyncio.timeout() in its connect path.
- RAGAS metrics must be evaluated one at a time using per-metric isolation:
  three sequential ragas_evaluate(dataset, metrics=[one_metric]) calls, each
  wrapped in try/except BaseException. Never evaluate all metrics in a single
  evaluate() call. This pattern is required for graceful NaN handling.

---

## Access tiers

Tier 0 dev (ImtiazX only):
- URL param ?dev=imtiazx writes raw token to sessionStorage
- Frontend sends X-Dev-Token header on every request
- Backend hashes received token and compares to sha256(DEV_TOKEN)
- Bypasses all rate limits - unlimited benchmark runs and chat questions
- Frontend must display "Dev mode - unlimited" instead of any usage counter
- Users who want Tier 0 access are directed to contact ImtiazX via LinkedIn

Tier 1 guest (default):
- 12 strategy benchmark runs per day (selecting all 4 strategies counts as 4 runs)
- Enabling or disabling contextual compression does not count as an additional run
- 5 live chat questions per day across all strategies combined
- Rate limited by browser fingerprint + IP combo
- Uses OPENAI_API_KEY from env var (gpt-4o-mini)
- Multiple files supported per upload, treated as one combined corpus
- Max combined upload size 10MB per corpus

Tier 2 BYOK:
- Unlimited benchmark runs
- Unlimited chat questions
- User pastes their own OpenAI or Anthropic key in the settings panel
- Key stored in browser localStorage only, never sent to the backend
- Frontend calls the LLM provider directly for retrieval and eval
- Full corpus size, LangSmith trace export enabled

---

## Retrieval strategies

There are two architectural categories. This distinction matters for architecture,
for the UI, and for any interview or explanation.

Retrieval methods (how chunks are found) - 4 strategies:
1. Naive RAG - direct cosine similarity on query embedding (baseline)
2. HyDE - LLM generates a hypothetical answer, embed that instead of the query
   (hypothesis-driven)
3. Multi-query - LLM generates 3 to 5 query variants, merge and rerank results
   (multi-perspective)
4. Hybrid BM25 + dense - sparse and dense search in parallel, fused with RRF
   (hybrid)

Post-retrieval processor (applied after any retrieval method):
5. Contextual compression - LLM compresses each chunk to only query-relevant
   sentences. This is NOT a retrieval method. It is not in the retrieval registry.
   It can be toggled on top of any of the 4 strategies above.
   Enabling or disabling it does not consume an additional benchmark run.

The benchmark UI must reflect this two-dimension structure: a grid or matrix
where rows are the 4 retrieval methods and the compression toggle is a separate
orthogonal control.

---

## Multi-strategy benchmark flow

A user may select multiple retrieval strategies in a single benchmark submission.
Selecting N strategies counts as N runs against the guest tier daily limit.
The backend processes each strategy sequentially as separate background tasks,
one run_id per strategy. The frontend receives all run_ids at once and polls
each independently, streaming live progress per strategy so the user sees
results appearing strategy by strategy rather than waiting for all to finish.
This means a guest selecting all 4 strategies uses 4 of their 12 daily runs.

---

## Chunker strategies

All chunkers expose a param_schema class attribute describing every configurable
parameter with name, type, default, min, max, and description. The frontend
builds configuration forms dynamically from this schema.

1. Fixed size - split by token count with overlap
   params: chunk_size (default 512), overlap (default 50)

2. Semantic - split at embedding similarity boundaries
   params: similarity_threshold (default 0.5), min_chunk_size (default 100)

3. Hierarchical - parent and child chunk levels
   params: parent_chunk_size (default 1024), child_chunk_size (default 256)

---

## Retrieval param schemas

All retrievers expose a param_schema class attribute. All strategies expose
top_k (default 5, min 1, max 20). Additional per-strategy params:

Naive RAG: top_k only
HyDE: top_k, hypothetical_doc_length (enum: short/medium/long, default medium)
Multi-query: top_k, num_variants (default 3, min 2, max 5)
Hybrid: top_k, bm25_weight (default 0.5, min 0.0, max 1.0),
        rrf_k (default 60, min 1, max 100)
Contextual compression: min_relevance_length (default 50, min 20, max 500)

---

## Modular extension pattern

To add a new retrieval strategy:
1. Create backend/retrieval/your_strategy.py
2. Define a class that extends BaseRetriever
3. Set class attributes: name, display_name, description, param_schema
4. Implement the async retrieve() method
5. Decorate the class with @register

The API and frontend auto-discover it. No other files need to change.

Same pattern applies to: ingest/, chunkers/, llm/

---

## Database schema

Three tables. All created on startup via create_tables() in database.py.

benchmark_runs:
  id                   UUID primary key, generated by default
  created_at           timestamptz, default now()
  status               text, constrained to: pending/running/completed/failed
  retrieval_strategy   text not null
  chunker_strategy     text not null
  retrieval_params     jsonb not null default '{}'
  chunker_params       jsonb not null default '{}'
  compression_enabled  boolean not null default false
  compression_params   jsonb not null default '{}'
  corpus_hash          text not null
  question             text not null
  retrieved_chunks     jsonb not null default '[]'
  generated_answer     text
  faithfulness         float
  context_utilization  float
  answer_relevancy     float
  latency_ms           float
  error_message        text

corpus_chunks:
  id            UUID primary key, generated by default
  corpus_hash   text not null
  chunk_index   integer not null
  content       text not null
  embedding     vector(1536)

rate_limit_counters:
  fingerprint_hash   text not null
  date               date not null, default current_date
  run_count          integer not null default 0
  chat_count         integer not null default 0
  primary key (fingerprint_hash, date)

Note: run_count tracks strategy-level runs (max 12/day for guest).
chat_count tracks live chat questions (max 5/day for guest).
Compression toggle does not increment either counter.

---

## API surface

POST /ingest
  - accepts multiple files as multipart upload
  - enforces 10MB combined size limit, returns HTTP 413 if exceeded
  - enforces file size at two levels: FastAPI request limit and application check
  - computes sha256 corpus_hash of combined file bytes
  - returns corpus_hash and chunk count

POST /benchmark
  - accepts corpus_hash, question, list of strategies, params, compression settings
  - creates one benchmark_runs row per strategy, all with status pending
  - fires one run_evaluation() BackgroundTask per strategy
  - returns list of run_ids with HTTP 202
  - enforces guest tier run limit: checks that len(strategies) does not exceed
    remaining daily runs before creating any rows
  - Tier 0 dev token bypasses limit entirely

POST /chat
  - accepts corpus_hash, question, retrieval_strategy, retrieval_params,
    compression_enabled, compression_params
  - enforces guest tier chat limit (5 per day total, tracked by fingerprint + date)
  - runs retrieval and returns answer without storing as a benchmark run
  - returns answer, retrieved_chunks, strategy_used
  - Tier 0 dev token bypasses limit entirely

GET /results/{run_id}
  - returns current run state including status
  - frontend polls this until status is completed or failed

GET /strategies
  - returns full registry of retrievers and chunkers with param_schemas
  - frontend uses this to build configuration forms dynamically

GET /health
  - returns status ok and current timestamp

---

## Frontend architecture

Pages:
  / (landing page) - cinematic home, Enter App CTA
  /app             - full benchmark flow, single page four-step layout
  /docs            - documentation, plain English explanations, links

Step flow in /app:
  Step 1 - Upload files + configure chunker
  Step 2 - Configure retrieval strategies (multi-select) + run benchmark
  Step 3 - Results, visualizations, streaming per strategy as each completes
  Step 4 - Live chat with corpus using selected strategy

On first entry to /app a tier information modal is shown explaining all three
tiers. User can dismiss it and check "do not show again" (stored in localStorage).

Global UI features:
  - Dark / light / system theme toggle, persisted in localStorage
  - Ambient audio (Nils Frahm style, royalty-free), off by default,
    persisted in localStorage
  - Soft click sound effects on all interactive elements
  - BYOK settings drawer, slide-in from right
  - Toast notification system for all async events
  - Skeleton loading states for all API calls
  - Tooltips on all parameter controls explaining in plain English
  - Browser tab favicon: letter R inside a circle (SVG, teal on transparent)

Homepage (landing page):
  - Snowflake particle background effect, subtle and non-distracting
  - Guest limit clearly stated as 12 strategy runs per day, no account required
  - No shooting stars or streaking particle effects

Results visualizations (recharts, all interactive):
  - Radar chart: three axes (faithfulness, context utilization, answer relevancy),
    one polygon per run, hover highlights and shows tooltip, click selects run
  - Latency bar chart: sorted fastest to slowest, hover shows exact ms and
    plain English label, bars animate in on load
  - Comparison table: sortable by column, color coded best/worst per metric,
    column header tooltips explain each metric, row click selects run
  - Score cards: count-up animation on load, plain English interpretation
    below each score, sparkline if multiple runs exist
  - Winner badge: highest weighted average strategy, glow pulse animation,
    one-line plain English explanation of why it won
  - Results stream in per strategy as each background task completes rather
    than waiting for all strategies to finish

Chat interface (Step 4 - live chat, not full scale chatbot):
  - Default config is winning strategy from benchmark
  - Collapsible config panel to switch strategy
  - Guest users see remaining question counter (5 per day total)
  - Counter decrements with each message
  - Input disabled with upgrade prompt when daily limit reached
  - Each assistant message shows strategy used and chunks retrieved as metadata
  - Tier 0 dev displays "unlimited" instead of a counter

Run history:
  - Stored in localStorage under key ragscope_run_history
  - Comparison charts accumulate across runs in same session
  - Clear History button resets charts and localStorage history

Docs page structure:
  - How it works: Phase 1 (ingest diagram + description), then Phase 2
    (benchmark diagram + description), then Phase 3 (live chat description)
  - Understanding metrics: plain English explanation plus mathematical formula
    with each term defined for faithfulness, context utilization, answer relevancy
  - Retrieval strategies: 4 retrieval methods listed, contextual compression
    described separately as a post-retrieval processor combinable with any method
  - FAQ section updated to reflect 12 run limit and 5 chat limit
  - No em-dashes anywhere in docs copy

---

## Background task event loop pattern (critical)

This is the only approved pattern for running async eval in a sync background thread.
Do not deviate from this pattern. Previous attempts with anyio.run() and
nest_asyncio caused uvloop conflicts on Render.

```python
def run_evaluation(...) -> None:
    print(f"[DEBUG] run_evaluation entered run_id={run_id}", flush=True)
    import asyncio
    policy = asyncio.DefaultEventLoopPolicy()
    loop = policy.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_run_evaluation_async(...))
    except BaseException as exc:
        print(f"[DEBUG] run_evaluation CRASHED: {exc}", flush=True)
        logger.exception("run_evaluation failed for run_id=%s", run_id)
    finally:
        loop.close()
```

Inside _run_evaluation_async, conn = None must be initialised before the try block.
conn = make_sync_connection() (synchronous psycopg2, no await) must be the
first statement inside the try block. Do NOT use make_task_pool() or
make_task_connection() inside _run_evaluation_async. Those use asyncpg which
calls asyncio.timeout() internally and breaks on Python 3.14 under parallel load.
The except BaseException block must update benchmark_runs status to failed and
write the exception message to error_message before attempting conn close.

---

## Directory structure

ragscope/
  CLAUDE.md
  Dockerfile
  railway.toml
  docker-compose.yml
  requirements.txt
  .env.example
  .gitignore
  docs/
    DEPLOYMENT_BLOCKER_REPORT.pdf
  backend/
    __init__.py
    main.py
    core/
      __init__.py
      config.py
      rate_limiter.py
      auth.py
      database.py
    ingest/
      __init__.py
      base.py
      pdf.py
      txt.py
      registry.py
    chunkers/
      __init__.py
      base.py
      fixed_size.py
      semantic.py
      hierarchical.py
      registry.py
    retrieval/
      __init__.py
      base.py
      naive.py
      hyde.py
      multiquery.py
      hybrid.py
      contextual_compression.py
      registry.py
    llm/
      __init__.py
      base.py
      openai_provider.py
      anthropic_provider.py
      registry.py
    eval/
      __init__.py
      ragas_runner.py
    routers/
      __init__.py
      ingest.py
      benchmark.py
      results.py
      chat.py
  frontend/
    app/
      layout.tsx
      page.tsx
      app/
        page.tsx
      docs/
        page.tsx
    components/
    lib/
      llm-client.ts
  tests/
    __init__.py
    test_retrieval.py
    test_eval.py
    test_ingest.py
    test_chat.py

---

## Local dev setup

cp .env.example .env
docker-compose up -d
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000
cd frontend && npm install && npm run dev

---

## Environment variables

OPENAI_API_KEY=             # guest tier retrieval + RAGAS judge (gpt-4o-mini)
SUPABASE_URL=               # postgres transaction pooler connection string (port 6543)
SUPABASE_KEY=               # service role key
LANGCHAIN_API_KEY=          # LangSmith tracing
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=ragscope
DEV_TOKEN=imtiazx           # dev bypass token - never commit the actual value
MAX_FILE_SIZE_BYTES=10485760  # 10MB combined limit across all uploaded files