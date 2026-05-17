"""Centralized settings.

Validated on import. In any environment other than ``development``, the
process refuses to start if SESSION_SECRET is missing or still a
placeholder, or if ALLOWED_ORIGINS is ``*``.
"""

from __future__ import annotations

from typing import List, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_PLACEHOLDER_SECRETS = {"", "change-me", "change-me-in-production"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: Literal["development", "staging", "production"] = "development"

    apple_client_id: str = "com.memoriesscanner.app"
    session_secret: str = "change-me-in-production"

    allowed_origins: str = "*"
    max_upload_bytes: int = Field(default=15 * 1024 * 1024, ge=1)

    # Comma-separated Host: header allowlist. Empty disables
    # TrustedHostMiddleware (dev / testing).
    trusted_hosts_raw: str = Field(default="", alias="TRUSTED_HOSTS")

    sentry_dsn: str = ""

    @field_validator("session_secret")
    @classmethod
    def _reject_placeholder_secret(cls, v: str, info) -> str:
        env = info.data.get("env", "development")
        if env != "development" and v.strip() in _PLACEHOLDER_SECRETS:
            raise ValueError(
                "SESSION_SECRET must be set to a real value in non-dev environments"
            )
        return v

    @field_validator("allowed_origins")
    @classmethod
    def _reject_wildcard_in_prod(cls, v: str, info) -> str:
        env = info.data.get("env", "development")
        if env == "production" and v.strip() == "*":
            raise ValueError(
                "ALLOWED_ORIGINS must be an explicit list in production"
            )
        return v

    @property
    def cors_origins(self) -> List[str]:
        raw = self.allowed_origins.strip()
        if raw == "*":
            return ["*"]
        return [o.strip() for o in raw.split(",") if o.strip()]

    @property
    def trusted_hosts(self) -> List[str]:
        return [h.strip() for h in self.trusted_hosts_raw.split(",") if h.strip()]


_cached: Settings | None = None


def get_settings() -> Settings:
    """Return the process-wide Settings, constructing on first use.

    Lazy so tests can monkeypatch env vars and call get_settings.cache_clear-
    style (via reset_settings) without paying import-time validation.
    """
    global _cached
    if _cached is None:
        _cached = Settings()
    return _cached


def reset_settings() -> None:
    global _cached
    _cached = None
