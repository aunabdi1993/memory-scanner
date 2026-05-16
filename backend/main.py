"""Memories Scanner backend.

FastAPI service that receives a printed-photo upload, runs OCR on the
date stamp, embeds the detected/manual date into EXIF metadata, and
serves the processed JPEG back to the app.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from exif_writer import embed_date_in_exif, safe_target_path
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

app = FastAPI(title="Memories Scanner", version=VERSION)

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


ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/heic"}


@app.post("/scan")
async def scan(photo: UploadFile = File(...)) -> dict:
    """Save an uploaded photo, run OCR, and return the detected date."""
    if photo.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content-type {photo.content_type!r}",
        )

    photo_id = uuid.uuid4().hex
    target = UPLOADS_DIR / f"{photo_id}.jpg"
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


def _upload_path(photo_id: str) -> Path:
    return UPLOADS_DIR / f"{photo_id}.jpg"


@app.post("/process/{photo_id}")
def process(photo_id: str, body: ProcessRequest) -> dict:
    """Embed *body.date* into the upload's EXIF and write the final JPEG."""
    src = _upload_path(photo_id)
    if not src.exists():
        raise HTTPException(status_code=404, detail="upload not found")

    target = safe_target_path(PROCESSED_DIR, photo_id)
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
        "processed_path": f"/processed/{target.name}",
        "exif_embedded": embedded,
    }


@app.get("/download/{photo_id}")
def download(photo_id: str) -> FileResponse:
    """Serve the processed JPEG as an attachment."""
    target = safe_target_path(PROCESSED_DIR, photo_id)
    if not target.exists():
        raise HTTPException(status_code=404, detail="processed photo not found")
    return FileResponse(
        path=str(target),
        media_type="image/jpeg",
        filename=target.name,
    )


@app.get("/photos")
def list_photos() -> dict:
    """List processed photos, newest first, with size and timestamp."""
    items = []
    for f in PROCESSED_DIR.glob("*_final.jpg"):
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


@app.on_event("startup")
def on_startup() -> None:
    logger.info("Memories Scanner backend %s starting", VERSION)
    logger.info("Uploads dir:   %s", UPLOADS_DIR)
    logger.info("Processed dir: %s", PROCESSED_DIR)
    logger.info("CORS origins:  %s", allowed_origins)
