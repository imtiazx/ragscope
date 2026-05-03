"""
LLM provider registry loader.

Importing this module makes all LLM providers available to the rest of the
application. Each import below triggers the @register decorator on the concrete
provider class inside that module, which inserts it into the registry dict in
backend.llm.base. No other file needs to know the names of individual provider
modules.

This module is imported once at application startup. After that, any code that
needs the populated registry imports it directly from backend.llm.base.
"""

# These imports are intentionally side-effect-only: we do not use the module
# objects directly, but importing them causes their @register decorators to run,
# which populates backend.llm.base.registry.
from backend.llm import openai_provider, anthropic_provider

# Re-export the populated registry so callers can do:
#   from backend.llm.registry import registry
# instead of having to know that the dict lives in base.py.
from backend.llm.base import registry

__all__ = ["registry"]
