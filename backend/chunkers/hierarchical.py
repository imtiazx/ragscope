"""
Hierarchical text chunker for RAGScope.

Creates two levels of chunks from each document: large parent chunks for
broad context and small child chunks for precise retrieval. The vector store
indexes child chunks; when a child is retrieved, the retrieval layer can
look up its parent chunk to give the LLM richer surrounding context.

This two-level design solves the fundamental tension in RAG: small chunks
improve retrieval precision, but large chunks give the LLM more context to
work with when generating an answer.
"""

from backend.chunkers.base import BaseChunker, register


def _split_by_tokens(text: str, chunk_size: int) -> list[str]:
    """
    Split text into non-overlapping fixed-size token windows.

    Helper shared by both the parent and child splitting passes. No overlap
    is used here because hierarchical chunking relies on the parent/child
    relationship for context -- overlap is unnecessary at each level.

    Parameters
    ----------
    text : str
        Input text to split.
    chunk_size : int
        Maximum number of whitespace-delimited tokens per output chunk.

    Returns
    -------
    list[str]
        List of chunk strings. The final chunk may be shorter than chunk_size.
    """
    tokens = text.split()
    if not tokens:
        return []
    chunks = []
    for start in range(0, len(tokens), chunk_size):
        chunks.append(" ".join(tokens[start : start + chunk_size]))
    return chunks


@register
class HierarchicalChunker(BaseChunker):
    """
    Chunker that produces a two-level parent/child chunk hierarchy.

    Parent chunks (default 1024 tokens) provide broad document context.
    Child chunks (default 256 tokens) are sub-divisions of their parent and
    are what gets indexed in pgvector.

    After chunk() returns, two instance attributes are populated:
      - self.parent_chunks: list[str] -- the parent-level chunks in order.
      - self.child_to_parent: list[int] -- for child chunk at index i,
        child_to_parent[i] is the index into parent_chunks of its parent.

    The retrieval layer can use these to expand a retrieved child back to its
    parent context before sending text to the LLM.

    NOTE: The mechanism by which the retrieval layer surfaces parent context
    to the LLM is pending design approval. See the parent context proposal
    in the task notes. The data structures above are populated regardless so
    that any approved approach has the information it needs.
    """

    name: str = "hierarchical"
    display_name: str = "Hierarchical"

    param_schema: list[dict] = [
        {
            "name": "parent_chunk_size",
            "type": "int",
            "default": 1024,
            "min": 256,
            "max": 4096,
            "description": (
                "Token size of parent chunks. Each parent is the broad context "
                "window that the LLM receives when one of its child chunks is "
                "retrieved."
            ),
        },
        {
            "name": "child_chunk_size",
            "type": "int",
            "default": 256,
            "min": 64,
            "max": 1024,
            "description": (
                "Token size of child chunks. These are indexed in the vector "
                "store and used for retrieval. Must be smaller than "
                "parent_chunk_size."
            ),
        },
    ]

    def __init__(
        self, parent_chunk_size: int = 1024, child_chunk_size: int = 256
    ) -> None:
        """
        Initialise the chunker with user-supplied or default parameters.

        Parameters
        ----------
        parent_chunk_size : int
            Token size of each parent chunk. Defaults to 1024.
        child_chunk_size : int
            Token size of each child chunk. Must be less than parent_chunk_size.
            Defaults to 256.

        Raises
        ------
        ValueError
            If child_chunk_size is greater than or equal to parent_chunk_size,
            which would make the hierarchy meaningless.
        """
        if child_chunk_size >= parent_chunk_size:
            raise ValueError(
                f"child_chunk_size ({child_chunk_size}) must be less than "
                f"parent_chunk_size ({parent_chunk_size})"
            )
        self.parent_chunk_size = parent_chunk_size
        self.child_chunk_size = child_chunk_size

        # These are populated as a side effect of calling chunk().
        # They are empty until chunk() runs for the first time.
        self.parent_chunks: list[str] = []
        self.child_to_parent: list[int] = []

    async def chunk(self, texts: list[str]) -> list[str]:
        """
        Split texts into a two-level hierarchy and return the child chunks.

        Populates self.parent_chunks and self.child_to_parent as side effects
        so the retrieval layer can resolve child-to-parent relationships after
        this method returns.

        Parameters
        ----------
        texts : list[str]
            Text segments from the ingestor, in document order.

        Returns
        -------
        list[str]
            Flat list of child chunk strings in document order. These are the
            units that get embedded and stored in pgvector.
        """
        if not texts:
            self.parent_chunks = []
            self.child_to_parent = []
            return []

        full_text = "\n".join(texts)

        # First pass: split into parent chunks.
        self.parent_chunks = _split_by_tokens(full_text, self.parent_chunk_size)

        # Second pass: split each parent into children and record the mapping.
        all_children: list[str] = []
        self.child_to_parent = []

        for parent_idx, parent_text in enumerate(self.parent_chunks):
            children = _split_by_tokens(parent_text, self.child_chunk_size)
            for child in children:
                all_children.append(child)
                # Every child produced from this parent gets the same parent index.
                self.child_to_parent.append(parent_idx)

        return all_children
