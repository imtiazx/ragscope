"""
Fixed-size text chunker for RAGScope.

Splits documents into chunks of a fixed token count (using whitespace
tokenization) with a configurable overlap between consecutive chunks. This
is the simplest and fastest chunking strategy and serves as the baseline
for benchmark comparisons.

Overlap prevents sentences that straddle chunk boundaries from being split
across two chunks where they would match poorly against any query.
"""

from backend.chunkers.base import BaseChunker, register


@register
class FixedSizeChunker(BaseChunker):
    """
    Chunker that splits text into fixed-width token windows with overlap.

    Token count is approximated by whitespace splitting -- each whitespace-
    delimited word is treated as one token. This avoids a dependency on a
    subword tokenizer while producing chunk sizes that are close enough to
    actual token counts for benchmarking purposes.

    The param_schema class attribute describes every tunable parameter in a
    format the frontend can use to build a configuration form dynamically.
    """

    name: str = "fixed_size"
    display_name: str = "Fixed Size"

    # Each dict in param_schema describes one constructor parameter.
    # The API returns this list verbatim so the frontend knows what form
    # fields to render, what types to validate, and what range to allow.
    param_schema: list[dict] = [
        {
            "name": "chunk_size",
            "type": "int",
            "default": 512,
            "min": 64,
            "max": 2048,
            "description": (
                "Number of tokens per chunk. Smaller values give more precise "
                "retrieval; larger values preserve more context per chunk."
            ),
        },
        {
            "name": "overlap",
            "type": "int",
            "default": 50,
            "min": 0,
            "max": 200,
            "description": (
                "Number of tokens shared between the end of one chunk and the "
                "start of the next. Prevents sentences at boundaries from being "
                "split across two chunks."
            ),
        },
    ]

    def __init__(self, chunk_size: int = 512, overlap: int = 50) -> None:
        """
        Initialise the chunker with user-supplied or default parameters.

        Parameters
        ----------
        chunk_size : int
            Maximum number of tokens per chunk. Defaults to 512.
        overlap : int
            Number of tokens that consecutive chunks share. Must be less than
            chunk_size. Defaults to 50.

        Raises
        ------
        ValueError
            If overlap is greater than or equal to chunk_size, which would
            cause an infinite loop or zero-length steps.
        """
        if overlap >= chunk_size:
            raise ValueError(
                f"overlap ({overlap}) must be less than chunk_size ({chunk_size})"
            )
        self.chunk_size = chunk_size
        self.overlap = overlap

    async def chunk(self, texts: list[str]) -> list[str]:
        """
        Split a list of text segments into fixed-size overlapping chunks.

        All text segments are joined into a single string before splitting so
        that chunks are not artificially constrained to page or section
        boundaries imposed by the ingestor.

        Parameters
        ----------
        texts : list[str]
            Text segments from the ingestor, in document order.

        Returns
        -------
        list[str]
            Overlapping chunks in document order. The last chunk may be
            shorter than chunk_size if the document does not divide evenly.
        """
        if not texts:
            return []

        # Join all segments with a newline so page breaks are represented as
        # whitespace (and therefore produce a token boundary) rather than
        # being silently merged.
        full_text = "\n".join(texts)

        # Whitespace tokenisation: each word-like unit separated by any
        # whitespace (spaces, tabs, newlines) counts as one token.
        tokens = full_text.split()

        if not tokens:
            return []

        chunks: list[str] = []
        # step is how far the window advances for each new chunk.
        # With overlap=50 and chunk_size=512, step=462: the next chunk starts
        # 462 tokens after the previous one, sharing the last 50.
        step = self.chunk_size - self.overlap

        start = 0
        while start < len(tokens):
            chunk_tokens = tokens[start : start + self.chunk_size]
            chunks.append(" ".join(chunk_tokens))
            start += step

        return chunks
