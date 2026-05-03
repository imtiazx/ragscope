"""
Tests for the LLM provider registry and provider class structure.

These tests verify the registry wiring and class shape without making any live
API calls. They import the registry (which triggers all @register decorators),
then confirm that the expected providers are present and behave correctly as
objects. httpx is never invoked here -- complete() and embed() are not called
except where the method raises synchronously without touching the network.
"""

import pytest

# Importing registry is what actually populates it: the import chain is
# registry.py -> openai_provider.py + anthropic_provider.py -> @register runs
# on each class -> registry dict is filled. If this import fails, all tests
# below fail immediately with a clear ImportError rather than confusing
# AttributeErrors.
from backend.llm.registry import registry


def test_registry_is_not_empty():
    """Registry must contain at least one provider after import."""
    assert len(registry) > 0


def test_openai_provider_is_registered():
    """The string key 'openai' must be present in the registry."""
    assert "openai" in registry


def test_anthropic_provider_is_registered():
    """The string key 'anthropic' must be present in the registry."""
    assert "anthropic" in registry


def test_openai_provider_name_attribute():
    """
    Instantiating OpenAIProvider via the registry must yield an object whose
    name attribute matches the key used to look it up.
    """
    # registry["openai"] is the class itself. Calling it with () constructs
    # an instance the same way you would call OpenAIProvider() directly.
    provider = registry["openai"]()
    assert provider.name == "openai"


def test_anthropic_provider_name_attribute():
    """
    Instantiating AnthropicProvider via the registry must yield an object
    whose name attribute matches the key used to look it up.
    """
    provider = registry["anthropic"]()
    assert provider.name == "anthropic"


@pytest.mark.asyncio
async def test_anthropic_embed_raises_not_implemented():
    """
    AnthropicProvider.embed() must raise NotImplementedError synchronously,
    because Anthropic has no embeddings endpoint. This is a contract test:
    any retrieval strategy that calls embed() on an arbitrary provider needs
    to know that this method can raise rather than silently returning nothing.
    """
    provider = registry["anthropic"]()
    with pytest.raises(NotImplementedError):
        await provider.embed("some text")
