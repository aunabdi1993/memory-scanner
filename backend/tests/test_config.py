"""Settings validation."""

from __future__ import annotations

import pytest


def test_dev_defaults_load(monkeypatch):
    monkeypatch.setenv("ENV", "development")
    from config import Settings

    s = Settings()
    assert s.env == "development"
    assert s.cors_origins == ["*"]


def test_production_rejects_placeholder_secret(monkeypatch):
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("SESSION_SECRET", "change-me-in-production")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://memoriesscanner.app")
    from config import Settings

    with pytest.raises(Exception) as exc:
        Settings()
    assert "SESSION_SECRET" in str(exc.value)


def test_production_rejects_wildcard_cors(monkeypatch):
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("ALLOWED_ORIGINS", "*")
    from config import Settings

    with pytest.raises(Exception) as exc:
        Settings()
    assert "ALLOWED_ORIGINS" in str(exc.value)


def test_production_accepts_real_secret_and_origins(monkeypatch):
    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv(
        "ALLOWED_ORIGINS",
        "https://memoriesscanner.app,https://api.memoriesscanner.app",
    )
    from config import Settings

    s = Settings()
    assert s.cors_origins == [
        "https://memoriesscanner.app",
        "https://api.memoriesscanner.app",
    ]
