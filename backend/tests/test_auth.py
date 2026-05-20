"""Tests for the auth layer.

We can't mint a real Apple-signed identity token here, so the JWKS path
is exercised by monkeypatching ``auth.fetch_jwks`` to return a JWK
generated from a self-signed RSA key. That covers signature/iss/aud/exp
validation end-to-end.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def session_secret(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "test-secret-do-not-use-in-prod")
    monkeypatch.setenv("APPLE_CLIENT_ID", "com.test.app")
    yield


def test_session_token_round_trip():
    from auth import issue_session_token, verify_session_token

    token = issue_session_token("user-abc")
    assert verify_session_token(token) == "user-abc"


def test_expired_session_token_rejected(monkeypatch):
    import auth

    # Mint a token with exp already in the past.
    payload = {
        "sub": "user-old",
        "iat": int(time.time()) - 7200,
        "exp": int(time.time()) - 3600,
    }
    token = jwt.encode(payload, "test-secret-do-not-use-in-prod", algorithm="HS256")
    with pytest.raises(HTTPException) as exc:
        auth.verify_session_token(token)
    assert exc.value.status_code == 401


def test_tampered_session_token_rejected():
    from auth import issue_session_token, verify_session_token

    good = issue_session_token("user-x")
    # Replace the first signature character with a guaranteed-different
    # b64url char. Using a fixed letter like "x" silently flakes on the
    # ~1.5% of runs where the real signature already starts with that
    # character, producing a tamper that's actually a no-op.
    head, body, sig = good.split(".")
    bad_first = "a" if sig[0] != "a" else "b"
    bad = ".".join([head, body, bad_first + sig[1:]])
    with pytest.raises(HTTPException) as exc:
        verify_session_token(bad)
    assert exc.value.status_code == 401


def _make_rsa_jwk_pair():
    """Return (private_pem_str, jwk_dict) for a fresh RSA-2048 key."""
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    pub_jwk_str = jwt.algorithms.RSAAlgorithm.to_jwk(priv.public_key())
    pub_jwk = json.loads(pub_jwk_str)
    pub_jwk["kid"] = "test-kid-1"
    pub_jwk["use"] = "sig"
    pub_jwk["alg"] = "RS256"
    return pem, pub_jwk


def test_verify_apple_token_validates_iss_aud_exp(monkeypatch):
    import auth

    pem, jwk = _make_rsa_jwk_pair()

    # Bypass the live JWKS fetch + cache.
    monkeypatch.setattr(auth, "fetch_jwks", lambda: [jwk])
    monkeypatch.setattr(auth, "_jwks_fetched_at", 0.0)
    monkeypatch.setattr(auth, "_jwks_keys", [])

    now = datetime.now(timezone.utc)

    # Happy path
    token = jwt.encode(
        {
            "iss": auth.APPLE_ISSUER,
            "aud": "com.test.app",
            "sub": "001234.fakeAppleSub.5678",
            "email": "u@privaterelay.appleid.com",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=5)).timestamp()),
        },
        pem,
        algorithm="RS256",
        headers={"kid": "test-kid-1"},
    )
    claims = auth.verify_apple_token(token)
    assert claims["sub"] == "001234.fakeAppleSub.5678"
    assert claims["email"] == "u@privaterelay.appleid.com"

    # Wrong audience
    bad_aud = jwt.encode(
        {
            "iss": auth.APPLE_ISSUER,
            "aud": "com.someone.else",
            "sub": "x",
            "exp": int((now + timedelta(minutes=5)).timestamp()),
        },
        pem,
        algorithm="RS256",
        headers={"kid": "test-kid-1"},
    )
    with pytest.raises(HTTPException) as exc:
        auth.verify_apple_token(bad_aud)
    assert exc.value.status_code == 401

    # Expired
    expired = jwt.encode(
        {
            "iss": auth.APPLE_ISSUER,
            "aud": "com.test.app",
            "sub": "x",
            "exp": int((now - timedelta(minutes=5)).timestamp()),
        },
        pem,
        algorithm="RS256",
        headers={"kid": "test-kid-1"},
    )
    with pytest.raises(HTTPException) as exc:
        auth.verify_apple_token(expired)
    assert exc.value.status_code == 401

    # Wrong issuer
    bad_iss = jwt.encode(
        {
            "iss": "https://evil.example.com",
            "aud": "com.test.app",
            "sub": "x",
            "exp": int((now + timedelta(minutes=5)).timestamp()),
        },
        pem,
        algorithm="RS256",
        headers={"kid": "test-kid-1"},
    )
    with pytest.raises(HTTPException) as exc:
        auth.verify_apple_token(bad_iss)
    assert exc.value.status_code == 401


def test_auth_me_requires_bearer(tmp_path):
    """End-to-end: hit /auth/me with and without a valid session token.

    Uses FastAPI's dependency-override hook to swap in an isolated
    SQLite engine so the test doesn't touch the dev memories.db file.
    """
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import auth
    import db as db_mod
    import main
    from models import User

    # Fresh tmp-file engine; in-memory SQLite is per-connection so the
    # session inside the route would see an empty database.
    test_engine = create_engine(
        f"sqlite:///{tmp_path}/test.db",
        connect_args={"check_same_thread": False},
    )
    db_mod.Base.metadata.create_all(bind=test_engine)
    TestSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)

    with TestSession() as s:
        s.add(User(id="user-7", email="u@example.com"))
        s.commit()

    def override_get_db():
        s = TestSession()
        try:
            yield s
        finally:
            s.close()

    main.app.dependency_overrides[auth.get_db] = override_get_db
    try:
        client = TestClient(main.app)

        r = client.get("/auth/me")
        assert r.status_code == 401

        token = auth.issue_session_token("user-7")
        r = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        assert r.json() == {"id": "user-7", "email": "u@example.com"}
    finally:
        main.app.dependency_overrides.clear()
