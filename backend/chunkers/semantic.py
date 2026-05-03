"""
Semantic text chunker for RAGScope.

Splits documents at natural topic boundaries by embedding each sentence and
measuring cosine similarity between adjacent sentences. A drop in similarity
signals a topic shift and triggers a chunk boundary. Unlike fixed-size
chunking, chunk boundaries here align with meaning rather than token counts.

This chunker calls the OpenAI embeddings API once per sentence, so it is
slower than fixed-size chunking and consumes API credits. It is the
appropriate choice when corpus documents have distinct thematic sections.
"""

import asyncio
import math
import re
from typing import Optional

from backend.chunkers.base import BaseChunker, register
from backend.llm.openai_provider import OpenAIProvider


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """
    Compute the cosine similarity between two embedding vectors.

    Returns a value between -1.0 and 1.0, where 1.0 means the vectors point
    in the same direction (highly similar) and 0.0 means orthogonal (unrelated).
    Negative values are theoretically possible but rare for text embeddings.

    Parameters
    ----------
    a, b : list[float]
        Dense embedding vectors of equal length.

    Returns
    -------
    float
        Cosine similarity score. Returns 0.0 if either vector has zero magnitude
        to avoid division by zero.
    """
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _split_sentences(text: str) -> list[str]:
    """
    Split a block of text into individual sentences.

    Uses a lookbehind regex to split after sentence-ending punctuation (.!?)
    followed by whitespace. This is not a full NLP sentence tokeniser -- it
    handles the common English case well enough for a benchmarking context.

    Parameters
    ----------
    text : str
        Input text, potentially multi-sentence.

    Returns
    -------
    list[str]
        Individual sentences, stripped of leading and trailing whitespace.
        Empty strings are removed.
    """
    # Split after . ! or ? when followed by one or more whitespace characters.
    # The lookbehind (?<=[.!?]) matches the position after the punctuation
    # without consuming it, so the punctuation stays on the left sentence.
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [s.strip() for s in parts if s.strip()]


@register
class SemanticChunker(BaseChunker):
    """
    Chunker that places boundaries at topic-shift points in the text.

    Embeds each sentence via the OpenAI embeddings API and inserts a chunk
    boundary wherever the cosine similarity between adjacent sentence embeddings
    drops below similarity_threshold. Segments shorter than min_chunk_size
    tokens are merged forward into the next segment to avoid tiny chunks.

    The llm_provider constructor argument exists for testability: tests inject
    a mock provider so no real API calls are made. Production code leaves it
    as None and the chunker creates a real OpenAIProvider internally.
    """

    name: str = "semantic"
    display_name: str = "Semantic"

    param_schema: list[dict] = [
        {
            "name": "similarity_threshold",
            "type": "float",
            "default": 0.5,
            "min": 0.0,
            "max": 1.0,
            "description": (
                "Cosine similarity below which a chunk boundary is inserted. "
                "Lower values produce fewer, larger chunks; higher values split "
                "more aggressively on subtle topic shifts."
            ),
        },
        {
            "name": "min_chunk_size",
            "type": "int",
            "default": 100,
            "min": 10,
            "max": 500,
            "description": (
                "Minimum number of tokens a chunk must contain. Segments that "
                "fall below this floor are merged with the following segment."
            ),
        },
    ]

    def __init__(
        self,
        similarity_threshold: float = 0.5,
        min_chunk_size: int = 100,
        llm_provider: Optional[object] = None,
    ) -> None:
        """
        Initialise the chunker with user-supplied or default parameters.

        Parameters
        ----------
        similarity_threshold : float
            Cosine similarity cutoff for inserting a boundary. Defaults to 0.5.
        min_chunk_size : int
            Minimum token count per output chunk. Defaults to 100.
        llm_provider : object, optional
            An object with an async embed(text: str) -> list[float] method.
            If None, a new OpenAIProvider is created when chunk() is called.
            Pass a mock here in tests to avoid live API calls.
        """
        self.similarity_threshold = similarity_threshold
        self.min_chunk_size = min_chunk_size
        # Store the provider reference. None signals "create lazily on first use".
        self._provider = llm_provider

    async def chunk(self, texts: list[str]) -> list[str]:
        """
        Split texts into semantically coherent chunks using embedding similarity.

        Embeds every sentence in parallel (asyncio.gather), then walks the
        similarity scores to find topic boundaries. Segments below the
        min_chunk_size floor are merged forward into the next segment.

        Parameters
        ----------
        texts : list[str]
            Text segments from the ingestor, in document order.

        Returns
        -------
        list[str]
            Variable-length chunks aligned to topic boundaries, each at least
            min_chunk_size tokens long (except possibly the final chunk).
        """
        if not texts:
            return []

        provider = self._provider if self._provider is not None else OpenAIProvider()

        # Collect every sentence across all input segments, preserving order.
        sentences: list[str] = []
        for text in texts:
            sentences.extend(_split_sentences(text))

        if not sentences:
            return []

        # Single-sentence documents have no boundaries to detect.
        if len(sentences) == 1:
            return [sentences[0]]

        # Embed all sentences in parallel. asyncio.gather fires every coroutine
        # concurrently and returns results in the same order as the inputs.
        embeddings: list[list[float]] = await asyncio.gather(
            *[provider.embed(s) for s in sentences]
        )

        # Walk adjacent embedding pairs and record where similarity drops below
        # the threshold. boundary_before[i] is True means "start a new chunk
        # before sentence i".
        boundary_before: list[bool] = [False] * len(sentences)
        for i in range(1, len(sentences)):
            sim = _cosine_similarity(embeddings[i - 1], embeddings[i])
            if sim < self.similarity_threshold:
                boundary_before[i] = True

        # Group sentences into segments using the boundary flags.
        segments: list[str] = []
        current_sentences: list[str] = [sentences[0]]
        for i in range(1, len(sentences)):
            if boundary_before[i]:
                segments.append(" ".join(current_sentences))
                current_sentences = [sentences[i]]
            else:
                current_sentences.append(sentences[i])
        # Flush the last group.
        if current_sentences:
            segments.append(" ".join(current_sentences))

        # Merge segments that are below the minimum token floor into the
        # following segment so the LLM always receives adequately-sized chunks.
        merged: list[str] = []
        buffer = ""
        for seg in segments:
            if not buffer:
                buffer = seg
            elif len(buffer.split()) < self.min_chunk_size:
                # Buffer is still too small -- absorb the next segment.
                buffer = buffer + " " + seg
            else:
                merged.append(buffer)
                buffer = seg
        if buffer:
            merged.append(buffer)

        return merged
