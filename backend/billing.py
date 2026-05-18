"""Subscription + usage-quota logic.

The hot path (``/scan``) calls :func:`entitled` to decide whether a
user has scans left and :func:`record_scan` to log a billable event.

The cold path (purchase flow + Apple webhooks) verifies a JWS-signed
transaction from StoreKit, projects it onto the ``Subscription`` row,
and updates the cached projection on ``User``.

Verification model
------------------

Apple's modern receipts (StoreKit 2 + App Store Server Notifications V2)
are JWS payloads, ES256-signed by a certificate chain anchored at
Apple Root CA G3. We verify:

  1. The ``x5c`` chain in the JWS header (leaf -> intermediates -> root).
  2. That the root certificate matches our pinned Apple Root CA G3.
  3. The JWS signature with the leaf's public key.

The App Store Server API call (used to fetch fresh status by
``transactionId``) is optional — if the env keys aren't provisioned,
we still trust JWS payloads whose chain validates. This lets us ship
the paywall without all Apple keys provisioned, while keeping the
ability to drop in live server-side queries later.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import jwt
import requests
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from models import Subscription, UsageLog, User

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------- #
# Constants                                                             #
# --------------------------------------------------------------------- #

FREE_SCAN_LIMIT = 25
MONTHLY_PRODUCT_ID = "com.memoriesscanner.pro.monthly"
LIFETIME_PRODUCT_ID = "com.memoriesscanner.pro.lifetime"
# Back-compat alias: pre-lifetime callers imported PRODUCT_ID.
PRODUCT_ID = MONTHLY_PRODUCT_ID
GRACE_PERIOD_DAYS = 16  # Apple's documented max billing-retry window.

# Pinned Apple Root CA G3, PEM-encoded. Public, available at
# https://www.apple.com/certificateauthority/AppleRootCA-G3.cer.
# Used as the trust anchor for App Store Server Notifications V2 + the
# JWS payloads embedded in receipts.
APPLE_ROOT_CA_G3_PEM = b"""-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----
"""


def _apple_root_cert() -> x509.Certificate:
    return x509.load_pem_x509_certificate(APPLE_ROOT_CA_G3_PEM)


# --------------------------------------------------------------------- #
# Entitlement                                                           #
# --------------------------------------------------------------------- #


@dataclass
class EntitlementSnapshot:
    tier: str  # "free" | "pro"
    scans_used: int
    scans_remaining: int  # math.inf-equivalent: -1 means unlimited
    expires_at: Optional[datetime]
    status: str  # mirrors User.subscription_status (or "lifetime")
    has_lifetime: bool = False

    def to_dict(self) -> dict:
        return {
            "tier": self.tier,
            "scans_used": self.scans_used,
            "scans_remaining": self.scans_remaining,
            "expires_at": (
                self.expires_at.isoformat() if self.expires_at else None
            ),
            "status": self.status,
            "free_limit": FREE_SCAN_LIMIT,
            "product_id": MONTHLY_PRODUCT_ID,
            "lifetime_product_id": LIFETIME_PRODUCT_ID,
            "has_lifetime": self.has_lifetime,
        }


def entitled(user: User) -> EntitlementSnapshot:
    """Pure projection of the user's billing state. No DB writes."""
    now = datetime.now(timezone.utc)
    expires = user.subscription_expires_at
    # Normalize naive datetimes (SQLite returns naive timestamps) back to UTC.
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)

    has_lifetime = bool(getattr(user, "has_lifetime", False))

    # Lifetime short-circuits everything. No expiry, no quota.
    if has_lifetime:
        return EntitlementSnapshot(
            tier="pro",
            scans_used=user.lifetime_scans,
            scans_remaining=-1,
            expires_at=None,
            status="lifetime",
            has_lifetime=True,
        )

    is_pro = user.subscription_status in {"active", "grace"} and (
        expires is None or expires > now - timedelta(days=GRACE_PERIOD_DAYS)
    )

    if is_pro:
        return EntitlementSnapshot(
            tier="pro",
            scans_used=user.lifetime_scans,
            scans_remaining=-1,
            expires_at=expires,
            status=user.subscription_status,
            has_lifetime=False,
        )
    remaining = max(0, FREE_SCAN_LIMIT - user.lifetime_scans)
    return EntitlementSnapshot(
        tier="free",
        scans_used=user.lifetime_scans,
        scans_remaining=remaining,
        expires_at=expires,
        status=user.subscription_status,
        has_lifetime=False,
    )


def record_scan(
    db: Session,
    user: User,
    photo_id: str | None,
    counted: bool,
) -> None:
    """Append a UsageLog row and (when counted) bump the denormalized total.

    Caller is responsible for the surrounding transaction. Designed to
    be called inside the same ``BEGIN IMMEDIATE`` that wrapped the
    quota check, so two concurrent scans at scan #25 can't both win.
    """
    db.add(
        UsageLog(
            user_id=user.id,
            photo_id=photo_id,
            kind="scan",
            counted=counted,
        )
    )
    if counted:
        user.lifetime_scans = (user.lifetime_scans or 0) + 1


# --------------------------------------------------------------------- #
# Apple JWS verification                                                #
# --------------------------------------------------------------------- #


class AppleVerificationError(Exception):
    """Raised when an Apple-signed payload fails signature or chain checks."""


def _b64url_decode(part: str) -> bytes:
    pad = "=" * (-len(part) % 4)
    return base64.urlsafe_b64decode(part + pad)


def _load_x5c_chain(x5c: list[str]) -> list[x509.Certificate]:
    out = []
    for entry in x5c:
        der = base64.b64decode(entry)
        out.append(x509.load_der_x509_certificate(der))
    return out


def _verify_signature(cert: x509.Certificate, parent: x509.Certificate) -> None:
    parent_pub = parent.public_key()
    sig = cert.signature
    tbs = cert.tbs_certificate_bytes
    algo = cert.signature_hash_algorithm
    if isinstance(parent_pub, ec.EllipticCurvePublicKey):
        parent_pub.verify(sig, tbs, ec.ECDSA(algo))
    elif isinstance(parent_pub, rsa.RSAPublicKey):
        parent_pub.verify(sig, tbs, padding.PKCS1v15(), algo)
    else:
        raise AppleVerificationError(
            f"Unsupported issuer key type {type(parent_pub).__name__}"
        )


def _verify_chain(chain: list[x509.Certificate]) -> None:
    """Walk the chain leaf -> ... -> root and verify each link.

    Confirms the final cert matches our pinned Apple Root CA G3.
    """
    if not chain:
        raise AppleVerificationError("Empty x5c chain")
    root = _apple_root_cert()
    # Apple puts the leaf first. Walk to the root.
    now = datetime.now(timezone.utc)
    for cert in chain:
        not_before = cert.not_valid_before_utc
        not_after = cert.not_valid_after_utc
        if not (not_before <= now <= not_after):
            raise AppleVerificationError(
                f"Certificate {cert.subject.rfc4514_string()!r} not in validity window"
            )
    for i in range(len(chain) - 1):
        _verify_signature(chain[i], chain[i + 1])
    # The last cert in chain[] must be signed by Apple Root CA G3 (or be it).
    last = chain[-1]
    if last.fingerprint(hashes.SHA256()) == root.fingerprint(hashes.SHA256()):
        return  # chain terminates at the pinned root
    try:
        _verify_signature(last, root)
    except Exception as e:
        raise AppleVerificationError(
            f"Chain does not anchor at Apple Root CA G3: {e}"
        ) from e


def verify_apple_jws(token: str, *, verify_chain: bool = True) -> dict[str, Any]:
    """Decode an Apple JWS payload after verifying chain + signature.

    Apple uses ES256 with the certificate chain in the JWS x5c header
    (no kid lookup, no JWKS). Returns the decoded claims dict.

    When ``verify_chain`` is False, only the leaf signature is checked
    (still requires x5c). Use this only for tests where chain validity
    can't be mocked easily.
    """
    try:
        header_b64, _, _ = token.split(".")
    except ValueError as e:
        raise AppleVerificationError("Malformed JWS") from e

    header = json.loads(_b64url_decode(header_b64))
    x5c = header.get("x5c")
    if not x5c or not isinstance(x5c, list):
        raise AppleVerificationError("JWS header missing x5c chain")

    chain = _load_x5c_chain(x5c)
    if verify_chain:
        _verify_chain(chain)

    leaf_pub = chain[0].public_key()
    try:
        return jwt.decode(token, leaf_pub, algorithms=["ES256"])
    except jwt.PyJWTError as e:
        raise AppleVerificationError(f"Bad signature: {e}") from e


# --------------------------------------------------------------------- #
# App Store Server API client (signed-transaction lookup)               #
# --------------------------------------------------------------------- #


def _appstore_host(environment: str) -> str:
    if environment.lower() == "production":
        return "https://api.storekit.itunes.apple.com"
    return "https://api.storekit-sandbox.itunes.apple.com"


def _appstore_api_jwt() -> Optional[str]:
    """Sign the ES256 JWT used to call the App Store Server API.

    Returns None when keys aren't configured — callers fall back to
    JWS-only verification.
    """
    issuer = os.getenv("APPLE_ISSUER_ID")
    key_id = os.getenv("APPLE_KEY_ID")
    key_path = os.getenv("APPLE_PRIVATE_KEY_PATH")
    bundle_id = os.getenv("APPLE_BUNDLE_ID")
    if not (issuer and key_id and key_path and bundle_id):
        return None
    try:
        with open(key_path, "rb") as f:
            key = serialization.load_pem_private_key(f.read(), password=None)
    except OSError as e:
        logger.warning("APPLE_PRIVATE_KEY_PATH unreadable: %s", e)
        return None
    now = int(time.time())
    payload = {
        "iss": issuer,
        "iat": now,
        "exp": now + 1500,  # Apple max is 60 min; 25 min is safe.
        "aud": "appstoreconnect-v1",
        "bid": bundle_id,
    }
    return jwt.encode(payload, key, algorithm="ES256", headers={"kid": key_id})


def fetch_transaction(
    transaction_id: str, environment: str = "sandbox"
) -> Optional[dict]:
    """Call App Store Server API for fresh status. Returns parsed JWS claims.

    Returns None if API keys aren't configured — caller falls back to
    the client-provided JWS.
    """
    api_jwt = _appstore_api_jwt()
    if not api_jwt:
        return None
    url = f"{_appstore_host(environment)}/inApps/v1/transactions/{transaction_id}"
    res = requests.get(
        url, headers={"Authorization": f"Bearer {api_jwt}"}, timeout=10
    )
    if res.status_code != 200:
        logger.warning(
            "App Store Server API %s -> %d: %s",
            transaction_id,
            res.status_code,
            res.text[:200],
        )
        return None
    body = res.json()
    signed = body.get("signedTransactionInfo")
    if not signed:
        return None
    return verify_apple_jws(signed)


# --------------------------------------------------------------------- #
# Projecting Apple payloads onto our DB                                 #
# --------------------------------------------------------------------- #


def _ms_to_datetime(ms: Any) -> Optional[datetime]:
    if ms is None:
        return None
    try:
        return datetime.fromtimestamp(int(ms) / 1000.0, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def _project_status(
    notification_type: Optional[str],
    expires_at: Optional[datetime],
    revocation_date: Optional[datetime],
) -> str:
    """Map an Apple notification + dates onto our internal status enum."""
    now = datetime.now(timezone.utc)
    if revocation_date is not None:
        return "refunded"
    if notification_type in {"REVOKE"}:
        return "refunded"
    if notification_type in {"REFUND"}:
        return "refunded"
    if notification_type in {"EXPIRED", "GRACE_PERIOD_EXPIRED"}:
        return "expired"
    if notification_type in {"DID_FAIL_TO_RENEW"}:
        # Apple sends BILLING_RETRY in the subtype; treat as grace.
        return "grace"
    if expires_at is not None and expires_at < now:
        return "expired"
    return "active"


def apply_transaction(
    db: Session,
    user: User,
    transaction_claims: dict[str, Any],
    notification_type: Optional[str] = None,
    raw_payload: Optional[str] = None,
) -> Subscription:
    """Upsert ``Subscription`` from a verified transaction payload and
    project the result onto the user's denormalized columns.

    Caller controls the surrounding transaction.
    """
    original_id = (
        transaction_claims.get("originalTransactionId")
        or transaction_claims.get("transactionId")
    )
    if not original_id:
        raise AppleVerificationError(
            "Transaction payload missing originalTransactionId"
        )
    product_id = transaction_claims.get("productId") or MONTHLY_PRODUCT_ID
    is_lifetime = product_id == LIFETIME_PRODUCT_ID
    environment = transaction_claims.get("environment", "Sandbox").lower()
    # Lifetime IAPs are non-consumable and never expire, even if Apple
    # echoes back an expiresDate in some edge cases.
    expires_at = (
        None if is_lifetime
        else _ms_to_datetime(transaction_claims.get("expiresDate"))
    )
    revoked_at = _ms_to_datetime(transaction_claims.get("revocationDate"))
    new_status = _project_status(notification_type, expires_at, revoked_at)

    sub: Subscription | None = (
        db.query(Subscription)
        .filter(Subscription.original_transaction_id == original_id)
        .one_or_none()
    )
    if sub is None:
        sub = Subscription(
            user_id=user.id,
            original_transaction_id=original_id,
            product_id=product_id,
            status=new_status,
            expires_at=expires_at,
            environment=environment,
            raw_payload_json=raw_payload or json.dumps(transaction_claims),
        )
        db.add(sub)
    else:
        # Reject silent reassignment: another user already owns this
        # purchase. The caller turns this into a 409.
        if sub.user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "already_bound",
                    "message": "This purchase is tied to a different account.",
                },
            )
        sub.product_id = product_id
        sub.status = new_status
        sub.expires_at = expires_at
        sub.environment = environment
        sub.last_notification_at = datetime.now(timezone.utc)
        sub.raw_payload_json = raw_payload or json.dumps(transaction_claims)

    db.flush()  # ensure the just-written row is visible to the re-derive below

    if is_lifetime:
        # Re-derive has_lifetime from the table so refunds (REFUND / REVOKE)
        # clear the flag, and so a user with multiple lifetime rows keeps
        # the entitlement as long as any one remains "active".
        has_active = (
            db.query(Subscription)
            .filter(
                Subscription.user_id == user.id,
                Subscription.product_id == LIFETIME_PRODUCT_ID,
                Subscription.status == "active",
            )
            .first()
            is not None
        )
        user.has_lifetime = has_active
        # Lifetime does not touch the subscription projection columns.
        # If the user also holds a monthly sub, those fields keep tracking it.
    else:
        # Subscription product — project onto the dedicated columns.
        user.apple_original_transaction_id = original_id
        user.subscription_status = new_status
        user.subscription_expires_at = expires_at
    return sub
