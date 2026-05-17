"""Tests for entitlement + quota + Apple JWS verification."""

from __future__ import annotations

import base64
import time
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "test-secret-do-not-use-in-prod")
    monkeypatch.setenv("APPLE_CLIENT_ID", "com.test.app")
    monkeypatch.setenv("APPLE_BUNDLE_ID", "com.test.app")
    yield


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    """Spin up a fresh SQLite file + dependency override on main.app."""
    import auth
    import db as db_mod
    import main

    test_engine = create_engine(
        f"sqlite:///{tmp_path}/test.db",
        connect_args={"check_same_thread": False},
    )
    db_mod.Base.metadata.create_all(bind=test_engine)
    TestSession = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)

    def override_get_db():
        s = TestSession()
        try:
            yield s
        finally:
            s.close()

    main.app.dependency_overrides[auth.get_db] = override_get_db
    yield TestSession
    main.app.dependency_overrides.clear()


def _make_user(TestSession, user_id="user-quota", **kw):
    from models import User

    with TestSession() as s:
        s.add(User(id=user_id, email=f"{user_id}@x.com", **kw))
        s.commit()


# --------------------------------------------------------------------- #
# entitled()                                                            #
# --------------------------------------------------------------------- #


def test_entitled_free_default():
    from billing import FREE_SCAN_LIMIT, entitled
    from models import User

    snap = entitled(User(id="u", lifetime_scans=0, subscription_status="free"))
    assert snap.tier == "free"
    assert snap.scans_remaining == FREE_SCAN_LIMIT


def test_entitled_free_after_quota():
    from billing import entitled
    from models import User

    snap = entitled(User(id="u", lifetime_scans=25, subscription_status="free"))
    assert snap.tier == "free"
    assert snap.scans_remaining == 0


def test_entitled_active_subscription_is_unlimited():
    from billing import entitled
    from models import User

    future = datetime.now(timezone.utc) + timedelta(days=10)
    snap = entitled(
        User(
            id="u",
            lifetime_scans=999,
            subscription_status="active",
            subscription_expires_at=future,
        )
    )
    assert snap.tier == "pro"
    assert snap.scans_remaining == -1


def test_entitled_grace_still_pro_inside_window():
    from billing import entitled
    from models import User

    # 5 days past expiry but in grace -> still pro
    past = datetime.now(timezone.utc) - timedelta(days=5)
    snap = entitled(
        User(
            id="u",
            lifetime_scans=999,
            subscription_status="grace",
            subscription_expires_at=past,
        )
    )
    assert snap.tier == "pro"


def test_entitled_refunded_falls_back_to_free():
    from billing import entitled
    from models import User

    snap = entitled(
        User(id="u", lifetime_scans=10, subscription_status="refunded")
    )
    assert snap.tier == "free"
    assert snap.scans_remaining == 15  # 25 - 10


# --------------------------------------------------------------------- #
# /scan quota gate                                                      #
# --------------------------------------------------------------------- #


def test_scan_402_when_quota_exhausted(isolated_db, monkeypatch):
    import auth
    import main
    import ocr

    TestSession = isolated_db
    _make_user(TestSession, user_id="u-broke", lifetime_scans=25)

    # Don't actually run Tesseract; we just want the quota gate to fire.
    monkeypatch.setattr(
        ocr,
        "detect_date_in_image",
        lambda _p: type(
            "R",
            (),
            {"to_dict": lambda self: {"detected": False, "date": None, "confidence": 0.0}},
        )(),
    )

    client = TestClient(main.app)
    token = auth.issue_session_token("u-broke")
    res = client.post(
        "/scan",
        headers={"Authorization": f"Bearer {token}"},
        files={"photo": ("x.jpg", b"\xff\xd8\xff\xe0fake", "image/jpeg")},
    )
    assert res.status_code == 402
    body = res.json()["detail"]
    assert body["code"] == "quota_exhausted"
    assert body["scans_used"] == 25
    assert body["product_id"] == "com.memoriesscanner.pro.monthly"


def test_scan_increments_counter(isolated_db, monkeypatch):
    import auth
    import main
    import ocr
    from models import User

    TestSession = isolated_db
    _make_user(TestSession, user_id="u-ok", lifetime_scans=0)

    monkeypatch.setattr(
        ocr,
        "detect_date_in_image",
        lambda _p: type(
            "R",
            (),
            {
                "to_dict": lambda self: {
                    "detected": True,
                    "date": {"year": 1999, "month": 6, "day": 15},
                    "confidence": 0.9,
                }
            },
        )(),
    )

    client = TestClient(main.app)
    token = auth.issue_session_token("u-ok")
    res = client.post(
        "/scan",
        headers={"Authorization": f"Bearer {token}"},
        files={"photo": ("x.jpg", b"\xff\xd8\xff\xe0fake", "image/jpeg")},
    )
    assert res.status_code == 200
    with TestSession() as s:
        u = s.get(User, "u-ok")
        assert u.lifetime_scans == 1


def test_scan_unlimited_for_pro(isolated_db, monkeypatch):
    import auth
    import main
    import ocr
    from models import User

    TestSession = isolated_db
    future = datetime.now(timezone.utc) + timedelta(days=30)
    _make_user(
        TestSession,
        user_id="u-pro",
        lifetime_scans=999,
        subscription_status="active",
        subscription_expires_at=future,
    )

    monkeypatch.setattr(
        ocr,
        "detect_date_in_image",
        lambda _p: type(
            "R",
            (),
            {"to_dict": lambda self: {"detected": False, "date": None, "confidence": 0.0}},
        )(),
    )

    client = TestClient(main.app)
    token = auth.issue_session_token("u-pro")
    res = client.post(
        "/scan",
        headers={"Authorization": f"Bearer {token}"},
        files={"photo": ("x.jpg", b"\xff\xd8\xff\xe0fake", "image/jpeg")},
    )
    assert res.status_code == 200

    with TestSession() as s:
        u = s.get(User, "u-pro")
        assert u.lifetime_scans == 1000


# --------------------------------------------------------------------- #
# /billing/status                                                       #
# --------------------------------------------------------------------- #


def test_billing_status_reports_free(isolated_db):
    import auth
    import main

    TestSession = isolated_db
    _make_user(TestSession, user_id="u-free", lifetime_scans=10)

    client = TestClient(main.app)
    token = auth.issue_session_token("u-free")
    res = client.get(
        "/billing/status", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 200
    j = res.json()
    assert j["tier"] == "free"
    assert j["scans_used"] == 10
    assert j["scans_remaining"] == 15
    assert j["free_limit"] == 25
    assert j["product_id"] == "com.memoriesscanner.pro.monthly"


# --------------------------------------------------------------------- #
# Apple JWS verification                                                #
# --------------------------------------------------------------------- #


def _make_self_signed_chain():
    """Build a leaf -> root chain we can sign JWS payloads with for tests.

    Real Apple chains anchor at Apple Root CA G3. We stub
    ``billing._apple_root_cert`` to point at our own root so the test
    chain validates.
    """
    root_key = ec.generate_private_key(ec.SECP256R1())
    root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Root")])
    root = (
        x509.CertificateBuilder()
        .subject_name(root_name)
        .issuer_name(root_name)
        .public_key(root_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .sign(root_key, hashes.SHA256())
    )

    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Leaf")])
    leaf = (
        x509.CertificateBuilder()
        .subject_name(leaf_name)
        .issuer_name(root_name)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .sign(root_key, hashes.SHA256())
    )
    return root, leaf, leaf_key


def _sign_jws(payload: dict, leaf_cert, leaf_key, root_cert) -> str:
    leaf_der = leaf_cert.public_bytes(serialization.Encoding.DER)
    root_der = root_cert.public_bytes(serialization.Encoding.DER)
    x5c = [
        base64.b64encode(leaf_der).decode("ascii"),
        base64.b64encode(root_der).decode("ascii"),
    ]
    leaf_pem = leaf_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return jwt.encode(
        payload, leaf_pem, algorithm="ES256", headers={"x5c": x5c}
    )


def test_verify_apple_jws_round_trip(monkeypatch):
    import billing

    root, leaf, leaf_key = _make_self_signed_chain()
    monkeypatch.setattr(billing, "_apple_root_cert", lambda: root)

    token = _sign_jws(
        {
            "originalTransactionId": "1000000123",
            "transactionId": "1000000125",
            "productId": billing.PRODUCT_ID,
            "environment": "Sandbox",
            "expiresDate": int((time.time() + 60 * 60 * 24 * 30) * 1000),
        },
        leaf,
        leaf_key,
        root,
    )
    claims = billing.verify_apple_jws(token)
    assert claims["productId"] == billing.PRODUCT_ID
    assert claims["originalTransactionId"] == "1000000123"


def test_verify_apple_jws_rejects_wrong_root(monkeypatch):
    import billing

    root, leaf, leaf_key = _make_self_signed_chain()
    # Don't monkeypatch; the real Apple Root CA G3 won't match our test root.
    token = _sign_jws(
        {"originalTransactionId": "x", "productId": billing.PRODUCT_ID},
        leaf,
        leaf_key,
        root,
    )
    with pytest.raises(billing.AppleVerificationError):
        billing.verify_apple_jws(token)


# --------------------------------------------------------------------- #
# apply_transaction projects onto User                                  #
# --------------------------------------------------------------------- #


def test_apply_transaction_projects_active_status(isolated_db):
    import billing
    from models import User

    TestSession = isolated_db
    _make_user(TestSession, user_id="u-buy", lifetime_scans=25)
    with TestSession() as s:
        u = s.get(User, "u-buy")
        future_ms = int(
            (datetime.now(timezone.utc) + timedelta(days=30)).timestamp() * 1000
        )
        billing.apply_transaction(
            s,
            u,
            {
                "originalTransactionId": "100123",
                "productId": billing.PRODUCT_ID,
                "environment": "Sandbox",
                "expiresDate": future_ms,
            },
        )
        s.commit()
        u2 = s.get(User, "u-buy")
        assert u2.subscription_status == "active"
        assert u2.apple_original_transaction_id == "100123"
        assert billing.entitled(u2).tier == "pro"


def test_apply_transaction_refund_clears_entitlement(isolated_db):
    import billing
    from models import Subscription, User

    TestSession = isolated_db
    _make_user(
        TestSession,
        user_id="u-refund",
        subscription_status="active",
        apple_original_transaction_id="100200",
    )
    with TestSession() as s:
        s.add(
            Subscription(
                user_id="u-refund",
                original_transaction_id="100200",
                product_id=billing.PRODUCT_ID,
                status="active",
                environment="sandbox",
            )
        )
        s.commit()

    with TestSession() as s:
        u = s.get(User, "u-refund")
        revoke_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        billing.apply_transaction(
            s,
            u,
            {
                "originalTransactionId": "100200",
                "productId": billing.PRODUCT_ID,
                "revocationDate": revoke_ms,
            },
            notification_type="REFUND",
        )
        s.commit()
        u2 = s.get(User, "u-refund")
        assert u2.subscription_status == "refunded"
        assert billing.entitled(u2).tier == "free"


def test_apply_transaction_rejects_cross_user_binding(isolated_db):
    import billing
    from fastapi import HTTPException
    from models import Subscription, User

    TestSession = isolated_db
    _make_user(TestSession, user_id="alice")
    _make_user(TestSession, user_id="bob")
    with TestSession() as s:
        s.add(
            Subscription(
                user_id="alice",
                original_transaction_id="abc123",
                product_id=billing.PRODUCT_ID,
                status="active",
                environment="sandbox",
            )
        )
        s.commit()

    with TestSession() as s:
        bob = s.get(User, "bob")
        with pytest.raises(HTTPException) as exc:
            billing.apply_transaction(
                s,
                bob,
                {
                    "originalTransactionId": "abc123",
                    "productId": billing.PRODUCT_ID,
                },
            )
        assert exc.value.status_code == 409
        assert exc.value.detail["code"] == "already_bound"
