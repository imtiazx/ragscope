"""
Base class and registration machinery for text chunkers.

Defines BaseChunker, the abstract class every chunking strategy must extend,
and the @register decorator that makes chunkers auto-discoverable by the ingest
pipeline without hardcoding strategy names anywhere else in the codebase.

A chunker sits between the ingestor (which extracts raw text) and the embedder
(which produces vectors). Its sole job is to split text into pieces small enough
to embed and retrieve meaningfully. It has no knowledge of file formats, vectors,
or databases.
"""

from abc import ABC, abstractmethod

# Global registry mapping chunker name strings to their implementing classes.
# Populated at import time when each chunker module is imported by registry.py.
registry: dict[str, type["BaseChunker"]] = {}


def register(cls: type["BaseChunker"]) -> type["BaseChunker"]:
    """
    Class decorator that registers a chunker in the module-level registry.

    Must be applied after the class body is fully defined so that `cls.name`
    is already set when the decorator runs.

    Parameters
    ----------
    cls : type[BaseChunker]
        The concrete chunker class. Must have a `name` class attribute set.

    Returns
    -------
    type[BaseChunker]
        The same class, unmodified, so it can still be referenced by name
        in the module where it is defined.
    """
    # Enforce the param_schema contract at registration time rather than at
    # runtime so a missing schema surfaces immediately on import, not later
    # when the API tries to serve it. Checking cls.__dict__ (not hasattr)
    # ensures the concrete class defines its own value rather than relying
    # on the bare annotation inherited from BaseChunker.
    if "param_schema" not in cls.__dict__:
        raise TypeError(
            f"{cls.__name__} must define a 'param_schema' class attribute. "
            "Add a param_schema = [...] list to the class body."
        )
    # Key by cls.name so the ingest pipeline can select a chunker by the
    # strategy string supplied in the API request.
    registry[cls.name] = cls
    return cls


class BaseChunker(ABC):
    """
    Abstract base class for all text chunking strategies.

    Receives the list of text strings produced by an ingestor and returns a
    flat list of chunk strings ready to be embedded and stored in pgvector.
    Chunkers operate purely on text -- they have no access to the database,
    the LLM, or the filesystem.

    Accepting a list rather than a single string allows the chunker to process
    all pages or sections of a document in one call, which matters for chunkers
    that need cross-boundary context (e.g. hierarchical chunking that reads
    surrounding paragraphs).
    """

    # Short machine-readable identifier used as the registry key
    # (e.g. "fixed_size", "semantic", "hierarchical").
    name: str

    # Human-readable label shown in the benchmark UI chunker selector.
    display_name: str

    # List of parameter descriptors for this chunker. Every concrete subclass
    # must define this as a class attribute (not just inherit the annotation).
    # Each dict must contain: name, type, default, min, max, description.
    # The API returns this list verbatim so the frontend can build its
    # configuration form without any hardcoded knowledge of chunker parameters.
    param_schema: list[dict]

    @abstractmethod
    async def chunk(self, texts: list[str]) -> list[str]:
        """
        Split a list of text segments into a flat list of chunks.

        The method is async for interface consistency. Chunkers that call an
        LLM to determine split boundaries (e.g. semantic chunking via embeddings)
        need genuine async I/O. Simple fixed-size chunkers should still be
        declared async and can use plain synchronous logic inside.

        Parameters
        ----------
        texts : list[str]
            Text segments from the ingestor, in document order. Each element
            may be an entire page, section, or the full document depending on
            the ingestor that produced them.

        Returns
        -------
        list[str]
            Flat list of chunk strings in document order. Each chunk should be
            sized appropriately for the embedding model (typically 256-512 tokens
            for text-embedding-3-small). Chunks may overlap -- that is up to
            the concrete implementation.
        """
        ...
