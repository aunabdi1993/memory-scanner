"""Sign in with Apple verification + first-party session JWTs.

Flow:

  1. The app authenticates with Apple natively (expo-apple-authentication)
     and receives an *identity token* (RS256 JWT signed by Apple).
  2. The app POSTs that token to /auth/apple.
  3. ``verify_apple_token`` validates the signature against Apple's JWKS,
     plus iss / aud / exp.
  4. We upsert a User row keyed by the ``sub`` claim and issue our own
     short-lived HS256 session JWT via ``issue_session_token``.
  5. Subsequent requests pass it as ``Authorization: Bearer ...`` and
     ``get_current_user`` resolves the row.

We never see passwords - Apple owns that side of the handshake.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

import jwt
import requests
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from db import SessionLocal
from middleware import user_id_var
from models import User

logger = logging.getLogger(__name__)

APPLE_ISSUER = "https://appleid.apple.com"
APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
JWKS_CACHE_TTL_SECONDS = 60 * 60  # 1 hour

SESSION_ALGORITHM = "HS256"
SESSION_TTL_DAYS = 30


def _env(name: str, default: Optional[str] = None) -> str:
    """Lookup an env var at call time.

    Kept as a function (rather than importing from config) so test
    fixtures that monkeypatch os.environ keep working without rebuilding
    a Settings instance.
    """
    val = os.getenv(name, default)
    if val is None:
        raise RuntimeError(f"Missing required env var {name!r}")
    return val


# --------------------------------------------------------------------- #
# JWKS caching                                                          #
# --------------------------------------------------------------------- #

_jwks_cache: dict[str, object] = {"fetched_at": 0.0, "keys": []}

# Test seam: monkeypatch this in tests instead of stubbing requests.get.
fetch_jwks: Callable[[], list[dict]] = lambda: _http_fetch_jwks()


def _http_fetch_jwks() -> list[dict]:
    res = requests.get(APPLE_JWKS_URL, timeout=10)
    res.raise_for_status()
    return res.json().get("keys", [])


def _get_apple_keys() -> list[dict]:
    now = time.time()
    if (
        _jwks_cache["keys"]
        and now - float(_jwks_cache["fetched_at"]) < JWKS_CACHE_TTL_SECONDS
    ):
        return list(_jwks_cache["keys"])  # type: ignore[arg-type]
    keys = fetch_jwks()
    _jwks_cache["fetched_at"] = now
    _jwks_cache["keys"] = keys
    return keys


def _public_key_for_kid(kid: str):
    for jwk_dict in _get_apple_keys():
        if jwk_dict.get("kid") == kid:
            return jwt.algorithms.RSAAlgorithm.from_jwk(jwk_dict)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=f"Apple JWKS has no key with kid={kid!r}",
    )


# --------------------------------------------------------------------- #
# Apple identity token                                                  #
# --------------------------------------------------------------------- #


def verify_apple_token(identity_token: str) -> dict:
    """Verify Apple's RS256 identity token. Returns its decoded claims.

    Raises HTTPException(401) on any signature/iss/aud/exp problem.
    """
    audience = _env("APPLE_CLIENT_ID")

    try:
        unverified_header = jwt.get_unverified_header(identity_token)
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Malformed Apple token: {e}",
        ) from e

    kid = unverified_header.get("kid")
    if not kid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Apple token missing kid header",
        )

    public_key = _public_key_for_kid(kid)

    try:
        claims = jwt.decode(
            identity_token,
            public_key,
            algorithms=["RS256"],
            audience=audience,
            issuer=APPLE_ISSUER,
        )
    except jwt.PyJWTError as e:
        logger.info("Apple token rejected: %s", e)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid Apple token: {e}",
        ) from e

    if "sub" not in claims:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Apple token missing sub claim",
        )
    return claims


# --------------------------------------------------------------------- #
# First-party session JWT                                               #
# --------------------------------------------------------------------- #


def issue_session_token(user_id: str) -> str:
    """Mint a 30-day HS256 session JWT for *user_id* (Apple sub)."""
    secret = _env("SESSION_SECRET")
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=SESSION_TTL_DAYS)).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm=SESSION_ALGORITHM)


def verify_session_token(token: str) -> str:
    """Decode and validate a session token. Returns user_id."""
    secret = _env("SESSION_SECRET")
    try:
        claims = jwt.decode(token, secret, algorithms=[SESSION_ALGORITHM])
    except jwt.PyJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid session token: {e}",
        ) from e
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session token missing sub",
        )
    return user_id


# --------------------------------------------------------------------- #
# FastAPI dependencies                                                  #
# --------------------------------------------------------------------- #


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    request: Request, db: Session = Depends(get_db)
) -> User:
    """Resolve the authenticated User row, or raise 401."""
    auth = request.headers.get("authorization") or request.headers.get(
        "Authorization"
    )
    if not auth or not auth.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token",
        )
    token = auth.split(" ", 1)[1].strip()
    user_id = verify_session_token(token)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    user_id_var.set(user.id)
    return user
