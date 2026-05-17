"""SQLAlchemy ORM models."""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    """One row per Apple-authenticated account.

    ``id`` is Apple's stable ``sub`` claim (per app + per Apple ID).
    Apple may return a private-relay email or omit email entirely after
    the first login, hence the nullable column.

    Billing columns are a denormalized projection of the latest row in
    ``Subscription`` so the hot path (``/scan``) can answer entitlement
    questions with a single primary-key lookup.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )

    lifetime_scans: Mapped[int] = mapped_column(
        Integer, default=0, nullable=False, server_default="0"
    )
    subscription_status: Mapped[str] = mapped_column(
        String(16), default="free", nullable=False, server_default="free"
    )
    subscription_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    apple_original_transaction_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    has_lifetime: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default="0"
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
    original_filename: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
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


class UsageLog(Base):
    """Append-only audit trail of /scan calls.

    ``counted=True`` rows feed the denormalized ``User.lifetime_scans``;
    ``counted=False`` rows record attempts that didn't billably succeed
    (e.g. retained for support / refunds).
    """

    __tablename__ = "usage_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        String(255), ForeignKey("users.id"), nullable=False, index=True
    )
    photo_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    kind: Mapped[str] = mapped_column(
        String(16), default="scan", nullable=False, server_default="scan"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    counted: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False, server_default="1"
    )


class Subscription(Base):
    """One row per Apple subscription, keyed by ``original_transaction_id``.

    Renewals, expiries, refunds, and revokes all arrive as App Store
    Server Notifications V2 keyed on this identifier. ``User`` carries a
    cached projection of the latest status.
    """

    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        String(255), ForeignKey("users.id"), nullable=False, index=True
    )
    original_transaction_id: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True
    )
    product_id: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    environment: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="sandbox"
    )
    last_notification_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    raw_payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    user = relationship("User", lazy="joined")


# Composite index supporting "latest scans per user" reports.
Index("ix_usage_log_user_created", UsageLog.user_id, UsageLog.created_at)
