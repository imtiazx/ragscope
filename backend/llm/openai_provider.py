"""
OpenAI LLM provider for RAGScope.

Wraps the OpenAI chat completions and embeddings REST APIs using httpx so
all calls are non-blocking and compatible with the FastAPI async event loop.
Used for guest-tier retrieval (gpt-4o-mini) and dense embedding generation
(text-embedding-3-small). API key is always read from the central settings
object -- never from os.environ directly.
"""

import asyncio

import httpx

from backend.core.config import settings
from backend.llm.base import BaseLLMProvider, register

# Base URL for all OpenAI REST endpoints.
_OPENAI_API_BASE = "https://api.openai.com/v1"


@register
class OpenAIProvider(BaseLLMProvider):
    """
    Concrete LLM provider that calls OpenAI's APIs.

    Implements both complete() (chat completions via gpt-4o-mini) and
    embed() (dense vectors via text-embedding-3-small). A new httpx
    AsyncClient is created per call rather than shared, so instances of
    this class carry no mutable state and are safe to construct anywhere.
    """

    name: str = "openai"
    display_name: str = "OpenAI"

    async def complete(self, prompt: str) -> str:
        """
        Send a prompt to gpt-4o-mini and return the completion text.

        Wraps the OpenAI chat completions endpoint. The prompt is sent as a
        single user message; no system message is added here -- callers are
        responsible for including any system instructions in the prompt string
        they pass in.

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

        # timeout=None disables httpx's anyio-based CancelScope which raises
        # "Timeout should be used inside a task" when called from a plain
        # asyncio event loop (our background task). asyncio.wait_for provides
        # equivalent timeout protection using asyncio's native cancellation.
        async with httpx.AsyncClient(timeout=None) as client:
            response = await asyncio.wait_for(
                client.post(
                    f"{_OPENAI_API_BASE}/chat/completions",
                    headers=headers,
                    json=payload,
                ),
                timeout=30.0,
            )
            response.raise_for_status()

        data = response.json()
        # The choices array always has at least one entry when status is 200.
        return data["choices"][0]["message"]["content"].strip()

    async def embed(self, text: str) -> list[float]:
        """
        Convert text into a dense vector using text-embedding-3-small.

        Calls the OpenAI embeddings endpoint. The returned vector has 1536
        dimensions and is suitable for cosine similarity search in pgvector.

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

        async with httpx.AsyncClient(timeout=None) as client:
            response = await asyncio.wait_for(
                client.post(
                    f"{_OPENAI_API_BASE}/embeddings",
                    headers=headers,
                    json=payload,
                ),
                timeout=30.0,
            )
            response.raise_for_status()

        data = response.json()
        # data["data"] is a list; index 0 holds the embedding for the single
        # input string we sent.
        return data["data"][0]["embedding"]
