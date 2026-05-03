"""
Text chunker registry loader.

Importing this module makes all chunking strategies available to the rest of
the application. Each import below triggers the @register decorator on the
concrete chunker class inside that module, which inserts it into the registry
dict in backend.chunkers.base. No other file needs to know the names of
individual chunker modules.

This module is imported once at application startup. After that, any code that
needs the populated registry imports it directly from backend.chunkers.base.
"""

# These imports are intentionally side-effect-only: we do not use the module
# objects directly, but importing them causes their @register decorators to run,
# which populates backend.chunkers.base.registry.
from backend.chunkers import fixed_size, semantic, hierarchical

# Re-export the populated registry so callers can do:
#   from backend.chunkers.registry import registry
# instead of having to know that the dict lives in base.py.
from backend.chunkers.base import registry

__all__ = ["registry"]
