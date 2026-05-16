"""Memories Scanner backend.

FastAPI service that receives a printed-photo upload, runs OCR on the
date stamp, embeds the detected/manual date into EXIF metadata, and
serves the processed JPEG back to the app.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

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


@app.on_event("startup")
def on_startup() -> None:
    logger.info("Memories Scanner backend %s starting", VERSION)
    logger.info("Uploads dir:   %s", UPLOADS_DIR)
    logger.info("Processed dir: %s", PROCESSED_DIR)
    logger.info("CORS origins:  %s", allowed_origins)
