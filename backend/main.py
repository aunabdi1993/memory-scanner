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
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
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
from config import get_settings
from exif_writer import embed_date_in_exif, safe_target_path
from middleware import RequestIdMiddleware
from models import Photo, User
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
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(RequestIdMiddleware)
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
    """Reject anything that isn't a UUIDv4 hex string.

    Both /process/{id} and /download/{id} feed photo_id into a filesystem
    path. Without this check, a value like '../other-user/secret' would
    happily traverse outside the caller's namespace.
    """
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
    """Save an uploaded photo, run OCR, return the detected date."""
    if photo.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content-type {photo.content_type!r}",
        )

    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="upload too large")

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
        detected_date = date_type(result.date["year"], result.date["month"], result.date["day"])

    db.add(
        Photo(
            id=photo_id,
            user_id=user.id,
            original_filename=photo.filename,
            size_bytes=target.stat().st_size,
            ocr_detected_date=detected_date,
            ocr_confidence=result.confidence,
        )
    )
    db.commit()

    return ScanOut(
        photo_id=photo_id,
        detected=result.detected,
        date=DateInput(**result.date) if result.date else None,
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
