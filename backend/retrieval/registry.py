"""
Retrieval strategy registry loader.

Importing this module is the single action that makes all retrieval strategies
available to the rest of the application. Each import below triggers the
@register decorator on the concrete class inside that module, which inserts it
into the registry dict in backend.retrieval.base. No other file needs to know
the names of individual strategy modules.

This module is imported once at application startup (e.g. from main.py or the
benchmark router). After that, any code that needs the populated registry
imports it directly from backend.retrieval.base.
"""

# These imports are intentionally side-effect-only: we do not use the module
# objects directly, but importing them causes their @register decorators to run,
# which populates backend.retrieval.base.registry.
from backend.retrieval import naive, hyde, multiquery, hybrid, contextual_compression

# Re-export the populated registry so callers can do:
#   from backend.retrieval.registry import registry
# instead of having to know that the dict lives in base.py.
from backend.retrieval.base import registry

__all__ = ["registry"]
