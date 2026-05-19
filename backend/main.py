"""Memories Scanner backend.

FastAPI service that receives a printed-photo upload, runs OCR on the
date stamp, embeds the detected/manual date into EXIF metadata, and
serves the processed JPEG back to the app.
"""

import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import date as date_type, datetime, timezone
from pathlib import Path
from typing import AsyncIterator

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from alembic import command
from alembic.config import Config as AlembicConfig

from auth import (
    get_current_user,
    get_db,
    issue_session_token,
    verify_apple_token,
)
from billing import (
    AppleVerificationError,
    FREE_SCAN_LIMIT,
    PRODUCT_ID,
    apply_transaction,
    entitled,
    fetch_transaction,
    record_scan,
    verify_apple_jws,
)
from config import get_settings
from exif_writer import embed_date_in_exif, safe_target_path
from middleware import RequestIdMiddleware
from models import Photo, Subscription, User
from ocr import detect_date_in_image
from observability import init_logging, init_sentry
from schemas import (
    AppleTokenIn,
    AuthOut,
    DateInput,
    HealthOut,
    PhotoListOut,
    PhotoOut,
    ProcessOut,
    ProcessRequest,
    ScanOut,
    UserOut,
)

load_dotenv()
settings = get_settings()

init_logging()
init_sentry(settings.sentry_dsn, settings.env)
logger = logging.getLogger("memories-scanner")

UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", "uploads")).resolve()
PROCESSED_DIR = Path(os.getenv("PROCESSED_DIR", "processed")).resolve()
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

VERSION = "1.0.0"


def _run_migrations() -> None:
    cfg = AlembicConfig(str(Path(__file__).parent / "alembic.ini"))
    command.upgrade(cfg, "head")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    if os.getenv("RUN_MIGRATIONS_ON_START", "true").lower() in ("1", "true", "yes"):
        _run_migrations()
    logger.info("Memories Scanner backend %s starting (env=%s)", VERSION, settings.env)
    logger.info("Uploads dir:   %s", UPLOADS_DIR)
    logger.info("Processed dir: %s", PROCESSED_DIR)
    logger.info("CORS origins:  %s", settings.cors_origins)
    yield


app = FastAPI(title="Memories Scanner", version=VERSION, lifespan=lifespan)

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]

app.add_middleware(RequestIdMiddleware)
if settings.env == "production" and settings.trusted_hosts:
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=settings.trusted_hosts
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
app.mount("/processed", StaticFiles(directory=str(PROCESSED_DIR)), name="processed")


@app.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    return HealthOut(status="ok", version=VERSION)


# ---------------------------------------------------------------- auth #


@app.post("/auth/apple", response_model=AuthOut)
@limiter.limit("5/minute")
def auth_apple(
    request: Request,
    body: AppleTokenIn,
    db: Session = Depends(get_db),
) -> AuthOut:
    claims = verify_apple_token(body.identity_token)
    user_id = claims["sub"]
    email = claims.get("email")

    user = db.get(User, user_id)
    if user is None:
        user = User(id=user_id, email=email)
        db.add(user)
    elif email and user.email != email:
        # Apple may share the email only on first login - keep it if we get it.
        user.email = email
    db.commit()

    session_token = issue_session_token(user_id)
    return AuthOut(
        session_token=session_token,
        user=UserOut(id=user.id, email=user.email),
    )


@app.get("/auth/me", response_model=UserOut)
def auth_me(user: User = Depends(get_current_user)) -> UserOut:
    return UserOut(id=user.id, email=user.email)


# ---------------------------------------------------------------- photos #


ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png"}


def _user_uploads(user_id: str) -> Path:
    p = UPLOADS_DIR / user_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _user_processed(user_id: str) -> Path:
    p = PROCESSED_DIR / user_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _validate_photo_id(photo_id: str) -> str:
    """Reject anything that isn't a UUIDv4 hex string."""
    try:
        uuid.UUID(photo_id, version=4)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="invalid photo_id")
    return photo_id


def _photo_to_out(p: Photo) -> PhotoOut:
    return PhotoOut(
        photo_id=p.id,
        filename=f"{p.id}_final.jpg",
        size_kb=round(p.size_bytes / 1024, 1),
        size_bytes=p.size_bytes,
        ocr_confidence=p.ocr_confidence,
        ocr_detected_date=p.ocr_detected_date,
        processed_at=p.processed_at,
        exif_embedded=p.exif_embedded,
        created_at=p.created_at,
    )


@app.post("/scan", response_model=ScanOut)
@limiter.limit("10/minute")
async def scan(
    request: Request,
    photo: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ScanOut:
    """Save an uploaded photo, run OCR, return the detected date.

    Free-tier users get ``FREE_SCAN_LIMIT`` scans total; exceeding it
    returns 402 with a structured body the app uses to pop the paywall.
    The quota check + recording happen inside one transaction so two
    parallel uploads at scan #25 can't both win.
    """
    if photo.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content-type {photo.content_type!r}",
        )

    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="upload too large")

    # Quota check. Wrap in BEGIN IMMEDIATE on SQLite to serialize the
    # read-then-write against concurrent /scan calls. On Postgres, the
    # row-level lock on the User row achieves the same.
    bind = db.get_bind()
    fresh_user = (
        db.query(User).filter(User.id == user.id).with_for_update().one_or_none()
        if bind.dialect.name != "sqlite"
        else db.get(User, user.id)
    )
    if fresh_user is None:
        raise HTTPException(status_code=401, detail="User not found")
    snap = entitled(fresh_user)
    if snap.tier == "free" and snap.scans_remaining <= 0:
        raise HTTPException(
            status_code=402,
            detail={
                "code": "quota_exhausted",
                "scans_used": snap.scans_used,
                "limit": FREE_SCAN_LIMIT,
                "product_id": PRODUCT_ID,
            },
        )

    photo_id = uuid.uuid4().hex
    target = _user_uploads(user.id) / f"{photo_id}.jpg"
    try:
        contents = await photo.read()
        if len(contents) > settings.max_upload_bytes:
            raise HTTPException(status_code=413, detail="upload too large")
        target.write_bytes(contents)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to save upload")
        raise HTTPException(status_code=500, detail="upload failed") from e

    logger.info("Saved upload %s (%d bytes)", target, target.stat().st_size)

    result = detect_date_in_image(str(target))
    detected_date: date_type | None = None
    if result.date is not None:
        detected_date = date_type(
            result.date.year, result.date.month, result.date.day
        )

    db.add(
        Photo(
            id=photo_id,
            user_id=fresh_user.id,
            original_filename=photo.filename,
            size_bytes=target.stat().st_size,
            ocr_detected_date=detected_date,
            ocr_confidence=result.confidence,
        )
    )
    record_scan(db, fresh_user, photo_id=photo_id, counted=True)
    db.commit()

    return ScanOut(
        photo_id=photo_id,
        detected=result.detected,
        date=(
            DateInput(
                year=result.date.year,
                month=result.date.month,
                day=result.date.day,
            )
            if result.date is not None
            else None
        ),
        confidence=result.confidence,
    )


@app.post("/process/{photo_id}", response_model=ProcessOut)
@limiter.limit("30/minute")
def process(
    request: Request,
    photo_id: str,
    body: ProcessRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProcessOut:
    """Embed *body.date* into the upload's EXIF and write the final JPEG."""
    photo_id = _validate_photo_id(photo_id)
    photo_row = db.get(Photo, photo_id)
    if photo_row is None or photo_row.user_id != user.id:
        raise HTTPException(status_code=404, detail="photo not found")

    src = _user_uploads(user.id) / f"{photo_id}.jpg"
    if not src.exists():
        raise HTTPException(status_code=404, detail="upload not found")

    target = safe_target_path(_user_processed(user.id), photo_id)
    embedded = embed_date_in_exif(
        str(src),
        str(target),
        year=body.date.year,
        month=body.date.month,
        day=body.date.day,
        source=body.source,
    )

    photo_row.processed_at = datetime.now(timezone.utc)
    photo_row.exif_embedded = embedded
    db.commit()

    return ProcessOut(
        photo_id=photo_id,
        processed_path=f"/processed/{user.id}/{target.name}",
        exif_embedded=embedded,
    )


@app.get("/download/{photo_id}")
def download(
    photo_id: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    """Serve the processed JPEG as an attachment, scoped to the caller."""
    photo_id = _validate_photo_id(photo_id)
    target = safe_target_path(_user_processed(user.id), photo_id)
    if not target.exists():
        raise HTTPException(status_code=404, detail="processed photo not found")
    return FileResponse(
        path=str(target),
        media_type="image/jpeg",
        filename=target.name,
    )


@app.get("/photos", response_model=PhotoListOut)
def list_photos(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PhotoListOut:
    """List the caller's processed photos, newest first."""
    rows = (
        db.query(Photo)
        .filter(Photo.user_id == user.id)
        .order_by(Photo.created_at.desc())
        .all()
    )
    items = [_photo_to_out(p) for p in rows]
    return PhotoListOut(photos=items, count=len(items))


@app.get("/photos/{photo_id}", response_model=PhotoOut)
def get_photo(
    photo_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PhotoOut:
    photo_id = _validate_photo_id(photo_id)
    p = db.get(Photo, photo_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="photo not found")
    return _photo_to_out(p)


@app.delete("/photos/{photo_id}", status_code=204)
def delete_photo(
    photo_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Remove a photo: DB row + upload + processed file. Idempotent."""
    photo_id = _validate_photo_id(photo_id)
    p = db.get(Photo, photo_id)
    if p is None or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="photo not found")

    upload = _user_uploads(user.id) / f"{photo_id}.jpg"
    processed = safe_target_path(_user_processed(user.id), photo_id)
    for f in (upload, processed):
        try:
            f.unlink(missing_ok=True)
        except OSError:
            logger.exception("Failed to unlink %s during delete", f)

    db.delete(p)
    db.commit()


# ---------------------------------------------------------------- billing #


class VerifyReceiptIn(BaseModel):
    signed_transaction_jws: str = Field(..., min_length=10)


@app.get("/billing/status")
def billing_status(user: User = Depends(get_current_user)) -> dict:
    """Return the user's entitlement snapshot. Cheap; client caches it."""
    return entitled(user).to_dict()


@app.post("/billing/verify-receipt")
def verify_receipt(
    body: VerifyReceiptIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Verify a StoreKit-signed transaction and bind it to the caller.

    The app POSTs the ``jwsRepresentation`` from a successful purchase
    (or each item from a Restore-Purchases flow). We verify Apple's
    signature, optionally cross-check via the App Store Server API for
    a fresh status, then upsert ``Subscription`` + project onto User.
    """
    try:
        claims = verify_apple_jws(body.signed_transaction_jws)
    except AppleVerificationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    fresh = fetch_transaction(
        claims.get("transactionId", ""),
        environment=str(claims.get("environment", "Sandbox")),
    )
    effective = fresh or claims

    apply_transaction(db, user, effective, raw_payload=body.signed_transaction_jws)
    db.commit()
    return entitled(user).to_dict()


@app.post("/billing/apple-notifications")
async def apple_notifications(
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """App Store Server Notifications V2 webhook.

    No auth header — trust comes from JWS signature + chain validation.
    Idempotent on ``transactionId``: replays are safe.
    """
    body = await request.json()
    signed = body.get("signedPayload")
    if not signed:
        raise HTTPException(status_code=400, detail="missing signedPayload")
    try:
        notif = verify_apple_jws(signed)
    except AppleVerificationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    notif_type = notif.get("notificationType")
    data = notif.get("data") or {}
    signed_tx = data.get("signedTransactionInfo")
    if not signed_tx:
        logger.info("Apple notification %s with no transaction body", notif_type)
        return {"ok": True}
    try:
        tx_claims = verify_apple_jws(signed_tx)
    except AppleVerificationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    original_id = (
        tx_claims.get("originalTransactionId") or tx_claims.get("transactionId")
    )
    if not original_id:
        raise HTTPException(status_code=400, detail="missing originalTransactionId")

    sub = (
        db.query(Subscription)
        .filter(Subscription.original_transaction_id == original_id)
        .one_or_none()
    )
    if sub is None:
        logger.info(
            "Apple notification for unknown original_transaction_id %s; dropping",
            original_id,
        )
        return {"ok": True}
    user = db.get(User, sub.user_id)
    if user is None:
        return {"ok": True}
    apply_transaction(
        db,
        user,
        tx_claims,
        notification_type=notif_type,
        raw_payload=signed,
    )
    db.commit()
    return {"ok": True}
