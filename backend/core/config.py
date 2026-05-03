"""
Central configuration module for RAGScope.

This is the only place in the codebase that reads environment variables.
Every other module imports the `settings` instance from here rather than
calling os.environ or python-dotenv directly, so there is one canonical
source of truth for all runtime configuration.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Application settings loaded from environment variables and the .env file.

    pydantic-settings maps each field name to its uppercase environment variable
    counterpart automatically (e.g. `openai_api_key` reads OPENAI_API_KEY).
    Fields default to empty strings so the app starts without crashing in
    environments where optional keys are not yet configured.
    """

    # model_config tells pydantic-settings where to look for values.
    # env_file=".env" loads the local dev file when it exists; real env vars
    # always take precedence over the file, so prod deployments are unaffected.
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # Used for guest-tier retrieval and as the RAGAS judge (gpt-4o-mini).
    openai_api_key: str = ""

    # Optional server-side Anthropic key. Tier 2 BYOK users supply their own
    # key via the browser and never touch this field.
    anthropic_api_key: str = ""

    # Supabase postgres connection string (prod) or local Docker URL (dev).
    supabase_url: str = ""

    # Supabase service role key -- grants full DB access, never expose publicly.
    supabase_key: str = ""

    # LangSmith API key for trace export.
    langchain_api_key: str = ""

    # When True, every LLM call is traced to LangSmith.
    # pydantic coerces the string "true" from the env file to Python True.
    langchain_tracing_v2: bool = False

    # LangSmith project name that groups all traces for this app.
    langchain_project: str = "ragscope"

    # Secret token for Tier 0 dev bypass. Never commit a real value.
    dev_token: str = ""

    # Maximum combined size of all files in a single ingest request, in bytes.
    # 10 MB default matches the Tier 1 guest limit in CLAUDE.md.
    max_file_size_bytes: int = 10 * 1024 * 1024


# Module-level singleton. Import this instance everywhere; never instantiate
# Settings again elsewhere, as that would re-read the environment unnecessarily.
settings = Settings()
