"""Hardening checks: UUID path-param validation, upload size cap.

Rate limiting is exercised in a separate suite because slowapi has
module-level limiter state that's awkward to reset between tests.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("SESSION_SECRET", "test-secret-do-not-use-in-prod")
    monkeypatch.setenv("APPLE_CLIENT_ID", "com.test.app")
    monkeypatch.setenv("MAX_UPLOAD_BYTES", str(1024))  # 1 KB cap for tests
    monkeypatch.setenv("UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("PROCESSED_DIR", str(tmp_path / "processed"))
    monkeypatch.setenv("RUN_MIGRATIONS_ON_START", "false")
    yield


@pytest.fixture
def client(monkeypatch, tmp_path):
    # Reimport modules in env-aware order: config picks up env from the
    # fixture above, main re-evaluates UPLOADS_DIR/PROCESSED_DIR.
    import importlib
    import sys

    for mod in ("config", "main"):
        sys.modules.pop(mod, None)

    import auth
    import db as db_mod
    import main
    from fastapi.testclient import TestClient
    from models import User
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    importlib.reload(main)

    test_engine = create_engine(
        f"sqlite:///{tmp_path}/test.db",
        connect_args={"check_same_thread": False},
    )
    db_mod.Base.metadata.create_all(bind=test_engine)
    TestSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)
    with TestSession() as s:
        s.add(User(id="user-1", email="u@example.com"))
        s.commit()

    def override_get_db():
        s = TestSession()
        try:
            yield s
        finally:
            s.close()

    main.app.dependency_overrides[auth.get_db] = override_get_db
    token = auth.issue_session_token("user-1")
    try:
        yield TestClient(main.app), {"Authorization": f"Bearer {token}"}
    finally:
        main.app.dependency_overrides.clear()


def test_process_rejects_non_uuid(client):
    c, headers = client
    r = c.post(
        "/process/not-a-uuid",
        json={"date": {"year": 2000, "month": 1, "day": 1}},
        headers=headers,
    )
    assert r.status_code == 400


def test_download_rejects_non_uuid(client):
    c, headers = client
    r = c.get("/download/not-a-uuid", headers=headers)
    assert r.status_code == 400


def test_oversize_upload_rejected_by_content_length(client):
    c, headers = client
    big = b"\xff" * 2048  # > 1 KB cap from fixture
    r = c.post(
        "/scan",
        files={"photo": ("big.jpg", big, "image/jpeg")},
        headers=headers,
    )
    assert r.status_code == 413
