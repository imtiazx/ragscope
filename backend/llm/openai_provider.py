"""
OpenAI LLM provider for RAGScope.

Wraps the OpenAI chat completions and embeddings REST APIs using httpx so
all calls are non-blocking and compatible with the FastAPI async event loop.
Used for guest-tier retrieval (gpt-4o-mini) and dense embedding generation
(text-embedding-3-small). API key is always read from the central settings
object -- never from os.environ directly.

Two method variants are provided for every API call:
  - async complete() / embed(): used by main FastAPI route handlers that run
    on the anyio-backed uvloop event loop. These use httpx.AsyncClient.
  - complete_sync() / embed_sync(): used by the background task execution path
    (inside _run_evaluation_async) which runs on a plain asyncio event loop
    with no anyio task scope. httpx.AsyncClient.__aenter__ initialises an
    anyio task scope and raises "Timeout should be used inside a task" the
    moment it is entered from a non-anyio context. httpx.Client (sync) never
    touches anyio at all and is safe to call from any thread.
"""

import httpx

from backend.core.config import settings
from backend.llm.base import BaseLLMProvider, register

# Base URL for all OpenAI REST endpoints.
_OPENAI_API_BASE = "https://api.openai.com/v1"


@register
class OpenAIProvider(BaseLLMProvider):
    """
    Concrete LLM provider that calls OpenAI's APIs.

    Implements both complete() / complete_sync() (chat completions via
    gpt-4o-mini) and embed() / embed_sync() (dense vectors via
    text-embedding-3-small). A new httpx client is created per call rather
    than shared, so instances of this class carry no mutable state and are
    safe to construct anywhere.
    """

    name: str = "openai"
    display_name: str = "OpenAI"

    async def complete(self, prompt: str) -> str:
        """
        Send a prompt to gpt-4o-mini and return the completion text.

        Uses httpx.AsyncClient. Call this from FastAPI route handlers or any
        code running inside an anyio task scope (i.e. on the main uvloop event
        loop). Do NOT call this from a background task thread that runs on a
        plain asyncio event loop -- use complete_sync() instead.

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
            If the OpenAI API responds with a 4xx or 5xx status code.
        """
        headers = {
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{_OPENAI_API_BASE}/chat/completions",
                headers=headers,
                json=payload,
                timeout=30.0,
            )
            response.raise_for_status()

        data = response.json()
        return data["choices"][0]["message"]["content"].strip()

    def complete_sync(self, prompt: str) -> str:
        """
        Blocking version of complete() for use in background task threads.

        Uses httpx.Client (synchronous) instead of httpx.AsyncClient. This
        method must be used inside _run_evaluation_async and any code it calls
        (retrievers, compressor, answer generator) because those run on a plain
        asyncio.DefaultEventLoopPolicy event loop with no anyio task scope.
        httpx.AsyncClient.__aenter__ initialises an anyio task scope and raises
        "Timeout should be used inside a task" immediately when entered from a
        non-anyio context. httpx.Client never touches anyio.

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
            If the OpenAI API responds with a 4xx or 5xx status code.
        """
        headers = {
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
        }

        with httpx.Client() as client:
            response = client.post(
                f"{_OPENAI_API_BASE}/chat/completions",
                headers=headers,
                json=payload,
                timeout=30.0,
            )
            response.raise_for_status()

        data = response.json()
        return data["choices"][0]["message"]["content"].strip()

    async def embed(self, text: str) -> list[float]:
        """
        Convert text into a dense vector using text-embedding-3-small.

        Uses httpx.AsyncClient. Call this from FastAPI route handlers or any
        code running inside an anyio task scope. Do NOT call this from a
        background task thread -- use embed_sync() instead.

        Parameters
        ----------
        text : str
            Text to embed. For retrieval, this is usually the user query or
            a hypothetical answer produced by complete() in HyDE mode.

        Returns
        -------
        list[float]
            1536-dimensional embedding vector.

        Raises
        ------
        httpx.HTTPStatusError
            If the OpenAI API responds with a 4xx or 5xx status code.
        """
        headers = {
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "text-embedding-3-small",
            "input": text,
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{_OPENAI_API_BASE}/embeddings",
                headers=headers,
                json=payload,
                timeout=30.0,
            )
            response.raise_for_status()

        data = response.json()
        return data["data"][0]["embedding"]

    def embed_sync(self, text: str) -> list[float]:
        """
        Blocking version of embed() for use in background task threads.

        Uses httpx.Client (synchronous) instead of httpx.AsyncClient. Must be
        used inside _run_evaluation_async and any retriever or compressor code
        running in that context. See complete_sync() docstring for the full
        explanation of why AsyncClient cannot be used there.

        Parameters
        ----------
        text : str
            Text to embed.

        Returns
        -------
        list[float]
            1536-dimensional embedding vector.

        Raises
        ------
        httpx.HTTPStatusError
            If the OpenAI API responds with a 4xx or 5xx status code.
        """
        headers = {
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "text-embedding-3-small",
            "input": text,
        }

        with httpx.Client() as client:
            response = client.post(
                f"{_OPENAI_API_BASE}/embeddings",
                headers=headers,
                json=payload,
                timeout=30.0,
            )
            response.raise_for_status()

        data = response.json()
        return data["data"][0]["embedding"]
