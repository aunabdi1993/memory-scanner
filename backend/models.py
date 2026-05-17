"""SQLAlchemy ORM models."""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    """One row per Apple-authenticated account.

    ``id`` is Apple's stable ``sub`` claim (per app + per Apple ID).
    Apple may return a private-relay email or omit email entirely after
    the first login, hence the nullable column.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )


class Photo(Base):
    """One row per scanned photo (uploaded JPEG + OCR result + EXIF status).

    ``id`` is a UUIDv4 hex string generated when the upload lands in
    /scan; the on-disk path is ``UPLOADS_DIR/{user_id}/{id}.jpg``.
    """

    __tablename__ = "photos"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(255), ForeignKey("users.id"), nullable=False, index=True
    )
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    ocr_detected_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    ocr_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    processed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    exif_embedded: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
