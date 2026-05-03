"""
Document ingestor registry loader.

Importing this module makes all ingestors available to the rest of the
application. Each import below triggers the @register decorator on the concrete
ingestor class inside that module, which inserts it into the registry dict in
backend.ingest.base. No other file needs to know the names of individual
ingestor modules.

This module is imported once at application startup. After that, any code that
needs the populated registry imports it directly from backend.ingest.base.
"""

# These imports are intentionally side-effect-only: we do not use the module
# objects directly, but importing them causes their @register decorators to run,
# which populates backend.ingest.base.registry.
from backend.ingest import pdf, txt

# Re-export the populated registry so callers can do:
#   from backend.ingest.registry import registry
# instead of having to know that the dict lives in base.py.
from backend.ingest.base import registry

__all__ = ["registry"]
