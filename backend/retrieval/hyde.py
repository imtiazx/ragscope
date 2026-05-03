"""
HyDE (Hypothetical Document Embeddings) retrieval strategy for RAGScope.

Instead of embedding the raw query, asks the LLM to generate a plausible
hypothetical answer to the question, then embeds that answer. Because the
hypothetical answer is linguistically similar to real document passages, its
embedding lands closer to relevant chunks in the vector space than the query
embedding would. One LLM completion call and one embedding call are made per
query.

Reference: Gao et al., "Precise Zero-Shot Dense Retrieval without Relevance
Labels", ACL 2023.
"""

import math
import time
from typing import Optional

from backend.llm.openai_provider import OpenAIProvider
from backend.retrieval.base import BaseRetriever, RetrievalResult, register


# Maps the user-facing length setting to the instruction fragment embedded in
# the prompt. "short" reduces LLM latency and cost at the expense of less
# context; "long" provides richer hypothetical context at higher cost.
_LENGTH_INSTRUCTIONS: dict[str, str] = {
    "short": "one or two sentences",
    "medium": "two or three sentences",
    "long": "a detailed paragraph of four to six sentences",
}


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """
    Compute cosine similarity between two dense embedding vectors.

    Returns a value between -1.0 and 1.0. Returns 0.0 if either vector has
    zero magnitude to avoid division by zero.

    Parameters
    ----------
    a, b : list[float]
        Embedding vectors of equal length.

    Returns
    -------
    float
        Cosine similarity score.
    """
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _build_prompt(query: str, length_instruction: str) -> str:
    """
    Build the prompt that instructs the LLM to write a hypothetical answer.

    The prompt explicitly forbids "I don't know" responses -- HyDE requires a
    plausible answer even when the LLM is uncertain, because the goal is to
    produce text that lives in the same embedding space as real document
    passages, not to produce a factually correct answer.

    Parameters
    ----------
    query : str
        The user's original question.
    length_instruction : str
        Natural-language length guidance, e.g. "two or three sentences".

    Returns
    -------
    str
        Prompt string ready to pass to an LLM complete() call.
    """
    return (
        f"Write {length_instruction} as a hypothetical answer to the question below. "
        "Write as if you are drawing on a document that contains the relevant facts. "
        "Do not say you are uncertain or that you lack information -- produce a "
        "plausible, factual-sounding answer regardless.\n\n"
        f"Question: {query}\n\n"
        "Hypothetical answer:"
    )


@register
class HyDeRetriever(BaseRetriever):
    """
    Retriever that searches with a hypothetical answer rather than the raw query.

    Generates a plausible answer via the LLM, embeds it, and runs cosine
    similarity against the corpus -- identical to NaiveRetriever from the
    embedding step onward. The hypothesis generation step is what differentiates
    it and typically improves recall on question-answer style queries.

    corpus format: list of dicts, each with keys:
      - chunk_id (str): unique identifier for the chunk
      - content  (str): raw text of the chunk
      - embedding (list[float]): pre-computed dense vector
    """

    name: str = "hyde"
    display_name: str = "HyDE"
    description: str = (
        "Generates a hypothetical answer to the query, embeds that instead of the "
        "raw question, then retrieves by cosine similarity. Improves recall when "
        "queries and documents are phrased very differently."
    )

    param_schema: list[dict] = [
        {
            "name": "top_k",
            "type": "int",
            "default": 5,
            "min": 1,
            "max": 20,
            "description": (
                "Number of chunks to retrieve. Higher values give the LLM more "
                "context but increase token usage and may introduce noise."
            ),
        },
        {
            "name": "hypothetical_doc_length",
            "type": "enum",
            "default": "medium",
            "min": None,
            "max": None,
            "options": ["short", "medium", "long"],
            "description": (
                "Controls how long the hypothetical answer the LLM generates. "
                "'short' (1-2 sentences) is faster and cheaper; 'long' (4-6 "
                "sentences) gives the embedder more signal at higher latency cost."
            ),
        },
    ]

    def __init__(
        self,
        corpus: list[dict],
        top_k: int = 5,
        hypothetical_doc_length: str = "medium",
        llm_provider: Optional[object] = None,
    ) -> None:
        """
        Initialise the retriever with corpus and configuration.

        Parameters
        ----------
        corpus : list[dict]
            All chunks available for retrieval. Each dict must contain
            chunk_id, content, and embedding keys.
        top_k : int
            Default number of results to return.
        hypothetical_doc_length : str
            One of "short", "medium", or "long". Controls the length
            instruction in the hypothetical-answer generation prompt.
        llm_provider : object, optional
            An object with async complete(prompt: str) -> str and
            async embed(text: str) -> list[float] methods. Defaults to
            a real OpenAIProvider when None. Pass a mock in tests.

        Raises
        ------
        ValueError
            If hypothetical_doc_length is not one of the accepted values.
        """
        if hypothetical_doc_length not in _LENGTH_INSTRUCTIONS:
            raise ValueError(
                f"hypothetical_doc_length must be one of "
                f"{list(_LENGTH_INSTRUCTIONS)}, got {hypothetical_doc_length!r}"
            )
        self.corpus = corpus
        self.top_k = top_k
        self.hypothetical_doc_length = hypothetical_doc_length
        self._provider = llm_provider

    async def retrieve(self, query: str, top_k: int) -> list[RetrievalResult]:
        """
        Generate a hypothetical answer, embed it, and return the top_k chunks.

        Step 1: complete() generates the hypothetical answer.
        Step 2: embed() converts that answer to a vector.
        Step 3: cosine similarity against the corpus (same as NaiveRetriever).

        Latency is measured across all three steps so the benchmark captures
        the full cost of hypothesis generation.

        Parameters
        ----------
        query : str
            The user's original question.
        top_k : int
            Number of chunks to return.

        Returns
        -------
        list[RetrievalResult]
            Up to top_k results ordered by descending cosine similarity score.
            metadata["hypothesis"] carries the generated hypothetical answer
            so the benchmark UI can display it for interpretability.
        """
        t0 = time.perf_counter()

        provider = self._provider if self._provider is not None else OpenAIProvider()

        # Step 1: generate the hypothetical answer using the configured length.
        length_instruction = _LENGTH_INSTRUCTIONS[self.hypothetical_doc_length]
        prompt = _build_prompt(query, length_instruction)
        hypothesis = await provider.complete(prompt)

        # Step 2: embed the hypothesis, not the raw query.
        hypothesis_embedding = await provider.embed(hypothesis)

        # Step 3: rank corpus by similarity to the hypothesis embedding.
        scored: list[tuple[float, dict]] = [
            (_cosine_similarity(hypothesis_embedding, chunk["embedding"]), chunk)
            for chunk in self.corpus
        ]
        scored.sort(key=lambda pair: pair[0], reverse=True)

        latency_ms = (time.perf_counter() - t0) * 1000.0

        return [
            RetrievalResult(
                chunk_id=chunk["chunk_id"],
                content=chunk["content"],
                score=score,
                latency_ms=latency_ms,
                # Carry the hypothesis so the UI can show what the LLM imagined.
                metadata={"hypothesis": hypothesis},
            )
            for score, chunk in scored[:top_k]
        ]
