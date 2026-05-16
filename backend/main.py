"""
FastAPI application entry point for RAGScope.

Creates the app instance, registers middleware and routers, and wires up
the lifespan handler that creates database tables on startup and closes the
connection pool on shutdown.

All route logic lives in backend/routers/. This file is intentionally thin --
it is only wiring and configuration, not business logic.
"""

import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.chunkers.registry import registry as chunker_registry
from backend.core.database import close_pool, create_tables
from backend.retrieval.contextual_compression import ContextualCompressor
from backend.retrieval.registry import registry as retrieval_registry
from backend.routers import benchmark, chat, ingest, results


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manage application-level resources that must be set up before the first
    request and torn down after the last.

    A lifespan context manager is an async generator function decorated with
    @asynccontextmanager. FastAPI calls it once when the server starts:
      - Code before `yield` runs on startup (database tables, connection pools).
      - The `yield` suspends the function while the server handles requests.
      - Code after `yield` runs on shutdown (close DB connections, flush caches).

    This replaces the older @app.on_event("startup") / @app.on_event("shutdown")
    pattern, which is deprecated in modern FastAPI.

    Parameters
    ----------
    app : FastAPI
        The application instance. Not used here but required by the protocol.
    """
    await create_tables()
    yield
    await close_pool()


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="RAGScope",
    description="RAG benchmarking harness -- measure retrieval strategy performance.",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS: restricted to the production Vercel frontend and the local Next.js dev
# server. Wildcard ("*") is intentionally NOT used here because it would let any
# origin make credentialed requests to the API, including BYOK token exfiltration
# attempts from a third-party page that loaded our endpoints. Add a new origin
# only when a new official frontend deployment is brought online.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://ragscope.vercel.app",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers. Each router owns one domain of the API surface.
app.include_router(ingest.router)
app.include_router(benchmark.router)
app.include_router(results.router)
app.include_router(chat.router)


# ---------------------------------------------------------------------------
# Utility endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health() -> dict:
    """
    Return a simple liveness signal.

    Used by Render's health-check probe and by developers to confirm the
    server is running. Returns the current UTC timestamp so callers can
    verify the server clock is reasonable.

    Returns
    -------
    dict
        {"status": "ok", "timestamp": "<ISO 8601 UTC string>"}
    """
    return {
        "status": "ok",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


@app.get("/strategies")
async def list_strategies() -> dict:
    """
    Return the full registry of retrieval strategies and chunkers with their
    parameter schemas.

    The frontend calls this endpoint once on load to dynamically build the
    benchmark configuration form. No hardcoded strategy lists exist anywhere
    in the frontend code -- it always derives them from this response.

    Returns
    -------
    dict
        {
          "retrievers": [
            {"name": str, "display_name": str, "description": str,
             "param_schema": list[dict]},
            ...
          ],
          "chunkers": [
            {"name": str, "display_name": str, "param_schema": list[dict]},
            ...
          ],
          "compression": {
            "param_schema": list[dict]
          }
        }
    """
    retrievers = [
        {
            "name": cls.name,
            "display_name": cls.display_name,
            "description": cls.description,
            "param_schema": cls.param_schema,
        }
        for cls in retrieval_registry.values()
    ]

    chunkers = [
        {
            "name": cls.name,
            "display_name": cls.display_name,
            "param_schema": cls.param_schema,
        }
        for cls in chunker_registry.values()
    ]

    return {
        "retrievers": retrievers,
        "chunkers": chunkers,
        # Compression is a post-retrieval processor, not a retrieval strategy,
        # so it is not in the retrieval registry. Expose its param_schema
        # separately so the frontend can render the compression toggle and
        # its configuration fields independently.
        "compression": {
            "param_schema": ContextualCompressor.param_schema,
        },
    }
