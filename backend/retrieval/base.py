"""
Base classes and registration machinery for retrieval strategies.

Defines the RetrievalResult data container, the BaseRetriever abstract class
that every retrieval strategy must extend, and the @register decorator that
makes strategies auto-discoverable by the API and benchmark runner without
hardcoding any strategy names anywhere else in the codebase.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

# Global registry mapping strategy name strings to their implementing classes.
# Populated at import time by the @register decorator on each concrete class.
# Retrieved by the benchmark router to enumerate available strategies.
registry: dict[str, type["BaseRetriever"]] = {}


def register(cls: type["BaseRetriever"]) -> type["BaseRetriever"]:
    """
    Class decorator that registers a retriever in the module-level registry.

    Decorating a class with @register adds it to the `registry` dict under
    its `name` attribute. This happens once at import time, so importing the
    module that defines the class is sufficient to make it discoverable.

    Parameters
    ----------
    cls : type[BaseRetriever]
        The concrete retriever class being registered. Must have a `name`
        class attribute set before the decorator runs.

    Returns
    -------
    type[BaseRetriever]
        The same class, unmodified. Returning `cls` lets the decorator be
        stacked with others and lets the class still be used by name.
    """
    # Enforce param_schema at registration time so a missing schema raises
    # immediately on import rather than silently failing when the API tries
    # to serve it. Checking cls.__dict__ (not hasattr) ensures the concrete
    # class defines its own value rather than inheriting the bare annotation.
    if "param_schema" not in cls.__dict__:
        raise TypeError(
            f"{cls.__name__} must define a 'param_schema' class attribute. "
            "Add a param_schema = [...] list to the class body."
        )
    # cls.name is the string key callers use to select this strategy at runtime.
    registry[cls.name] = cls
    return cls


@dataclass
class RetrievalResult:
    """
    Immutable result container returned by every retrieval strategy.

    Carries everything the benchmark runner and eval pipeline need about a
    single retrieved chunk: its identity, content, relevance score, how long
    it took to retrieve, and any extra metadata the strategy wants to attach.
    """

    # Database identifier for the chunk, used to deduplicate results across
    # multi-query or hybrid strategies that may return the same chunk twice.
    chunk_id: str

    # Raw text content of the retrieved chunk, passed directly to the LLM context.
    content: str

    # Relevance score assigned by the retrieval method (cosine similarity for
    # dense, BM25 score for sparse, RRF-fused score for hybrid). Higher is more
    # relevant; scale varies by strategy.
    score: float

    # Wall-clock time in milliseconds for the retrieve() call that produced this
    # result. Measured with time.perf_counter() per the project hard rules.
    latency_ms: float

    # Optional extra data the strategy wants to surface (e.g. which sub-query
    # produced this chunk in multi-query, or the compression ratio in contextual
    # compression). field(default_factory=dict) is required for mutable defaults
    # in dataclasses -- using `= {}` would share one dict across all instances.
    metadata: dict = field(default_factory=dict)


class BaseRetriever(ABC):
    """
    Abstract base class for all retrieval strategies.

    Every retrieval strategy in backend/retrieval/ must subclass this and
    decorate itself with @register. Subclasses must set the three class
    attributes and implement retrieve(). The API and benchmark runner discover
    strategies by iterating the registry dict rather than importing concrete
    classes directly, so adding a new strategy requires no changes outside
    its own module.
    """

    # Short machine-readable identifier used as the registry key and in API
    # responses (e.g. "naive", "hyde"). Must be unique across all strategies.
    name: str

    # Human-readable label shown in the benchmark UI (e.g. "Naive RAG").
    display_name: str

    # One-sentence explanation of how this strategy works, shown in the UI
    # tooltip next to the strategy selector.
    description: str

    # List of parameter descriptors for this retriever. Every concrete subclass
    # must define this as a class attribute (not just inherit the annotation).
    # Each dict must contain: name, type, default, min, max, description.
    # The API returns this list verbatim so the frontend can render the
    # configuration form for this strategy without any hardcoded knowledge
    # of strategy-specific parameters.
    param_schema: list[dict]

    @abstractmethod
    async def retrieve(self, query: str, top_k: int) -> list[RetrievalResult]:
        """
        Retrieve the most relevant chunks for the given query.

        Parameters
        ----------
        query : str
            The user's search query or question.
        top_k : int
            Maximum number of chunks to return.

        Returns
        -------
        list[RetrievalResult]
            Retrieved chunks ordered by descending relevance score.
            May return fewer than top_k results if the corpus is small.
        """
        ...
