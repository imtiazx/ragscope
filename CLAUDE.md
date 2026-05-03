# RAGScope — CLAUDE.md

Read this file completely before touching any file in this repo.

---

## What this project is

A public RAG benchmarking harness. Not a RAG app. The point is measurement.
Users paste a document corpus, run it through 5 retrieval strategies, and see
exactly which strategy wins on faithfulness, latency, and context precision.

This is NOT an agentic system. It is a deterministic evaluation pipeline.

---

## Stack

- Backend: FastAPI, Python 3.11, uvicorn
- Vector store: pgvector via Supabase (prod) / Docker Postgres + pgvector (local)
- Postgres client: asyncpg (async, matches FastAPI async context)
- Sparse index: rank-bm25, pure Python, no Elasticsearch
- Embeddings: text-embedding-3-small (OpenAI)
- Eval framework: ragas, pinned to 0.1.x
- LLM judge for RAGAS: gpt-4o-mini via OPENAI_API_KEY
- Outbound HTTP: httpx (async, used in all LLM provider classes)
- Tracing: LangSmith via langsmith package only (no langchain-core dependency)
- Frontend: Next.js 14, Tailwind CSS, recharts, framer-motion, shadcn/ui
- Deployment: Render (backend), Vercel (frontend), Supabase (DB)

---

## Hard rules

- No em-dashes, no emojis anywhere in code or UI copy
- No hardcoded API keys -- all secrets from .env or browser localStorage
- BYOK keys never leave the browser -- Tier 2 LLM calls go direct from frontend
- All RAGAS eval runs are async background tasks, never blocking a request thread
- Measure latency with time.perf_counter(), not time.time()
- Every new ingestor, chunker, retriever, or LLM provider must extend its base
  class and use @register -- never hardcode strategy lists anywhere
- Run `python -m pytest` before considering any backend task complete
- Run `npm run build` before considering any frontend task complete
- Every file must have a module-level docstring explaining what it does and why
  it exists. Every class must have a docstring. Every method must have a
  docstring explaining parameters, return value, and any non-obvious behavior.
  Comments inside method bodies for any logic that is not immediately obvious
  to a Python beginner.

---

## Access tiers

Tier 0 dev (ImtiazX only):
- URL param ?dev=<DEV_TOKEN_HASH> writes a hashed value to sessionStorage
- Frontend sends X-Dev-Token header on every request
- Backend validates against DEV_TOKEN env var
- Bypasses all rate limits
- The raw token value is never in the JS bundle
- Users who want Tier 0 access are directed to contact ImtiazX via LinkedIn

Tier 1 guest (default):
- 3 benchmark runs per day
- 3 chat questions per benchmark run (9 total per day)
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

There are two architectural categories. This distinction matters.

Retrieval methods (how chunks are found):
1. Naive RAG -- direct cosine similarity on query embedding (baseline)
2. HyDE -- LLM generates a hypothetical answer, embed that instead of the query
   (hypothesis-driven)
3. Multi-query -- LLM generates 3 to 5 query variants, merge and rerank results
   (multi-perspective)
4. Hybrid BM25 + dense -- sparse and dense search in parallel, fused with RRF
   (hybrid)

Post-retrieval processor (what happens after chunks are found):
5. Contextual compression -- LLM compresses each chunk to only query-relevant
   sentences

Strategy 5 can be combined with any of strategies 1 to 4.
The benchmark UI must reflect this two-dimension structure.

---

## Chunker strategies

All chunkers expose a param_schema class attribute describing every configurable
parameter with name, type, default, min, max, and description. The frontend
builds configuration forms dynamically from this schema.

1. Fixed size -- split by token count with overlap
   params: chunk_size (default 512), overlap (default 50)

2. Semantic -- split at embedding similarity boundaries
   params: similarity_threshold (default 0.5), min_chunk_size (default 100)

3. Hierarchical -- parent and child chunk levels
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
  context_precision    float
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

---

## API surface

POST /ingest
  -- accepts multiple files as multipart upload
  -- enforces 10MB combined size limit, returns HTTP 413 if exceeded
  -- enforces file size at two levels: FastAPI request limit and application check
  -- computes sha256 corpus_hash of combined file bytes
  -- returns corpus_hash and chunk count

POST /benchmark
  -- accepts corpus_hash, question, strategies, params, compression settings
  -- creates benchmark_runs row with status pending
  -- fires run_evaluation() as FastAPI BackgroundTask
  -- returns run_id with HTTP 202
  -- enforces guest tier run limit via check_rate_limit dependency

POST /chat
  -- accepts corpus_hash, question, retrieval_strategy, retrieval_params,
     compression_enabled, compression_params
  -- enforces guest tier chat limit (3 per run, tracked by fingerprint + date)
  -- runs retrieval and returns answer without storing as a benchmark run
  -- returns answer, retrieved_chunks, strategy_used

GET /results/{run_id}
  -- returns current run state including status
  -- frontend polls this until status is completed or failed

GET /strategies
  -- returns full registry of retrievers and chunkers with param_schemas
  -- frontend uses this to build configuration forms dynamically

GET /health
  -- returns status ok and current timestamp

---

## Frontend architecture

Pages:
  / (landing page) -- cinematic home, Enter App CTA
  /app             -- full benchmark flow, single page four-step layout
  /docs            -- documentation, plain English explanations, links

Step flow in /app:
  Step 1 -- Upload files + configure chunker
  Step 2 -- Configure retrieval strategy + run benchmark
  Step 3 -- Results, visualizations, comparison across runs
  Step 4 -- Chat with corpus using winning or user-selected strategy

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

Results visualizations (recharts, all interactive):
  - Radar chart: three axes (faithfulness, context precision, answer relevancy),
    one polygon per run, hover highlights and shows tooltip, click selects run
  - Latency bar chart: sorted fastest to slowest, hover shows exact ms and
    plain English label, bars animate in on load
  - Comparison table: sortable by column, color coded best/worst per metric,
    column header tooltips explain each metric, row click selects run
  - Score cards: count-up animation on load, plain English interpretation
    below each score, sparkline if multiple runs exist
  - Winner badge: highest weighted average strategy, glow pulse animation,
    one-line plain English explanation of why it won

Chat interface:
  - Default config is winning strategy from benchmark
  - Collapsible config panel to switch strategy
  - Guest users see remaining question counter (3 per run)
  - Counter decrements with each message
  - Input disabled with upgrade prompt when limit reached
  - Each assistant message shows strategy used and chunks retrieved as metadata

Run history:
  - Stored in localStorage under key ragscope_run_history
  - Comparison charts accumulate across runs in same session
  - Clear History button resets charts and localStorage history

---

## Directory structure

ragscope/
  CLAUDE.md
  docker-compose.yml
  requirements.txt
  .env.example
  .gitignore
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
SUPABASE_URL=               # postgres connection string
SUPABASE_KEY=               # service role key
LANGCHAIN_API_KEY=          # LangSmith tracing
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=ragscope
DEV_TOKEN=                  # your private dev bypass token (never commit)
MAX_FILE_SIZE_BYTES=10485760  # 10MB combined limit across all uploaded files