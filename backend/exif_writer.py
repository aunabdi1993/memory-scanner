"""Embed a captured-date into a JPEG's EXIF metadata.

Why piexif over Pillow's exif kwarg: we need to write three datetime
fields (DateTime in 0th IFD, DateTimeOriginal and DateTimeDigitized in
the Exif IFD) plus an ImageDescription marker. piexif round-trips the
existing IFDs cleanly; Pillow's high-level API silently drops anything
it doesn't recognise.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

import piexif
from PIL import Image

logger = logging.getLogger(__name__)

EXIF_DATE_FORMAT = "%Y:%m:%d %H:%M:%S"


def _build_exif_bytes(
    source_path: str,
    when: datetime,
    description: str,
) -> bytes:
    """Read existing EXIF (if any) and overlay our three datetime fields."""
    try:
        existing = piexif.load(source_path)
    except Exception:
        existing = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}

    stamp = when.strftime(EXIF_DATE_FORMAT).encode("ascii")
    existing.setdefault("0th", {})
    existing.setdefault("Exif", {})
    existing["0th"][piexif.ImageIFD.DateTime] = stamp
    existing["0th"][piexif.ImageIFD.ImageDescription] = description.encode("utf-8")
    existing["Exif"][piexif.ExifIFD.DateTimeOriginal] = stamp
    existing["Exif"][piexif.ExifIFD.DateTimeDigitized] = stamp

    # piexif chokes on a None thumbnail key in some files; drop it.
    if existing.get("thumbnail") is None and "thumbnail" in existing:
        existing["thumbnail"] = None

    return piexif.dump(existing)


def embed_date_in_exif(
    source_path: str,
    target_path: str,
    year: int,
    month: int,
    day: int,
    source: str = "auto",
) -> bool:
    """Re-encode JPEG at *source_path* to *target_path* with EXIF dates set.

    *source* should be ``"auto"`` (detected by OCR) or ``"manual"`` (entered
    by the user). The marker is stored in ImageDescription so it survives
    round-trips through other tools.

    Returns True if EXIF was embedded. On any failure, falls back to
    copying the JPEG without EXIF and returns False (callers shouldn't
    crash on a single bad photo).
    """
    when = datetime(year, month, day, 12, 0, 0)
    marker = f"Memories Scanner: date {source} ({year}-{month:02d}-{day:02d})"

    try:
        exif_bytes = _build_exif_bytes(source_path, when, marker)
        with Image.open(source_path) as im:
            rgb = im.convert("RGB")
            rgb.save(target_path, format="JPEG", quality=95, exif=exif_bytes)
        logger.info("Embedded EXIF date %s into %s", when.date(), target_path)
        return True
    except Exception:
        logger.exception("EXIF embed failed; saving JPEG without metadata")
        try:
            with Image.open(source_path) as im:
                im.convert("RGB").save(target_path, format="JPEG", quality=95)
        except Exception:
            logger.exception("Fallback save also failed for %s", source_path)
            # Re-raise: if we can't even copy the file, the caller should know.
            raise
        return False


def read_embedded_date(path: str) -> Optional[datetime]:
    """Return the DateTimeOriginal embedded in *path*, or None if absent."""
    try:
        exif = piexif.load(path)
    except Exception:
        return None
    raw = exif.get("Exif", {}).get(piexif.ExifIFD.DateTimeOriginal)
    if not raw:
        raw = exif.get("0th", {}).get(piexif.ImageIFD.DateTime)
    if not raw:
        return None
    try:
        return datetime.strptime(raw.decode("ascii"), EXIF_DATE_FORMAT)
    except Exception:
        return None


def safe_target_path(processed_dir: Path, photo_id: str) -> Path:
    """Standardised output path: processed/{photo_id}_final.jpg."""
    return processed_dir / f"{photo_id}_final.jpg"
