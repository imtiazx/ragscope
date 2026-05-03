"""
Base class and registration machinery for document ingestors.

Defines BaseIngestor, the abstract class every file-format handler must extend,
and the @register decorator that makes ingestors auto-discoverable by the ingest
router without hardcoding format names anywhere else in the codebase.

An ingestor is responsible only for extracting raw text from raw bytes. It does
not chunk, embed, or store anything -- those responsibilities belong to the
chunker and ingest router layers downstream.
"""

from abc import ABC, abstractmethod

# Global registry mapping ingestor name strings to their implementing classes.
# Populated at import time when each ingestor module is imported by registry.py.
registry: dict[str, type["BaseIngestor"]] = {}


def register(cls: type["BaseIngestor"]) -> type["BaseIngestor"]:
    """
    Class decorator that registers an ingestor in the module-level registry.

    Must be applied after the class body is fully defined so that `cls.name`
    is already set when the decorator runs.

    Parameters
    ----------
    cls : type[BaseIngestor]
        The concrete ingestor class. Must have a `name` class attribute set.

    Returns
    -------
    type[BaseIngestor]
        The same class, unmodified, so it can still be referenced by name
        in the module where it is defined.
    """
    # Key by cls.name so the ingest router can select the right ingestor
    # based on the uploaded file's MIME type or extension.
    registry[cls.name] = cls
    return cls


class BaseIngestor(ABC):
    """
    Abstract base class for all document format ingestors.

    Each concrete subclass handles one file format (PDF, plain text, etc.)
    and converts raw file bytes into a list of text strings. The granularity
    of those strings is up to the ingestor -- a PDF ingestor might return one
    string per page; a plain text ingestor might return the whole document as
    one string. The chunker layer handles further splitting.
    """

    # Short machine-readable identifier used as the registry key
    # (e.g. "pdf", "txt").
    name: str

    # Human-readable label shown in the UI file-type selector.
    display_name: str

    @abstractmethod
    async def ingest(self, data: bytes) -> list[str]:
        """
        Extract text from raw file bytes.

        The method is async because some ingestors may call external parsing
        services over HTTP (e.g. a cloud OCR API for scanned PDFs). Pure
        in-process parsers should still be defined as async for interface
        consistency and run their CPU-bound work in a thread pool executor
        if needed.

        Parameters
        ----------
        data : bytes
            Raw binary content of the uploaded file, exactly as received
            from the HTTP request body.

        Returns
        -------
        list[str]
            Extracted text segments. Each string is a logical unit from the
            source document (e.g. one page, one section). The list preserves
            document order. Strings may still be long -- chunking happens
            downstream in the chunker layer.
        """
        ...
