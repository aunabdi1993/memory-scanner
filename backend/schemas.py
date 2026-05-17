"""Pydantic request/response schemas for the HTTP API."""

from __future__ import annotations

from datetime import date as date_type, datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class HealthOut(BaseModel):
    status: str
    version: str


class AppleTokenIn(BaseModel):
    identity_token: str


class UserOut(BaseModel):
    id: str
    email: Optional[str] = None


class AuthOut(BaseModel):
    session_token: str
    user: UserOut


class DateInput(BaseModel):
    year: int = Field(..., ge=1950, le=2030)
    month: int = Field(..., ge=1, le=12)
    day: int = Field(..., ge=1, le=31)


class ProcessRequest(BaseModel):
    date: DateInput
    source: Literal["auto", "manual"] = "auto"


class ScanOut(BaseModel):
    photo_id: str
    detected: bool
    date: Optional[DateInput] = None
    confidence: float


class ProcessOut(BaseModel):
    photo_id: str
    processed_path: str
    exif_embedded: bool


class PhotoOut(BaseModel):
    photo_id: str
    filename: str
    size_kb: float
    size_bytes: int
    ocr_confidence: Optional[float] = None
    ocr_detected_date: Optional[date_type] = None
    processed_at: Optional[datetime] = None
    exif_embedded: Optional[bool] = None
    created_at: datetime


class PhotoListOut(BaseModel):
    photos: List[PhotoOut]
    count: int
