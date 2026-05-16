# RAGScope

A public RAG benchmarking harness. Not a RAG app. The point is measurement.
Paste a document corpus, run it through four retrieval strategies, and see
exactly which strategy wins on faithfulness, latency, and context utilization
for your data.

## Live links

- Frontend: https://ragscope.vercel.app
- Backend API: https://ragscope-backend.onrender.com
- API docs (FastAPI auto-generated): https://ragscope-backend.onrender.com/docs

## Retrieval strategies

Four retrieval methods are benchmarked head to head. A fifth control,
contextual compression, is an orthogonal post-retrieval processor that can be
toggled on top of any of the four methods.

1. **Naive RAG**. Embeds the query, returns the chunks with the highest cosine
   similarity. The baseline against which the others are measured.
2. **HyDE (Hypothetical Document Embeddings)**. Asks an LLM to write a
   plausible answer to the question, then embeds that answer and retrieves
   against it. Improves recall when the wording of the query is very
   different from the wording in the documents.
3. **Multi-query**. Asks an LLM to generate several rewordings of the
   question, retrieves chunks for each rewording in parallel, and merges the
   results by best score. Improves recall when a single phrasing misses
   relevant passages.
4. **Hybrid BM25 + dense**. Runs BM25 keyword search and cosine similarity
   in parallel, then fuses the two ranked lists with Reciprocal Rank Fusion.
   Catches exact keyword matches that pure dense search misses.

**Contextual compression** is a post-retrieval processor, not a fifth
strategy. It passes each retrieved chunk through an LLM that extracts only
the sentences relevant to the question. It is toggled independently and can
be combined with any of the four methods. It is not present in the retrieval
registry and selecting it does not consume an additional daily run.

## Evaluation metrics

Every benchmark run is scored by RAGAS using gpt-4o-mini as the judge.

- **Faithfulness**. Measures whether every claim in the generated answer is
  supported by the retrieved chunks. A score of 1.0 means no hallucination.
- **Context utilization**. Measures how much of the retrieved context the
  model actually used when generating the answer. Low scores mean the model
  ignored the retrieved material.
- **Answer relevancy**. Measures whether the answer directly addresses the
  question that was asked. Tangential or off-topic answers score low even if
  they are factually correct.

## Access tiers

- **Guest**. The default for visitors. Twelve strategy runs per day and five
  live chat questions per day, rate limited by a hash of browser fingerprint
  and IP. Uses the shared OPENAI_API_KEY on the backend.
- **BYOK**. Paste your own OpenAI or Anthropic key in the settings drawer.
  The key is stored in browser localStorage only and never sent to the
  backend. Unlimited runs and chat questions; the user pays for their own
  LLM and embedding calls.
- **Dev**. Tier 0 bypass for the project owner. Activated by visiting
  `/app?dev=<token>` once, which writes the token to sessionStorage. The
  backend hashes the token and compares to the configured DEV_TOKEN. Shows
  "Dev mode - unlimited" instead of any run counter.

## Local dev setup

```
cp .env.example .env
docker-compose up -d
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000
cd frontend && npm install && npm run dev
```

The `docker-compose up` step starts Postgres with pgvector on
`localhost:5433`. The backend reads `SUPABASE_URL` for the connection
string; for local dev set it to
`postgresql://ragscope:ragscope@localhost:5433/ragscope`. Run
`python -m pytest` from the repo root to execute the backend test suite.
Run `npm run build` in `frontend/` to produce a production build.

## Stack

- Backend: FastAPI, Python 3.11, uvicorn
- Vector store: pgvector via Supabase in production, Docker Postgres plus
  pgvector for local dev
- Postgres client: asyncpg
- Sparse index: rank-bm25 (pure Python, no Elasticsearch)
- Embeddings: text-embedding-3-small (OpenAI)
- Evaluation framework: ragas 0.1.21
- LLM judge for RAGAS: gpt-4o-mini via OPENAI_API_KEY
- Outbound HTTP: httpx, both async and blocking variants
- Tracing: LangSmith via the langsmith package (no langchain-core dependency)
- Frontend: Next.js 14, Tailwind CSS, recharts, framer-motion, shadcn/ui
- Deployment: Render for the backend, Vercel for the frontend, Supabase for
  the database
