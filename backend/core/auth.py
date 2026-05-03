"""
Developer access authentication for RAGScope.

Implements the Tier 0 dev token bypass described in CLAUDE.md. Developers
place the SHA-256 hash of their DEV_TOKEN in the URL parameter ?dev=<hash>.
The frontend stores this hash in sessionStorage and sends it on every request
as the X-Dev-Token header. The backend validates by hashing the received value
and comparing it against the hash of settings.dev_token.

Why this design keeps the raw token out of the browser:
- The URL contains only the hash, not the raw token.
- The JS bundle never hardcodes anything -- it reads the hash from the URL at
  runtime and forwards it in a header.
- Even if the hash leaks (browser history, logs, network capture), an attacker
  cannot recover the raw token from a SHA-256 hash.
- The backend never logs or stores the received header value.
"""

import hashlib
import hmac

from fastapi import Header

from backend.core.config import settings


def validate_dev_token(token: str) -> bool:
    """
    Return True if the given token string is the correct dev token.

    Hashes both the received token and the stored DEV_TOKEN with SHA-256
    before comparing. Using hmac.compare_digest prevents timing attacks --
    a naive string equality check (==) can leak information about how many
    characters matched by returning faster for shorter prefix matches.
    compare_digest always takes the same amount of time regardless of content.

    Never logs, prints, or stores the raw token or the received value.

    Parameters
    ----------
    token : str
        The value received in the X-Dev-Token request header.

    Returns
    -------
    bool
        True only if sha256(token) == sha256(settings.dev_token). False if
        the token is wrong, empty, or if DEV_TOKEN is not configured.
    """
    # Reject immediately if no dev token is configured in this environment.
    # This prevents accidentally granting dev access when DEV_TOKEN is unset.
    if not settings.dev_token or not token:
        return False

    received_hash = hashlib.sha256(token.encode()).hexdigest()
    stored_hash = hashlib.sha256(settings.dev_token.encode()).hexdigest()

    # compare_digest is constant-time: it does not short-circuit on mismatch.
    return hmac.compare_digest(received_hash, stored_hash)


async def get_dev_access(
    x_dev_token: str = Header(default=""),
) -> bool:
    """
    FastAPI dependency that resolves whether the request carries valid dev access.

    FastAPI automatically maps the underscore parameter name `x_dev_token` to
    the HTTP header `X-Dev-Token`. If the header is absent, x_dev_token is an
    empty string and validate_dev_token returns False.

    This dependency is consumed by check_rate_limit() via Depends(), not called
    directly by endpoint functions.

    Parameters
    ----------
    x_dev_token : str
        Value of the X-Dev-Token header, injected by FastAPI. Defaults to
        empty string if the header is not present.

    Returns
    -------
    bool
        True if the header is present and passes validate_dev_token().
        False otherwise.
    """
    return validate_dev_token(x_dev_token)
