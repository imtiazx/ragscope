"""
Database connection pool, schema management, and data helpers for RAGScope.

This module is the single place that creates and owns the asyncpg connection
pool. All other modules that need a database connection call get_pool() here
rather than creating their own connections.

The pool is initialised lazily on first use so the application can import
this module at startup without immediately requiring a reachable database --
useful during local development when the database container may not be up yet.

Two tables are managed here:
  benchmark_runs -- one row per evaluation run, tracks status and metrics.
  corpus_chunks  -- stores pre-embedded text chunks indexed by corpus_hash.
"""

import json
from urllib.parse import urlparse

import asyncpg
from pgvector.asyncpg import register_vector

from backend.core.config import settings


_LOCAL_HOSTS = {"localhost", "127.0.0.1"}


def _parse_db_kwargs() -> dict:
    """
    Parse SUPABASE_URL into individual keyword arguments for asyncpg.

    asyncpg's internal DSN parser rejects some valid Postgres URLs -- notably,
    Supabase connection-pooler hostnames containing dots and hyphens can be
    misidentified as malformed IPv6 literals, raising ValueError at startup.
    Parsing with urllib.parse.urlparse bypasses asyncpg's parser entirely and
    passes each component directly, which works regardless of hostname format.

    SSL behaviour:
    - localhost / 127.0.0.1: no SSL (local Docker Postgres has no certificate).
    - any other host: ssl="require" (Supabase and all remote Postgres instances
      must use encrypted connections).

    Returns
    -------
    dict
        Keyword arguments suitable for asyncpg.create_pool() or
        asyncpg.connect(): host, port, user, password, database, and
        optionally ssl.
    """
    parsed = urlparse(settings.supabase_url)
    host = parsed.hostname or ""
    kwargs: dict = {
        "host": host,
        "port": parsed.port or 5432,
        "user": parsed.username,
        "password": parsed.password,
        "database": parsed.path.lstrip("/"),
    }
    if host not in _LOCAL_HOSTS:
        kwargs["ssl"] = "require"
    return kwargs


# Module-level pool singleton. None until get_pool() is called for the first
# time. Declared at module scope so the same pool is reused across all calls.
_pool: asyncpg.Pool | None = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    """
    Register JSONB type codecs on each newly created connection.

    asyncpg does not automatically marshal Python dicts to/from Postgres JSONB.
    This function is passed as the `init` argument to create_pool() so it runs
    once for every connection the pool creates. After this, code can pass a
    Python dict to a JSONB parameter and receive a dict back from a JSONB column
    without manually calling json.dumps / json.loads.

    Parameters
    ----------
    conn : asyncpg.Connection
        Freshly created connection being initialised by the pool.
    """
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )
    # Register the pgvector codec so Python lists are accepted as vector(1536)
    # parameters and vector columns are returned as numpy arrays.
    await register_vector(conn)


async def get_pool() -> asyncpg.Pool:
    """
    Return the shared asyncpg connection pool, creating it on first call.

    Subsequent calls return the same pool object without re-connecting.
    The pool size defaults to asyncpg's built-in minimum/maximum (10 connections)
    which is appropriate for the expected concurrency on Railway's free tier.

    Returns
    -------
    asyncpg.Pool
        Ready-to-use connection pool pointed at the configured database.
        Connection parameters are parsed from SUPABASE_URL by _parse_db_kwargs
        rather than passed as a raw DSN string, which avoids asyncpg's internal
        URL parser that misidentifies some Supabase hostnames as IPv6 literals.
    """
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            **_parse_db_kwargs(),
            init=_init_connection,
            statement_cache_size=0,
        )
    return _pool


async def make_task_pool() -> asyncpg.Pool:
    """
    Create and return a fresh connection pool for a background task.

    Unlike get_pool(), this does NOT return the module-level singleton. Each
    call creates a new pool bound to the currently running event loop. Callers
    are responsible for closing the pool when their work is done.

    Background tasks that run under asyncio.run() execute on a brand-new event
    loop that is different from the FastAPI main event loop. asyncpg pools are
    tied to the event loop they were created on, so reusing the singleton pool
    from a different loop raises an event-loop mismatch error. Creating a
    dedicated pool here avoids that entirely.

    NOTE: this defensive pattern exists because on Python 3.14 (the previous
    Render host's runtime) asyncpg's connect path internally calls
    `asyncio.timeout()` which raises
    `RuntimeError("Timeout should be used inside a task")` when
    `current_task()` returns None during concurrent task creation. The
    current Railway deployment pins Python 3.11.9 (see Dockerfile) where the
    bug does not trigger, but the workaround is kept as belt-and-suspenders.
    Passing `timeout=None` and `command_timeout=None` skips the
    `asyncio.timeout()` wrapper entirely - asyncpg waits indefinitely on the
    TCP connect rather than racing it against a timer. The underlying socket
    connect still fails fast if Supabase is unreachable; we just lose the
    application-level cancellation deadline, which is acceptable here
    because the background-task event loop has nothing else to do anyway.
    `min_size=1`/`max_size=3` keeps the pool small so a stuck connection
    cannot tie up many worker slots.

    Returns
    -------
    asyncpg.Pool
        Ready-to-use pool bound to the caller's event loop. Must be closed
        by the caller (e.g. in a try/finally block).
    """
    return await asyncpg.create_pool(
        **_parse_db_kwargs(),
        init=_init_connection,
        min_size=1,
        max_size=3,
        statement_cache_size=0,
        timeout=None,
        command_timeout=None,
    )


async def make_task_connection() -> asyncpg.Connection:
    """
    Open a single direct asyncpg connection for a background task.

    Used by the RAGAS evaluation background task in place of a pool. The
    connection is the only DB handle the task needs - retrieval, compression,
    and answer generation make zero DB calls between steps 1-2 and step 7 of
    the evaluation pipeline, so the overhead of a pool is wasted and its
    create_pool() initialiser actively misbehaves on Python 3.14.

    Concretely on Python 3.14: asyncpg's connection path wraps the TCP
    connect in `asyncio.timeout()` (via its compat module). On 3.14 that
    `asyncio.timeout()` raises `RuntimeError("Timeout should be used inside
    a task")` if `current_task()` returns None at the point the context
    manager is entered, which happens on certain Render worker instances
    under any non-trivial load. Passing `timeout=None` tells asyncpg to
    wait indefinitely on the connect and skip the `asyncio.timeout()`
    wrapper entirely, sidestepping the 3.14 issue. The TCP connect itself
    still fails fast on a real network problem; only the application-level
    deadline is removed, which is acceptable for a background task that
    has nothing else to race against.

    The codec init that `create_pool`'s `init=` argument would normally run
    automatically is invoked manually here, so the returned connection
    decodes JSONB and pgvector columns identically to a pooled connection.

    Returns
    -------
    asyncpg.Connection
        Ready-to-use connection bound to the caller's event loop. The caller
        owns its lifecycle and must close it via `await conn.close()` when
        done (typically in a try/finally block).
    """
    kwargs = _parse_db_kwargs()
    kwargs["timeout"] = None
    kwargs["command_timeout"] = None
    conn = await asyncpg.connect(
        **kwargs,
        statement_cache_size=0,
    )
    await _init_connection(conn)
    return conn


def make_sync_connection():
    """
    Return a synchronous psycopg2 connection for use in background tasks.

    asyncpg's connection path on Python 3.14 (the previous Render host's
    runtime) calls asyncio.timeout() internally regardless of any timeout
    argument we pass; it fires inside its compat module before the timeout
    value is consulted, raising RuntimeError("Timeout should be used inside
    a task") when current_task() returns None. Earlier sessions tried
    routing around this with loop.create_task() outer wrappers, direct
    asyncpg.connect() instead of pools, and timeout=None - none of those
    landed reliably across every Render worker instance. The current Railway
    deployment pins Python 3.11.9 (see Dockerfile) so the original bug does
    not trigger, but psycopg2 stays as the background-task driver because it
    is simpler, blocks the dedicated task loop with no side effects, and
    removes any future risk if the runtime is ever bumped.

    psycopg2 is fully synchronous and never touches asyncio at all, so
    it cannot trigger the failure mode by construction. The trade-off is
    that DB calls block the event loop while they run; this is fine here
    because the background task's loop has no other coroutines to starve
    (the only awaits are for OpenAI / RAGAS calls between the DB hops).

    The function is sync (no `async def`). Call it directly without
    `await`. The returned connection is in manual-commit mode; callers
    must `conn.commit()` after writes.

    JSONB columns: psycopg2 returns them as already-decoded Python objects
    (dict/list) and accepts Python objects on the way in if wrapped with
    psycopg2.extras.Json. The retrieved_chunks_data INSERT in the eval
    pipeline wraps its payload accordingly.

    pgvector columns: pgvector.psycopg2.register_vector(conn) installs a
    type adapter so the embedding column is returned as a numpy array.
    The caller converts to list() to match the existing retriever
    contract.

    Returns
    -------
    psycopg2.extensions.connection
        Open connection. The caller is responsible for closing it in a
        try/finally block via `conn.close()`.
    """
    # Lazy imports so test environments without psycopg2 / pgvector
    # installed do not fail to load this module.
    import psycopg2
    import psycopg2.extras
    from pgvector.psycopg2 import register_vector

    # Register a process-global UUID adapter so psycopg2 can serialise
    # uuid.UUID parameters without per-call str() casts. Safe to call
    # multiple times; subsequent calls are effectively idempotent.
    psycopg2.extras.register_uuid()

    parsed = urlparse(settings.supabase_url)
    host = parsed.hostname or ""
    sslmode = "disable" if host in _LOCAL_HOSTS else "require"
    conn = psycopg2.connect(
        host=host,
        port=parsed.port or 5432,
        dbname=parsed.path.lstrip("/"),
        user=parsed.username,
        password=parsed.password,
        sslmode=sslmode,
    )
    conn.autocommit = False
    # Register pgvector codec so the corpus_chunks.embedding column comes
    # back as a numpy array rather than a Postgres text representation
    # ("[0.1,0.2,...]") that would need manual parsing.
    register_vector(conn)
    return conn


async def close_pool() -> None:
    """
    Gracefully close all connections in the pool.

    Called during application shutdown (via a FastAPI lifespan event) so
    Postgres does not see abrupt disconnects. Safe to call even if the pool
    was never initialised.
    """
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def create_tables() -> None:
    """
    Create all application tables if they do not already exist.

    Idempotent -- safe to call on every application startup. The IF NOT EXISTS
    clause means it does nothing if the schema is already in place.

    Column design notes:
    - id is UUID generated by Postgres so the application never needs to supply
      one, and IDs are globally unique with no coordination needed.
    - retrieval_params / chunker_params / compression_params are JSONB so new
      strategy parameters can be stored without altering the schema.
    - retrieved_chunks is JSONB so the full result list (with scores and
      metadata) can be stored and retrieved as a structured document.
    - Metric columns (faithfulness, context_utilization, answer_relevancy) are
      nullable floats -- they are NULL while the run is in progress and only
      set when status transitions to 'completed'.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Enable the pgvector extension before creating tables that use it.
        # IF NOT EXISTS makes this idempotent.
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS corpus_chunks (
                id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
                corpus_hash TEXT    NOT NULL,
                chunk_index INTEGER NOT NULL,
                content     TEXT    NOT NULL,
                embedding   vector(1536)
            )
        """)

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS benchmark_runs (
                id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
                created_at          TIMESTAMPTZ NOT NULL    DEFAULT NOW(),
                status              TEXT        NOT NULL    DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
                retrieval_strategy  TEXT        NOT NULL,
                chunker_strategy    TEXT        NOT NULL,
                retrieval_params    JSONB       NOT NULL    DEFAULT '{}',
                chunker_params      JSONB       NOT NULL    DEFAULT '{}',
                compression_enabled BOOLEAN     NOT NULL    DEFAULT FALSE,
                compression_params  JSONB       NOT NULL    DEFAULT '{}',
                corpus_hash         TEXT        NOT NULL,
                question            TEXT        NOT NULL,
                retrieved_chunks    JSONB       NOT NULL    DEFAULT '[]',
                generated_answer    TEXT,
                faithfulness        FLOAT,
                context_utilization FLOAT,
                answer_relevancy    FLOAT,
                latency_ms          FLOAT,
                error_message       TEXT
            )
        """)

        # Composite primary key (fingerprint_hash, date) means one row per
        # hashed fingerprint per calendar day. Old rows from previous days are
        # never updated -- the ON CONFLICT clause only matches today's row.
        # run_count tracks strategy-level benchmark runs (Tier 1 limit 12/day).
        # chat_count tracks live /chat questions (Tier 1 limit 5/day). The two
        # counters are independent: enabling/disabling compression or running
        # the chat endpoint does not consume run_count and vice versa.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS rate_limit_counters (
                fingerprint_hash TEXT NOT NULL,
                date             DATE NOT NULL DEFAULT CURRENT_DATE,
                run_count        INTEGER NOT NULL DEFAULT 0,
                chat_count       INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (fingerprint_hash, date)
            )
        """)
        # Backfill column for environments where the table was created by an
        # earlier version of this function without chat_count. ADD COLUMN IF
        # NOT EXISTS is a no-op when the column already exists, so this stays
        # idempotent across repeated calls and across environments.
        await conn.execute(
            "ALTER TABLE rate_limit_counters "
            "ADD COLUMN IF NOT EXISTS chat_count INTEGER NOT NULL DEFAULT 0"
        )


async def corpus_exists(corpus_hash: str) -> bool:
    """
    Return True if at least one chunk exists for the given corpus_hash.

    Used by the ingest endpoint to detect duplicate uploads and by the
    benchmark endpoint to validate that the corpus was successfully ingested
    before attempting retrieval.

    Parameters
    ----------
    corpus_hash : str
        SHA-256 hex digest identifying the uploaded corpus.

    Returns
    -------
    bool
        True if the corpus has at least one stored chunk, False otherwise.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT 1 FROM corpus_chunks WHERE corpus_hash = $1 LIMIT 1",
            corpus_hash,
        )
    return row is not None


async def store_chunks(
    corpus_hash: str,
    chunks: list[tuple[str, list[float]]],
) -> None:
    """
    Insert all chunks for a corpus in a single batch operation.

    Uses asyncpg's executemany() which sends the INSERT as a server-side
    prepared statement executed once per row. This is significantly faster
    than N individual execute() calls because asyncpg pipelines the rows in
    a single network roundtrip rather than waiting for each row's confirmation
    before sending the next one.

    Parameters
    ----------
    corpus_hash : str
        SHA-256 hex digest identifying the corpus these chunks belong to.
    chunks : list[tuple[str, list[float]]]
        Ordered list of (content, embedding) pairs. chunk_index is assigned
        from the list position (0-based) and preserved for deterministic
        ordering when loading the corpus later.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.executemany(
            """
            INSERT INTO corpus_chunks (corpus_hash, chunk_index, content, embedding)
            VALUES ($1, $2, $3, $4)
            """,
            [
                (corpus_hash, idx, content, embedding)
                for idx, (content, embedding) in enumerate(chunks)
            ],
        )


async def get_chunk_count(corpus_hash: str) -> int:
    """
    Return the number of stored chunks for a given corpus_hash.

    Used by the ingest endpoint when returning early on a duplicate upload
    so the caller receives an accurate chunk count without re-processing.

    Parameters
    ----------
    corpus_hash : str
        SHA-256 hex digest identifying the corpus.

    Returns
    -------
    int
        Number of corpus_chunks rows for this corpus_hash. Zero if none exist.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT COUNT(*) AS n FROM corpus_chunks WHERE corpus_hash = $1",
            corpus_hash,
        )
    return int(row["n"])


async def load_corpus(corpus_hash: str) -> list[dict]:
    """
    Load all chunks for a corpus from the database in chunk_index order.

    Returns each chunk as a dict in the format expected by retriever
    constructors: chunk_id, content, and embedding as a Python list.

    Parameters
    ----------
    corpus_hash : str
        SHA-256 hex digest identifying the corpus.

    Returns
    -------
    list[dict]
        Ordered list of dicts with keys: chunk_id (str), content (str),
        embedding (list[float]). Empty list if no chunks exist.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, content, embedding
            FROM corpus_chunks
            WHERE corpus_hash = $1
            ORDER BY chunk_index
            """,
            corpus_hash,
        )
    return [
        {
            "chunk_id": str(row["id"]),
            "content": row["content"],
            # pgvector returns numpy arrays; convert to plain Python list
            # so retriever code can use standard list operations.
            "embedding": list(row["embedding"]),
        }
        for row in rows
    ]


async def increment_run_count(fingerprint_hash: str, delta: int = 1) -> None:
    """
    Increment the benchmark run counter for today for the given fingerprint.

    Uses INSERT ... ON CONFLICT DO UPDATE so the operation is atomic and
    requires no separate existence check. If no row exists for this
    fingerprint and today's date, a new row is created with run_count=delta.
    If a row already exists, its run_count is incremented by delta.

    The composite primary key (fingerprint_hash, date) ensures one counter
    row per fingerprint per calendar day. Yesterday's counter rows are never
    modified and can be cleaned up by a scheduled job later.

    Parameters
    ----------
    fingerprint_hash : str
        SHA-256 hex digest of the combined IP + browser fingerprint string.
    delta : int
        Amount to increment by. Defaults to 1. Pass the number of strategies
        selected in a multi-strategy benchmark submission.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO rate_limit_counters (fingerprint_hash, date, run_count)
            VALUES ($1, CURRENT_DATE, $2)
            ON CONFLICT (fingerprint_hash, date)
            DO UPDATE SET run_count = rate_limit_counters.run_count + $2
            """,
            fingerprint_hash,
            delta,
        )


async def get_run_count(fingerprint_hash: str) -> int:
    """
    Return the number of benchmark runs made today by the given fingerprint.

    Returns 0 if no row exists for today, which is the correct starting state
    for a fingerprint that has not run any benchmarks today.

    Parameters
    ----------
    fingerprint_hash : str
        SHA-256 hex digest of the combined IP + browser fingerprint string.

    Returns
    -------
    int
        Number of runs recorded today. 0 if the fingerprint has no row yet.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT run_count FROM rate_limit_counters
            WHERE fingerprint_hash = $1 AND date = CURRENT_DATE
            """,
            fingerprint_hash,
        )
    return int(row["run_count"]) if row is not None else 0
