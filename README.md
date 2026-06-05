# RAGScope

A public benchmarking harness for Retrieval-Augmented Generation. Not a RAG
application: the point is measurement. You paste a document corpus, the
backend runs it through four retrieval strategies in parallel, and the UI
shows exactly which strategy wins on **faithfulness**, **context
utilization**, **answer relevancy**, and **latency** for your specific data.

> Live app: [ragscope.vercel.app](https://ragscope.vercel.app)
> Backend API: [ragscope-backend-production.up.railway.app](https://ragscope-backend-production.up.railway.app)
> API reference (FastAPI auto-generated): [/docs](https://ragscope-backend-production.up.railway.app/docs)

---

## Why this exists

Most RAG tutorials wave hands about which retrieval strategy to use. RAGScope
makes the decision empirical. Upload the documents you actually care about,
ask the questions you actually care about, and read the scores. No more
guessing whether HyDE helps your corpus or whether hybrid search is worth
the extra moving parts.

## What it does

1. **Ingests** PDFs and text files (up to 10 MB combined) and chunks them
   with a configurable strategy.
2. **Embeds** each chunk with OpenAI `text-embedding-3-small` (1536 dims)
   and stores them in Postgres + pgvector.
3. **Benchmarks** any subset of four retrieval strategies in parallel
   against the same question and corpus.
4. **Scores** each run with [RAGAS](https://docs.ragas.io/) (judged by
   `gpt-4o-mini`) and persists faithfulness, context utilization, answer
   relevancy, and end-to-end latency.
5. **Visualises** results with radar charts, latency bars, sortable
   comparison tables, score cards, and a "winner" badge.
6. **Lets you chat** with the corpus using whichever strategy won the
   benchmark, so the scores translate into a felt experience.

## Retrieval strategies

Four retrieval methods are benchmarked head-to-head. A fifth control,
**contextual compression**, is an orthogonal *post-retrieval processor*
that can be toggled on top of any of the four methods.

| # | Name | What it does | When it wins |
|---|------|--------------|--------------|
| 1 | **Naive RAG** | Embed the query, return top-k chunks by cosine similarity. | The baseline. Fast and good when query wording matches doc wording. |
| 2 | **HyDE** (Hypothetical Document Embeddings) | LLM writes a plausible answer to the question, embed *that*, retrieve against it. | Query and documents use different vocabulary (e.g. lay question, technical corpus). |
| 3 | **Multi-query** | LLM rewords the question 3-5 ways, retrieves for each in parallel, merges by best score. | A single phrasing risks missing a relevant passage. |
| 4 | **Hybrid BM25 + dense** | Run sparse BM25 keyword search and dense cosine in parallel, fuse the rankings with Reciprocal Rank Fusion. | Exact identifiers, names, or rare terms that pure dense search smooths over. |

**Contextual compression** is *not* a fifth strategy. It is a post-retrieval
LLM filter that distils each chunk down to only the sentences relevant to
the question. It is combinable with any of the four methods above. Enabling
or disabling it does **not** consume an additional daily run.

## Evaluation metrics

Every benchmark run is scored by RAGAS using `gpt-4o-mini` as the judge.
Three reference-free metrics are persisted; the project deliberately does
not collect ground-truth answers, so context-precision (which needs a
reference) is replaced by `context_utilization`.

- **Faithfulness** -- the share of claims in the generated answer that are
  supported by the retrieved chunks. `1.0` means no hallucination.
- **Context utilization** -- how much of the retrieved context the model
  actually used when writing the answer. Low scores mean the retrieved
  chunks were ignored.
- **Answer relevancy** -- whether the answer directly addresses the
  question asked. Tangential answers score low even when factually correct.

## Access tiers

RAGScope is free to use under fair-use limits. Bring your own key for
unlimited usage.

| Tier | Daily benchmark runs | Daily chat questions | API key | How to enable |
|------|----------------------|----------------------|---------|---------------|
| **Guest** (default) | 12 strategy runs | 5 questions | Shared backend `OPENAI_API_KEY` | None -- just visit the app |
| **BYOK** | Unlimited | Unlimited | Your own OpenAI or Anthropic key | Paste into the Settings drawer; key stays in browser `localStorage` only and never reaches the backend |
| **Dev (Tier 0)** | Unlimited | Unlimited | Shared backend key | `?dev=<token>` URL param writes the token to `sessionStorage`; backend hashes and compares against `DEV_TOKEN`. Project-owner only. |

A guest selecting all four strategies in one submission uses four of their
twelve daily runs (selecting N strategies counts as N runs). Compression
is a free orthogonal toggle.

---

## Local development

Prerequisites: Python 3.11, Node 18+, Docker.

```bash
# 1. Configure secrets
cp .env.example .env
# Open .env and fill in OPENAI_API_KEY at minimum.
# For SUPABASE_URL on local dev, point at the docker-compose Postgres:
#   SUPABASE_URL=postgresql://ragscope:ragscope@localhost:5433/ragscope

# 2. Start Postgres with pgvector
docker-compose up -d
# Listens on localhost:5433. Persists data in a named volume.

# 3. Install backend deps and run the API
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000

# 4. In another terminal, run the frontend
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

### Tests and build

```bash
# Backend tests
python -m pytest                              # full suite
python -m pytest tests/test_retrieval.py -v   # one file
python scripts/smoke_test.py                  # end-to-end against a running backend

# Frontend production build (catches type errors)
cd frontend && npm run build
```

The project's [CLAUDE.md](CLAUDE.md) requires both `python -m pytest` and
`npm run build` to pass before any task is considered complete.

---

## Stack

**Backend**
- [FastAPI](https://fastapi.tiangolo.com/) 0.115 on Python 3.11.9
- [uvicorn](https://www.uvicorn.org/) ASGI server
- [asyncpg](https://magicstack.github.io/asyncpg/) async Postgres driver
  for the request path
- [psycopg2](https://www.psycopg.org/) sync Postgres driver for the
  background-task path (avoids `asyncio.timeout()` interactions)
- [pgvector](https://github.com/pgvector/pgvector) for dense vector storage
  and cosine similarity in Postgres
- [rank-bm25](https://pypi.org/project/rank-bm25/) pure-Python sparse index
- OpenAI `text-embedding-3-small` (1536 dims) for embeddings
- [RAGAS](https://docs.ragas.io/) 0.1.21 for evaluation, judged by `gpt-4o-mini`
- [httpx](https://www.python-httpx.org/) async/sync HTTP client for LLM calls
- [LangSmith](https://docs.smith.langchain.com/) via the `langsmith` package
  (no `langchain-core` dependency)

**Frontend**
- [Next.js 14](https://nextjs.org/) with the App Router
- [Tailwind CSS](https://tailwindcss.com/) 3
- [recharts](https://recharts.org/) for the radar / bar charts
- [framer-motion](https://www.framer.com/motion/) for transitions
- [lucide-react](https://lucide.dev/) icon set
- [KaTeX](https://katex.org/) for the formula renders on the docs page

**Deployment**
- Backend on [Railway](https://railway.app/) (Docker, Python 3.11.9-slim)
- Frontend on [Vercel](https://vercel.com/) free tier
- Postgres + pgvector on [Supabase](https://supabase.com/) free tier
  (transaction pooler on port 6543)

---

## Architecture at a glance

```
┌─────────────────────┐         ┌──────────────────────────┐         ┌─────────────────┐
│  Next.js frontend   │ ──HTTP─▶│  FastAPI backend         │ ──SQL──▶│  Supabase       │
│  (Vercel)           │         │  (Railway)               │         │  Postgres +     │
│                     │◀─poll───│  /ingest /benchmark      │         │  pgvector       │
│  - 4-step UI        │         │  /results /chat          │         └─────────────────┘
│  - localStorage     │         │  /strategies /health     │
│    history          │         │                          │         ┌─────────────────┐
│  - BYOK direct LLM  │         │  Background eval tasks   │ ──HTTP─▶│  OpenAI API     │
│    calls (Tier 2)   │         │  (psycopg2, own loop)    │         │  embeddings +   │
└─────────────────────┘         └──────────────────────────┘         │  RAGAS judge    │
                                                                      └─────────────────┘
```

The benchmark flow is fully asynchronous from the user's perspective:

1. `POST /benchmark` accepts N strategy selections, opens a row per strategy
   in `benchmark_runs`, schedules N background tasks, and returns all
   `run_ids` immediately with HTTP 202.
2. The browser polls `GET /results/{run_id}` for each id every ~1 s. Each
   background task transitions `pending → running → completed | failed`.
3. Results stream into the radar / bar / table widgets as each strategy
   finishes, so the user is not blocked on the slowest one.

---

## Production deployment

### Backend on Railway

The FastAPI app runs inside a Docker container built from the
[Dockerfile](Dockerfile) at the repo root (base image `python:3.11.9-slim`).
Railway uses [railway.toml](railway.toml) for the build / start command and
health-check configuration.

```bash
# Sanity-check the image locally before pushing
docker build -t ragscope-backend-test .
docker run --rm -p 8001:8000 --env-file .env ragscope-backend-test
curl http://localhost:8001/health
# expected: {"status":"ok","timestamp":"..."}
```

Deploy:

1. Create a Railway project, connect this GitHub repo.
2. Railway auto-detects the `Dockerfile` and `railway.toml`.
3. Add every variable from [.env.example](.env.example) in the Railway
   service **Variables** tab. Railway injects `PORT` automatically; the
   `startCommand` in `railway.toml` binds to it.
4. Trigger a deploy. The health-check path is `/health` with a 300 second
   timeout so the cold boot has room to create database tables before the
   probe gives up.

> **Why not Render?** RAGScope ran on Render originally. Render's free
> image runtime moved to Python 3.14, where asyncpg's connect path calls
> `asyncio.timeout()` in a way that raises
> `RuntimeError("Timeout should be used inside a task")` under any
> non-trivial concurrency, breaking RAGAS 0.1.21. Railway pins the Python
> version via the Dockerfile, so the runtime is stable.

### Frontend on Vercel

1. Import the repo, set the project root to `frontend/`.
2. Set `NEXT_PUBLIC_API_BASE_URL=https://ragscope-backend-production.up.railway.app`
   in Vercel project settings.
3. Vercel auto-builds on every push to `main`.

### Database on Supabase

1. Create a Supabase project (free tier is fine).
2. Settings -> Database -> Connection string -> use the **transaction
   pooler** URL on port 6543. Paste it into the Railway env var
   `SUPABASE_URL`.
3. The backend creates all tables and enables the `vector` extension on
   first startup via `create_tables()` -- no manual migrations needed.

### Environment variables

See [.env.example](.env.example) for the full list. The non-obvious ones:

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Used for guest-tier embeddings, retrieval LLM (`gpt-4o-mini`), and as the RAGAS judge key. |
| `SUPABASE_URL` | Full Postgres URL. Backend parses with `urllib.parse.urlparse` (not asyncpg's DSN parser, which mis-detects pooler hostnames as IPv6). |
| `LANGCHAIN_TRACING_V2` | `true` in production to send traces to LangSmith, `false` locally. |
| `DEV_TOKEN` | Raw token for the Tier-0 bypass. Backend stores only its SHA-256; rotate by changing this value. |
| `MAX_FILE_SIZE_BYTES` | Per-upload size cap. Default 10 MB. |

---

## Repository layout

```
ragscope/
├── backend/                  FastAPI application
│   ├── main.py               app factory, lifespan, CORS, /health, /strategies
│   ├── core/                 config, auth, rate limiting, DB pool + schema
│   ├── ingest/               PDF + TXT loaders behind a registry
│   ├── chunkers/             fixed_size, semantic, hierarchical
│   ├── retrieval/            naive, hyde, multiquery, hybrid, contextual_compression
│   ├── llm/                  openai_provider, anthropic_provider (BYOK)
│   ├── eval/                 ragas_runner -- the background benchmark task
│   └── routers/              ingest, benchmark, results, chat
├── frontend/                 Next.js 14 App Router
│   ├── app/                  pages: /, /app, /docs
│   ├── components/           Nav, charts, drawers, modals, backgrounds
│   ├── context/              AppContext (corpus, runs), UIContext (toast, theme)
│   └── lib/                  api client, BYOK direct-to-provider client, utils
├── tests/                    pytest suite (106 tests)
├── scripts/                  smoke_test.py
├── Dockerfile                Railway production image
├── railway.toml              Railway build / deploy / healthcheck
├── docker-compose.yml        Local Postgres + pgvector
├── requirements.txt          Backend Python deps
└── CLAUDE.md                 Project rules and architecture decisions
```

---

## Extending RAGScope

Every retriever, chunker, ingestor, and LLM provider auto-registers itself.
Adding a fifth retrieval strategy:

```python
# backend/retrieval/my_strategy.py
from backend.retrieval.base import BaseRetriever, RetrievalResult, register

@register
class MyStrategy(BaseRetriever):
    name = "my_strategy"
    display_name = "My Strategy"
    description = "What it does in one sentence."
    param_schema = [
        {"name": "top_k", "type": "int", "default": 5,
         "min": 1, "max": 20, "description": "How many chunks to retrieve."},
    ]

    def __init__(self, corpus, top_k=5):
        self.corpus = corpus
        self.top_k = top_k

    async def retrieve(self, query: str, top_k: int) -> list[RetrievalResult]:
        ...
```

That's it. `/strategies` will pick it up, the frontend will render a form
for it from `param_schema`, and `/benchmark` will accept it as a value of
`strategy`. No other file needs to change.

The same pattern applies to `backend/ingest/`, `backend/chunkers/`, and
`backend/llm/`.

---

## License

MIT. See [LICENSE](LICENSE) if present; otherwise this project is released
under the MIT license by the repo owner.

---

## Documentation

A full, narrative reference is in [docs/RAGScope_Reference.pdf](docs/RAGScope_Reference.pdf):
introduction, architecture, file-by-file walkthrough, library rationale,
and a free-tier troubleshooting guide (Supabase pause, Railway cold start,
Vercel build failures, RAGAS NaN scores, and more).
