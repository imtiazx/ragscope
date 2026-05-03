"""
Tests for the dev token authentication and rate limit enforcement.

validate_dev_token is tested directly since it is pure logic with no I/O.
check_rate_limit is tested as a plain async function by calling it with a
mock Request object, bypassing FastAPI's DI machinery. Database calls
(get_run_count, increment_run_count) are patched at the rate_limiter module
level so no real database is needed.
"""

import hashlib
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from backend.core.auth import validate_dev_token
from backend.core.rate_limiter import DAILY_RUN_LIMIT, check_rate_limit


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _make_request(ip: str = "127.0.0.1") -> MagicMock:
    """
    Return a minimal mock that satisfies check_rate_limit's use of request.

    Only request.client.host is accessed. Using MagicMock means any other
    attribute access also returns a MagicMock rather than raising AttributeError.

    Parameters
    ----------
    ip : str
        The client IP address to expose as request.client.host.

    Returns
    -------
    MagicMock
        Mock request with client.host set to ip.
    """
    req = MagicMock()
    req.client.host = ip
    return req


# ---------------------------------------------------------------------------
# validate_dev_token tests
# ---------------------------------------------------------------------------

def test_validate_dev_token_returns_true_for_correct_token():
    """
    validate_dev_token must return True when the received token matches
    the configured DEV_TOKEN.
    """
    with patch("backend.core.auth.settings") as mock_settings:
        mock_settings.dev_token = "correct_secret"
        result = validate_dev_token("correct_secret")
    assert result is True


def test_validate_dev_token_returns_false_for_wrong_token():
    """
    validate_dev_token must return False when the received token does not
    match the configured DEV_TOKEN, even if it looks similar.
    """
    with patch("backend.core.auth.settings") as mock_settings:
        mock_settings.dev_token = "correct_secret"
        result = validate_dev_token("wrong_secret")
    assert result is False


def test_validate_dev_token_returns_false_for_empty_token():
    """
    An empty string must never be accepted as a valid dev token, even if
    DEV_TOKEN itself were somehow empty.
    """
    with patch("backend.core.auth.settings") as mock_settings:
        mock_settings.dev_token = "correct_secret"
        result = validate_dev_token("")
    assert result is False


def test_validate_dev_token_returns_false_when_dev_token_not_configured():
    """
    When DEV_TOKEN is not set in the environment (empty string), no token
    value should be accepted. This prevents accidental dev access in
    environments where the variable was forgotten.
    """
    with patch("backend.core.auth.settings") as mock_settings:
        mock_settings.dev_token = ""
        result = validate_dev_token("anything")
    assert result is False


def test_validate_dev_token_is_case_sensitive():
    """
    Token comparison must be case-sensitive. 'Secret' and 'secret' are
    different tokens and must not match each other.
    """
    with patch("backend.core.auth.settings") as mock_settings:
        mock_settings.dev_token = "Secret"
        assert validate_dev_token("secret") is False
        assert validate_dev_token("SECRET") is False
        assert validate_dev_token("Secret") is True


# ---------------------------------------------------------------------------
# check_rate_limit -- dev bypass tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_dev_bypass_skips_rate_limit_entirely():
    """
    When dev_access is True, check_rate_limit must return immediately without
    querying or incrementing the database. Dev users have no daily limit.
    """
    with patch("backend.core.rate_limiter.get_run_count",
               new_callable=AsyncMock) as mock_count, \
         patch("backend.core.rate_limiter.increment_run_count",
               new_callable=AsyncMock) as mock_inc:

        await check_rate_limit(_make_request(), dev_access=True)

        mock_count.assert_not_called()
        mock_inc.assert_not_called()


@pytest.mark.asyncio
async def test_dev_bypass_does_not_raise_even_at_limit():
    """
    Even if the DB would report count >= DAILY_RUN_LIMIT for this fingerprint,
    a valid dev token must never result in a 429.
    """
    with patch("backend.core.rate_limiter.get_run_count",
               new_callable=AsyncMock) as mock_count:

        mock_count.return_value = DAILY_RUN_LIMIT + 10

        # Must not raise despite the mocked DB returning a count above the limit.
        await check_rate_limit(_make_request(), dev_access=True)


# ---------------------------------------------------------------------------
# check_rate_limit -- rate enforcement tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_rate_limit_raises_429_when_at_daily_limit():
    """
    check_rate_limit must raise HTTP 429 when today's run count is exactly
    equal to DAILY_RUN_LIMIT. The user has used their last allowed run.
    """
    with patch("backend.core.rate_limiter.get_run_count",
               new_callable=AsyncMock) as mock_count, \
         patch("backend.core.rate_limiter.increment_run_count",
               new_callable=AsyncMock) as mock_inc:

        mock_count.return_value = DAILY_RUN_LIMIT

        with pytest.raises(HTTPException) as exc_info:
            await check_rate_limit(_make_request(), dev_access=False)

        assert exc_info.value.status_code == 429
        # Counter must NOT be incremented when a 429 is raised.
        mock_inc.assert_not_called()


@pytest.mark.asyncio
async def test_rate_limit_raises_429_when_above_daily_limit():
    """
    check_rate_limit must raise HTTP 429 when today's count exceeds the limit.
    This handles the edge case of a counter that somehow got incremented past
    the limit (e.g. concurrent requests that both passed the initial check).
    """
    with patch("backend.core.rate_limiter.get_run_count",
               new_callable=AsyncMock) as mock_count:

        mock_count.return_value = DAILY_RUN_LIMIT + 5

        with pytest.raises(HTTPException) as exc_info:
            await check_rate_limit(_make_request(), dev_access=False)

        assert exc_info.value.status_code == 429


@pytest.mark.asyncio
async def test_rate_limit_allows_request_below_daily_limit():
    """
    check_rate_limit must not raise when today's count is below the limit.
    The run counter must be incremented exactly once.
    """
    with patch("backend.core.rate_limiter.get_run_count",
               new_callable=AsyncMock) as mock_count, \
         patch("backend.core.rate_limiter.increment_run_count",
               new_callable=AsyncMock) as mock_inc:

        mock_count.return_value = DAILY_RUN_LIMIT - 1

        await check_rate_limit(_make_request(), dev_access=False)

        mock_inc.assert_called_once()


@pytest.mark.asyncio
async def test_rate_limit_allows_first_request_of_day():
    """
    A brand-new user with count=0 must be allowed through and their counter
    incremented to 1.
    """
    with patch("backend.core.rate_limiter.get_run_count",
               new_callable=AsyncMock) as mock_count, \
         patch("backend.core.rate_limiter.increment_run_count",
               new_callable=AsyncMock) as mock_inc:

        mock_count.return_value = 0

        await check_rate_limit(_make_request(), dev_access=False)

        mock_inc.assert_called_once()


@pytest.mark.asyncio
async def test_rate_limit_error_message_mentions_daily_limit():
    """
    The 429 detail message must state the daily limit so the user knows
    exactly why they were blocked and what the constraint is.
    """
    with patch("backend.core.rate_limiter.get_run_count",
               new_callable=AsyncMock) as mock_count:

        mock_count.return_value = DAILY_RUN_LIMIT

        with pytest.raises(HTTPException) as exc_info:
            await check_rate_limit(_make_request(), dev_access=False)

        detail = exc_info.value.detail
        assert str(DAILY_RUN_LIMIT) in detail


# ---------------------------------------------------------------------------
# check_rate_limit -- fingerprint hash tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_different_ips_produce_different_fingerprint_hashes():
    """
    Two requests from different IP addresses must produce different
    fingerprint_hashes so each IP has its own independent counter.
    """
    calls: list[str] = []

    async def record_hash(fph: str) -> int:
        calls.append(fph)
        return 0

    with patch("backend.core.rate_limiter.get_run_count",
               side_effect=record_hash), \
         patch("backend.core.rate_limiter.increment_run_count",
               new_callable=AsyncMock):

        await check_rate_limit(_make_request("1.2.3.4"), dev_access=False,
                               x_fingerprint="same_fp")
        await check_rate_limit(_make_request("5.6.7.8"), dev_access=False,
                               x_fingerprint="same_fp")

    assert len(calls) == 2
    assert calls[0] != calls[1], "Different IPs must produce different hashes"


@pytest.mark.asyncio
async def test_same_ip_different_fingerprint_produces_different_hash():
    """
    Two users on the same IP but with different browser fingerprints must
    each get their own counter. This is the key advantage of combining IP
    with fingerprint over IP alone.
    """
    calls: list[str] = []

    async def record_hash(fph: str) -> int:
        calls.append(fph)
        return 0

    with patch("backend.core.rate_limiter.get_run_count",
               side_effect=record_hash), \
         patch("backend.core.rate_limiter.increment_run_count",
               new_callable=AsyncMock):

        await check_rate_limit(_make_request("1.2.3.4"), dev_access=False,
                               x_fingerprint="browser_A")
        await check_rate_limit(_make_request("1.2.3.4"), dev_access=False,
                               x_fingerprint="browser_B")

    assert len(calls) == 2
    assert calls[0] != calls[1], "Same IP, different fingerprint must produce different hashes"
