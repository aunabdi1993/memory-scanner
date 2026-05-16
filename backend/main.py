"""Memories Scanner backend.

FastAPI service that receives a printed-photo upload, runs OCR on the
date stamp, embeds the detected/manual date into EXIF metadata, and
serves the processed JPEG back to the app.
"""

from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from auth import (
    get_current_user,
    get_db,
    issue_session_token,
    verify_apple_token,
)
from db import init_db
from exif_writer import embed_date_in_exif, safe_target_path
from models import User
from ocr import detect_date_in_image

load_dotenv()

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("memories-scanner")

UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", "uploads")).resolve()
PROCESSED_DIR = Path(os.getenv("PROCESSED_DIR", "processed")).resolve()
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

VERSION = "1.0.0"


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    init_db()
    logger.info("Memories Scanner backend %s starting", VERSION)
    logger.info("Uploads dir:   %s", UPLOADS_DIR)
    logger.info("Processed dir: %s", PROCESSED_DIR)
    logger.info("CORS origins:  %s", allowed_origins)
    yield


app = FastAPI(title="Memories Scanner", version=VERSION, lifespan=lifespan)

allowed_origins_raw = os.getenv("ALLOWED_ORIGINS", "*")
allowed_origins = (
    ["*"]
    if allowed_origins_raw.strip() == "*"
    else [o.strip() for o in allowed_origins_raw.split(",") if o.strip()]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
app.mount("/processed", StaticFiles(directory=str(PROCESSED_DIR)), name="processed")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": VERSION}


# ---------------------------------------------------------------- auth #


class AppleTokenIn(BaseModel):
    identity_token: str


class AuthOut(BaseModel):
    session_token: str
    user: dict


@app.post("/auth/apple", response_model=AuthOut)
def auth_apple(body: AppleTokenIn, db: Session = Depends(get_db)) -> AuthOut:
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
        user={"id": user.id, "email": user.email},
    )


@app.get("/auth/me")
def auth_me(user: User = Depends(get_current_user)) -> dict:
    return {"id": user.id, "email": user.email}


# ---------------------------------------------------------------- photos #


ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/heic"}


def _user_uploads(user_id: str) -> Path:
    p = UPLOADS_DIR / user_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _user_processed(user_id: str) -> Path:
    p = PROCESSED_DIR / user_id
    p.mkdir(parents=True, exist_ok=True)
    return p


@app.post("/scan")
async def scan(
    photo: UploadFile = File(...),
    user: User = Depends(get_current_user),
) -> dict:
    """Save an uploaded photo, run OCR, and return the detected date."""
    if photo.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content-type {photo.content_type!r}",
        )

    photo_id = uuid.uuid4().hex
    target = _user_uploads(user.id) / f"{photo_id}.jpg"
    try:
        contents = await photo.read()
        target.write_bytes(contents)
    except Exception as e:
        logger.exception("Failed to save upload")
        raise HTTPException(status_code=500, detail="upload failed") from e

    logger.info("Saved upload %s (%d bytes)", target, target.stat().st_size)

    result = detect_date_in_image(str(target))
    return {"photo_id": photo_id, **result.to_dict()}


class DateInput(BaseModel):
    year: int = Field(..., ge=1950, le=2030)
    month: int = Field(..., ge=1, le=12)
    day: int = Field(..., ge=1, le=31)


class ProcessRequest(BaseModel):
    date: DateInput
    source: Literal["auto", "manual"] = "auto"


@app.post("/process/{photo_id}")
def process(
    photo_id: str,
    body: ProcessRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """Embed *body.date* into the upload's EXIF and write the final JPEG."""
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
    return {
        "photo_id": photo_id,
        "processed_path": f"/processed/{user.id}/{target.name}",
        "exif_embedded": embedded,
    }


@app.get("/download/{photo_id}")
def download(
    photo_id: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    """Serve the processed JPEG as an attachment, scoped to the caller."""
    target = safe_target_path(_user_processed(user.id), photo_id)
    if not target.exists():
        raise HTTPException(status_code=404, detail="processed photo not found")
    return FileResponse(
        path=str(target),
        media_type="image/jpeg",
        filename=target.name,
    )


@app.get("/photos")
def list_photos(user: User = Depends(get_current_user)) -> dict:
    """List the caller's processed photos, newest first."""
    items = []
    for f in _user_processed(user.id).glob("*_final.jpg"):
        stat = f.stat()
        items.append(
            {
                "photo_id": f.stem.removesuffix("_final"),
                "filename": f.name,
                "size_kb": round(stat.st_size / 1024, 1),
                "processed_at": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
            }
        )
    items.sort(key=lambda x: x["processed_at"], reverse=True)
    return {"photos": items, "count": len(items)}
