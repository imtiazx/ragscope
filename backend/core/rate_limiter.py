"""
Rate limiting constants and dependency for RAGScope.

Exports DAILY_RUN_LIMIT (12 strategy runs per day) and DAILY_CHAT_LIMIT
(5 live chat questions per day) for use by the benchmark and chat routers.

The check_rate_limit dependency enforces the run limit as a FastAPI
dependency. For multi-strategy benchmarks, the benchmark router performs
the rate limit check inline using DAILY_RUN_LIMIT directly, because it
needs to calculate N strategies at once before creating any rows.

The "user" is identified by a SHA-256 hash of their IP address combined
with a browser fingerprint sent in a custom header. This composite identifier
is more precise than IP alone (multiple users can share one IP) without
storing personally identifiable information (the hash is irreversible).

Tier 0 dev access bypasses all checks. Tier 2 BYOK calls go direct from
the frontend and never hit this endpoint, so they are not subject to this
limiter either.

HTTP 429 Too Many Requests is the standard status code for rate limit
violations. It signals to the client that the request was understood and
valid, but is being refused temporarily due to rate constraints - as
opposed to 403 Forbidden which implies a permanent access denial.
"""

import hashlib

from fastapi import Depends, HTTPException, Header, Request

from backend.core.auth import get_dev_access
from backend.core.database import get_run_count, increment_run_count

# Maximum number of strategy-level benchmark runs a guest user may make per day.
# Selecting all 4 strategies counts as 4 runs. Matches the Tier 1 limit in CLAUDE.md.
DAILY_RUN_LIMIT = 12

# Maximum number of live chat questions a guest user may ask per day across all
# strategies combined. Matches the Tier 1 limit defined in CLAUDE.md.
DAILY_CHAT_LIMIT = 5


async def check_rate_limit(
    request: Request,
    dev_access: bool = Depends(get_dev_access),
    x_fingerprint: str = Header(default=""),
) -> None:
    """
    FastAPI dependency that enforces the daily benchmark run limit.

    Must be added as a dependency to POST /benchmark only. Ingest calls do
    not count against the daily limit because ingesting a corpus is a one-time
    setup step, not a metered resource.

    Flow:
      1. If the request carries valid dev credentials, return immediately.
         Dev access bypasses all rate limit checks unconditionally.
      2. Derive the fingerprint_hash from the client IP and the X-Fingerprint
         header value. Using both prevents two common evasion patterns: changing
         IP alone (fingerprint still matches) and changing fingerprint alone
         (IP still matches).
      3. Query today's run count for this fingerprint_hash.
      4. If count >= DAILY_RUN_LIMIT, raise HTTP 429.
      5. Otherwise, increment the counter and return.

    HTTP 429 (Too Many Requests) is the correct status code here. It tells
    the client the request is temporarily refused due to rate constraints,
    not permanently blocked. The client should retry tomorrow.

    Parameters
    ----------
    request : Request
        FastAPI request object, used to extract the client IP address.
    dev_access : bool
        Resolved by the get_dev_access dependency. True if the X-Dev-Token
        header passed validation.
    x_fingerprint : str
        Value of the X-Fingerprint header sent by the frontend. May be empty
        if the frontend did not send one; the empty string is still hashed and
        tracked, so IP-only identification still works.

    Raises
    ------
    HTTPException 429
        If today's run count for this fingerprint_hash is already at or above
        DAILY_RUN_LIMIT and dev_access is False.
    """
    # Tier 0: dev token present and valid -- bypass all rate limit logic.
    if dev_access:
        return

    # Extract the client IP. request.client is None in some test contexts;
    # fall back to "unknown" so the hash is still stable within one session.
    client_ip: str = request.client.host if request.client else "unknown"

    # Combine IP and fingerprint before hashing so neither alone is sufficient
    # to spoof the identity. The colon separator prevents collisions between
    # e.g. ip="1.2.3" fp="4.5" and ip="1.2.3.4" fp="5".
    raw_identity = f"{client_ip}:{x_fingerprint}"
    fingerprint_hash = hashlib.sha256(raw_identity.encode()).hexdigest()

    count = await get_run_count(fingerprint_hash)

    if count >= DAILY_RUN_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Daily limit of {DAILY_RUN_LIMIT} strategy runs reached. "
                "Your limit resets at midnight UTC. Paste your own API key "
                "in Settings to run unlimited benchmarks."
            ),
        )

    await increment_run_count(fingerprint_hash)
