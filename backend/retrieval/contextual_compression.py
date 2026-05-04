
"""
Contextual compression post-retrieval processor for RAGScope.

WHAT THIS CLASS DOES
--------------------
ContextualCompressor receives a list of already-retrieved RetrievalResult
objects and a query string. For each result, it calls an LLM with a prompt
that asks for only the sentences from the chunk that are directly relevant
to the query. It then replaces the chunk's content field with the compressed
text. Results whose compressed content falls below min_relevance_length
characters are dropped entirely, because near-empty responses indicate the
chunk contained no relevant information.

WHAT THIS CLASS DOES NOT DO
----------------------------
ContextualCompressor does not perform retrieval. It does not embed queries,
compute cosine similarity, run BM25, or touch the vector database. It has
no knowledge of how the chunks it receives were found. It is purely a
transformation applied to an existing result set.

WHY IT DOES NOT EXTEND BaseRetriever
-------------------------------------
BaseRetriever defines a contract for finding chunks: its retrieve() method
accepts a query and a top_k count and returns a ranked list of chunks from
a corpus. ContextualCompressor does not find chunks -- it refines chunks that
were already found. Extending BaseRetriever would force it to accept a corpus
it never uses and implement a retrieve() signature that does not describe what
it does. Inheriting the wrong abstraction creates confusion about the class's
responsibilities and would put it in the retrieval strategy registry, where
users could select it as if it were a standalone retrieval method (it is not).

HOW TO COMBINE IT WITH A RETRIEVAL STRATEGY
--------------------------------------------
The intended usage in the benchmark runner is a two-step pipeline:

    results = await retriever.retrieve(query, top_k=5)
    results = await compressor.compress(results, query)

Any retriever's output is a list[RetrievalResult], which is exactly what
compress() accepts. The compressor is therefore composable with naive,
HyDE, multi-query, and hybrid retrieval without any coupling between them.
The benchmark UI exposes compression as an independent toggle, orthogonal
to the retrieval strategy selector.
"""

import dataclasses
from typing import Optional

from backend.llm.openai_provider import OpenAIProvider
from backend.retrieval.base import RetrievalResult


def _build_compression_prompt(query: str, chunk_content: str) -> str:
    """
    Build the prompt that asks the LLM to extract only query-relevant sentences.

    The prompt instructs the model to return a verbatim subset of the chunk's
    sentences rather than paraphrasing or summarising, so the compressed text
    is always a subset of the original and never introduces hallucinated content.
    If no sentences are relevant, the model is instructed to return the empty
    string rather than fabricating relevance.

    Parameters
    ----------
    query : str
        The original user question that was used to retrieve this chunk.
    chunk_content : str
        The full text of the retrieved chunk to be compressed.

    Returns
    -------
    str
        Prompt string ready to pass to an LLM complete() call.
    """
    return (
        "Given the following question and document passage, extract and return "
        "only the sentences from the passage that directly help answer the "
        "question. Copy the relevant sentences verbatim -- do not paraphrase, "
        "summarise, or add any text of your own. If no sentences are relevant, "
        "return an empty string and nothing else.\n\n"
        f"Question: {query}\n\n"
        f"Passage:\n{chunk_content}\n\n"
        "Relevant sentences (verbatim, or empty string if none):"
    )


class ContextualCompressor:
    """
    Post-retrieval processor that trims each chunk to query-relevant sentences.

    Accepts a list of RetrievalResult objects from any retrieval strategy and
    returns a filtered, compressed version of that list. Chunks that the LLM
    determines contain no relevant content are dropped. Surviving chunks have
    their content field replaced with the compressed text.

    The param_schema class attribute follows the same structure as retriever
    and chunker param_schemas so the frontend API can render the compression
    configuration form using the same code path.
    """

    param_schema: list[dict] = [
        {
            "name": "min_relevance_length",
            "type": "int",
            "default": 50,
            "min": 20,
            "max": 500,
            "description": (
                "Minimum character length a compressed chunk must reach to be "
                "kept. Chunks compressed below this threshold are dropped as "
                "containing no relevant information. Lower values are more "
                "permissive; higher values are more aggressive about filtering."
            ),
        },
    ]

    def __init__(
        self,
        min_relevance_length: int = 50,
        llm_provider: Optional[object] = None,
    ) -> None:
        """
        Initialise the compressor with configuration and an optional provider.

        Parameters
        ----------
        min_relevance_length : int
            Minimum character count for a compressed chunk to survive. A
            chunk compressed to fewer characters than this is dropped.
            Defaults to 50.
        llm_provider : object, optional
            An object with an async complete(prompt: str) -> str method.
            Defaults to a real OpenAIProvider when None. Pass a mock in tests.
        """
        self.min_relevance_length = min_relevance_length
        self._provider = llm_provider

    async def compress(
        self, results: list[RetrievalResult], query: str
    ) -> list[RetrievalResult]:
        """
        Compress each retrieved chunk to only the sentences relevant to query.

        For each result, calls the LLM once with a prompt asking it to extract
        verbatim relevant sentences. Results whose compressed content is shorter
        than min_relevance_length are discarded. Surviving results are returned
        as new RetrievalResult objects with updated content and compression
        metadata; the original score, chunk_id, and latency_ms are preserved.

        Parameters
        ----------
        results : list[RetrievalResult]
            Output from any retrieval strategy -- naive, HyDE, multi-query,
            or hybrid. The order is preserved in the output.
        query : str
            The original user question, used to guide the compression prompt.

        Returns
        -------
        list[RetrievalResult]
            Filtered and compressed results in the same order as the input.
            May be shorter than the input if some chunks were dropped.
            Each surviving result has:
              - content: replaced with the compressed text
              - metadata["original_content"]: the full pre-compression text
              - metadata["compression_ratio"]: float, compressed/original chars
        """
        # complete_sync() uses httpx.Client (blocking). This method runs inside
        # _run_evaluation_async on a plain asyncio event loop with no anyio
        # task scope; AsyncClient.__aenter__ requires anyio.
        provider = self._provider if self._provider is not None else OpenAIProvider()

        compressed: list[RetrievalResult] = []

        for result in results:
            prompt = _build_compression_prompt(query, result.content)
            compressed_text = provider.complete_sync(prompt)
            compressed_text = compressed_text.strip()

            # Drop chunks whose compressed form is below the relevance floor.
            # A near-empty response means the LLM found nothing relevant in
            # the chunk -- keeping it would pass noise to the answer model.
            if len(compressed_text) < self.min_relevance_length:
                continue

            original_length = len(result.content)
            ratio = len(compressed_text) / original_length if original_length > 0 else 0.0

            # dataclasses.replace() creates a new RetrievalResult with only the
            # specified fields changed. This preserves chunk_id, score, and
            # latency_ms from the original while updating content and metadata.
            updated_metadata = {
                **result.metadata,
                "original_content": result.content,
                "compression_ratio": ratio,
            }
            compressed.append(
                dataclasses.replace(
                    result,
                    content=compressed_text,
                    metadata=updated_metadata,
                )
            )

        return compressed
