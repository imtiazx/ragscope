"""
Anthropic LLM provider for RAGScope.

Wraps the Anthropic Messages REST API using httpx so all calls are
non-blocking and compatible with the FastAPI async event loop. Used by
Tier 2 BYOK users who supply their own Anthropic key. Only the complete()
method is supported -- Anthropic does not provide a public embeddings API,
so embed() raises NotImplementedError. API key is always read from the
central settings object, never from os.environ directly.

Two method variants are provided for complete():
  - async complete(): used by main FastAPI route handlers running on the
    anyio-backed uvloop event loop.
  - complete_sync(): used by the background task execution path which runs
    on a plain asyncio event loop with no anyio task scope. See
    openai_provider.py for the full explanation of why AsyncClient cannot
    be used from that context.
"""

import httpx

from backend.core.config import settings
from backend.llm.base import BaseLLMProvider, register

# Base URL for the Anthropic Messages REST endpoint.
_ANTHROPIC_API_BASE = "https://api.anthropic.com/v1"

# Anthropic's API versioning is done via a header rather than the URL path.
# This value pins the exact API contract we expect; bump it deliberately when
# adopting new API features.
_ANTHROPIC_API_VERSION = "2023-06-01"


@register
class AnthropicProvider(BaseLLMProvider):
    """
    Concrete LLM provider that calls Anthropic's Messages API.

    Implements complete() / complete_sync() using claude-haiku-3, the cheapest
    Anthropic model, which is appropriate for the high call volume of BYOK
    retrieval strategies. Does not implement embed() because Anthropic does not
    offer an embeddings endpoint -- callers that need embeddings must use
    OpenAIProvider instead.
    """

    name: str = "anthropic"
    display_name: str = "Anthropic"

    async def complete(self, prompt: str) -> str:
        """
        Send a prompt to claude-haiku-3 and return the completion text.

        Uses httpx.AsyncClient. Call this from FastAPI route handlers or any
        code running inside an anyio task scope. Do NOT call this from a
        background task thread -- use complete_sync() instead.

        Parameters
        ----------
        prompt : str
            Full prompt text to send as the user message.

        Returns
        -------
        str
            The model's reply text, stripped of leading/trailing whitespace.

        Raises
        ------
        httpx.HTTPStatusError
            If the Anthropic API responds with a 4xx or 5xx status code.
        """
        headers = {
            "x-api-key": settings.anthropic_api_key,
            "anthropic-version": _ANTHROPIC_API_VERSION,
            "Content-Type": "application/json",
        }
        payload = {
            "model": "claude-haiku-3-5",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}],
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{_ANTHROPIC_API_BASE}/messages",
                headers=headers,
                json=payload,
                timeout=30.0,
            )
            response.raise_for_status()

        data = response.json()
        for block in data["content"]:
            if block["type"] == "text":
                return block["text"].strip()

        raise ValueError(f"No text block found in Anthropic response: {data}")

    def complete_sync(self, prompt: str) -> str:
        """
        Blocking version of complete() for use in background task threads.

        Uses httpx.Client (synchronous) instead of httpx.AsyncClient. Must be
        used inside _run_evaluation_async and any retriever or compressor code
        running in that context. See openai_provider.complete_sync() for the
        full explanation.

        Parameters
        ----------
        prompt : str
            Full prompt text to send as the user message.

        Returns
        -------
        str
            The model's reply text, stripped of leading/trailing whitespace.

        Raises
        ------
        httpx.HTTPStatusError
            If the Anthropic API responds with a 4xx or 5xx status code.
        """
        headers = {
            "x-api-key": settings.anthropic_api_key,
            "anthropic-version": _ANTHROPIC_API_VERSION,
            "Content-Type": "application/json",
        }
        payload = {
            "model": "claude-haiku-3-5",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}],
        }

        with httpx.Client() as client:
            response = client.post(
                f"{_ANTHROPIC_API_BASE}/messages",
                headers=headers,
                json=payload,
                timeout=30.0,
            )
            response.raise_for_status()

        data = response.json()
        for block in data["content"]:
            if block["type"] == "text":
                return block["text"].strip()

        raise ValueError(f"No text block found in Anthropic response: {data}")

    async def embed(self, text: str) -> list[float]:
        """
        Not supported -- Anthropic does not provide an embeddings API.

        All embedding needs in RAGScope are served by OpenAIProvider.embed(),
        which uses text-embedding-3-small. If you need embeddings, instantiate
        OpenAIProvider instead.

        Parameters
        ----------
        text : str
            Ignored.

        Raises
        ------
        NotImplementedError
            Always. Anthropic has no public embeddings endpoint.
        """
        raise NotImplementedError(
            "Anthropic does not provide an embeddings API. "
            "Use OpenAIProvider for embedding generation."
        )

    def embed_sync(self, text: str) -> list[float]:
        """
        Not supported -- Anthropic does not provide an embeddings API.

        Raises
        ------
        NotImplementedError
            Always. Anthropic has no public embeddings endpoint.
        """
        raise NotImplementedError(
            "Anthropic does not provide an embeddings API. "
            "Use OpenAIProvider for embedding generation."
        )
