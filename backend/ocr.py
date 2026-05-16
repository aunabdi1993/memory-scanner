"""OCR pipeline for printed disposable-camera date stamps.

Pipeline overview:

  crop_date_region(img)        bottom-right 30% box where the stamp lives
  preprocess_for_ocr(img)      LAB + CLAHE, 3x upscale, amber-mask isolation
  parse_detected_date(text)    regex-pull the four common stamp formats
  detect_date_in_image(path)   orchestrate cropped + full-image strategies
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date as date_cls
from typing import Optional

import cv2
import numpy as np
import pytesseract

logger = logging.getLogger(__name__)

DATE_REGION_RATIO = 0.30
UPSCALE_FACTOR = 3
ORANGE_RATIO_THRESHOLD = 0.02

# HSV range for the amber/orange of disposable-camera date stamps.
# OpenCV hue is 0-179, so 5-25 covers ~10-50 deg in the standard color wheel.
AMBER_LOWER = np.array([5, 80, 80], dtype=np.uint8)
AMBER_UPPER = np.array([25, 255, 255], dtype=np.uint8)


MONTH_NAME_TO_NUM = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


@dataclass
class DateParts:
    year: int
    month: int
    day: int

    def to_dict(self) -> dict:
        return {"year": self.year, "month": self.month, "day": self.day}


def crop_date_region(img: np.ndarray) -> np.ndarray:
    """Return the bottom-right 30% sub-image where the stamp typically appears."""
    if img is None or img.size == 0:
        raise ValueError("crop_date_region: empty image")
    h, w = img.shape[:2]
    y0 = int(h * (1 - DATE_REGION_RATIO))
    x0 = int(w * (1 - DATE_REGION_RATIO))
    return img[y0:h, x0:w]


def preprocess_for_ocr(img: np.ndarray) -> np.ndarray:
    """Boost the amber stamp into a clean binary image for Tesseract.

    Steps:
      1. LAB + CLAHE on the L channel to flatten lighting on aged prints.
      2. Upscale 3x so thin strokes survive thresholding.
      3. HSV amber mask. If less than ~2% of pixels look orange, fall
         back to grayscale + Otsu (handles black-stamp prints too).
      4. Light denoise so JPEG noise doesn't break Tesseract.
    """
    if img is None or img.size == 0:
        raise ValueError("preprocess_for_ocr: empty image")

    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    l_channel = clahe.apply(l_channel)
    enhanced = cv2.merge([l_channel, a_channel, b_channel])
    enhanced = cv2.cvtColor(enhanced, cv2.COLOR_LAB2BGR)

    upscaled = cv2.resize(
        enhanced,
        None,
        fx=UPSCALE_FACTOR,
        fy=UPSCALE_FACTOR,
        interpolation=cv2.INTER_CUBIC,
    )

    hsv = cv2.cvtColor(upscaled, cv2.COLOR_BGR2HSV)
    amber_mask = cv2.inRange(hsv, AMBER_LOWER, AMBER_UPPER)
    orange_ratio = float(np.count_nonzero(amber_mask)) / amber_mask.size

    if orange_ratio >= ORANGE_RATIO_THRESHOLD:
        binary = amber_mask
    else:
        gray = cv2.cvtColor(upscaled, cv2.COLOR_BGR2GRAY)
        _, binary = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
        )

    denoised = cv2.fastNlMeansDenoising(binary, h=10)
    return denoised


def _two_digit_year_to_full(yy: int) -> int:
    """Disposable cameras peaked 1985-2005, so >=90 -> 1900s, else 2000s."""
    return 1900 + yy if yy >= 90 else 2000 + yy


def _validate(year: int, month: int, day: int) -> Optional[DateParts]:
    """Return DateParts if (y, m, d) is a real calendar date in our window."""
    if not (1950 <= year <= 2030):
        return None
    if not (1 <= month <= 12):
        return None
    if not (1 <= day <= 31):
        return None
    try:
        date_cls(year, month, day)
    except ValueError:
        return None
    return DateParts(year=year, month=month, day=day)


# Patterns are tried in order. Each capture group order is documented inline.
_PATTERN_MDYY = re.compile(r"\b(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2})\b")
_PATTERN_YYMMDD = re.compile(r"\b(\d{2})[ .\-](\d{1,2})[ .\-](\d{1,2})\b")
_PATTERN_DD_MON_YYYY = re.compile(
    r"\b(\d{1,2})\s+([A-Z]{3})\s+(\d{4})\b", re.IGNORECASE
)
_PATTERN_ISO = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")


def parse_detected_date(text: str) -> Optional[DateParts]:
    """Extract a date from raw OCR text.

    Recognized formats, tried in order:
      1. MM/DD/YY (slashes, dots, dashes, or spaces)
      2. YY MM DD (two-digit-year first variant)
      3. DD MON YYYY (e.g. "12 JUL 1998")
      4. YYYY-MM-DD ISO

    Returns the first match that validates as a real calendar date in
    our 1950-2030 window, else None.
    """
    if not text:
        return None
    text = text.upper().strip()

    m = _PATTERN_MDYY.search(text)
    if m:
        month, day, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
        result = _validate(_two_digit_year_to_full(yy), month, day)
        if result is not None:
            return result

    m = _PATTERN_YYMMDD.search(text)
    if m:
        yy, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
        result = _validate(_two_digit_year_to_full(yy), month, day)
        if result is not None:
            return result

    m = _PATTERN_DD_MON_YYYY.search(text)
    if m:
        day = int(m.group(1))
        month = MONTH_NAME_TO_NUM.get(m.group(2).upper())
        year = int(m.group(3))
        if month is not None:
            result = _validate(year, month, day)
            if result is not None:
                return result

    m = _PATTERN_ISO.search(text)
    if m:
        year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
        result = _validate(year, month, day)
        if result is not None:
            return result

    return None


# Tesseract config: digit + month-letter whitelist, three PSMs to try.
_TESSERACT_PSMS = (6, 7, 11)
_DIGIT_WHITELIST = (
    "-c tessedit_char_whitelist="
    "0123456789/.-:JANFEBMRPYULGSOCTNVDjanfebmrpyulgsoctnvd "
)


def _ocr_with_psms(img: np.ndarray) -> str:
    """Run Tesseract with each PSM and concatenate the output."""
    chunks: list[str] = []
    for psm in _TESSERACT_PSMS:
        try:
            cfg = f"--oem 3 --psm {psm} {_DIGIT_WHITELIST}"
            chunks.append(pytesseract.image_to_string(img, config=cfg))
        except pytesseract.TesseractError as e:
            logger.warning("Tesseract failed at PSM %s: %s", psm, e)
    return "\n".join(chunks)


@dataclass
class DetectionResult:
    detected: bool
    date: Optional[DateParts]
    confidence: float

    def to_dict(self) -> dict:
        return {
            "detected": self.detected,
            "date": self.date.to_dict() if self.date else None,
            "confidence": self.confidence,
        }


def detect_date_in_image(image_path: str) -> DetectionResult:
    """Run the two-strategy OCR pipeline against a JPEG on disk.

    Strategy 1: crop the bottom-right region (where the stamp lives),
    preprocess, OCR with multiple PSMs (~0.85 confidence on success).
    Strategy 2: full-image OCR fallback (~0.55 confidence on success).
    """
    img = cv2.imread(image_path)
    if img is None:
        logger.warning("detect_date_in_image: cannot read %s", image_path)
        return DetectionResult(detected=False, date=None, confidence=0.0)

    try:
        cropped = crop_date_region(img)
        preprocessed_crop = preprocess_for_ocr(cropped)
        text = _ocr_with_psms(preprocessed_crop)
        date = parse_detected_date(text)
        if date is not None:
            return DetectionResult(detected=True, date=date, confidence=0.85)
    except Exception:
        logger.exception("Cropped-region OCR failed")

    try:
        preprocessed_full = preprocess_for_ocr(img)
        text = _ocr_with_psms(preprocessed_full)
        date = parse_detected_date(text)
        if date is not None:
            return DetectionResult(detected=True, date=date, confidence=0.55)
    except Exception:
        logger.exception("Full-image OCR failed")

    return DetectionResult(detected=False, date=None, confidence=0.0)
