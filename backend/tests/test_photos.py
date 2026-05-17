"""Photo catalogue: list, detail, delete, cross-user isolation."""

from __future__ import annotations

import importlib
import sys

import pytest


@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("SESSION_SECRET", "test-secret-do-not-use-in-prod")
    monkeypatch.setenv("APPLE_CLIENT_ID", "com.test.app")
    monkeypatch.setenv("UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("PROCESSED_DIR", str(tmp_path / "processed"))
    monkeypatch.setenv("RUN_MIGRATIONS_ON_START", "false")
    yield


@pytest.fixture
def app_and_session(tmp_path):
    for mod in ("config", "main"):
        sys.modules.pop(mod, None)

    import auth
    import db as db_mod
    import main
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
        s.add_all([
            User(id="user-1", email="a@example.com"),
            User(id="user-2", email="b@example.com"),
        ])
        s.commit()

    def override_get_db():
        s = TestSession()
        try:
            yield s
        finally:
            s.close()

    main.app.dependency_overrides[auth.get_db] = override_get_db
    try:
        yield main, TestSession, auth
    finally:
        main.app.dependency_overrides.clear()


def _add_photo(SessionMaker, photo_id: str, user_id: str) -> None:
    from models import Photo

    with SessionMaker() as s:
        s.add(
            Photo(
                id=photo_id,
                user_id=user_id,
                size_bytes=100,
                original_filename="test.jpg",
            )
        )
        s.commit()


def test_list_get_delete_round_trip(app_and_session):
    from fastapi.testclient import TestClient

    main, SessionMaker, auth = app_and_session
    client = TestClient(main.app)

    pid = "a" * 32
    _add_photo(SessionMaker, pid, "user-1")
    headers = {"Authorization": f"Bearer {auth.issue_session_token('user-1')}"}

    r = client.get("/photos", headers=headers)
    assert r.status_code == 200
    assert r.json()["count"] == 1
    assert r.json()["photos"][0]["photo_id"] == pid

    r = client.get(f"/photos/{pid}", headers=headers)
    assert r.status_code == 200
    assert r.json()["photo_id"] == pid

    r = client.delete(f"/photos/{pid}", headers=headers)
    assert r.status_code == 204

    r = client.get(f"/photos/{pid}", headers=headers)
    assert r.status_code == 404

    r = client.delete(f"/photos/{pid}", headers=headers)
    assert r.status_code == 404


def test_cross_user_isolation(app_and_session):
    from fastapi.testclient import TestClient

    main, SessionMaker, auth = app_and_session
    client = TestClient(main.app)

    pid = "b" * 32
    _add_photo(SessionMaker, pid, "user-1")

    other_headers = {"Authorization": f"Bearer {auth.issue_session_token('user-2')}"}

    # user-2 can't see user-1's photo in their list
    r = client.get("/photos", headers=other_headers)
    assert r.status_code == 200
    assert r.json()["count"] == 0

    # user-2 can't fetch the detail
    r = client.get(f"/photos/{pid}", headers=other_headers)
    assert r.status_code == 404

    # user-2 can't delete it
    r = client.delete(f"/photos/{pid}", headers=other_headers)
    assert r.status_code == 404
