"""
Anthropic LLM provider for RAGScope.

Wraps the Anthropic Messages REST API using httpx so all calls are
non-blocking and compatible with the FastAPI async event loop. Used by
Tier 2 BYOK users who supply their own Anthropic key. Only the complete()
method is supported -- Anthropic does not provide a public embeddings API,
so embed() raises NotImplementedError. API key is always read from the
central settings object, never from os.environ directly.
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

    Implements complete() using claude-haiku-3, the cheapest Anthropic model,
    which is appropriate for the high call volume of BYOK retrieval strategies.
    Does not implement embed() because Anthropic does not offer an embeddings
    endpoint -- callers that need embeddings must use OpenAIProvider instead.
    """

    name: str = "anthropic"
    display_name: str = "Anthropic"

    async def complete(self, prompt: str) -> str:
        """
        Send a prompt to claude-haiku-3 and return the completion text.

        Wraps the Anthropic Messages endpoint. The prompt is sent as a single
        user message. Anthropic's API requires the messages array to alternate
        between user and assistant roles; sending a single user message is the
        simplest valid form.

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
        # Anthropic's response shape: {"content": [{"type": "text", "text": "..."}]}
        # The content array can contain multiple blocks (e.g. tool_use + text),
        # so we find the first block whose type is "text".
        for block in data["content"]:
            if block["type"] == "text":
                return block["text"].strip()

        # Should never happen for a plain text completion, but fail loudly if
        # the response shape changes unexpectedly.
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
