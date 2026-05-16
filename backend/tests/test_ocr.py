"""Unit tests for the OCR date-parsing layer.

These cover regex parsing only and do not invoke the Tesseract binary.
"""

from ocr import parse_detected_date


def test_parse_mdyy_format():
    """MM/DD/YY with 90s year rolls into the 1900s."""
    result = parse_detected_date("12/15/98")
    assert result is not None
    assert result.to_dict() == {"year": 1998, "month": 12, "day": 15}


def test_parse_iso_format():
    """ISO YYYY-MM-DD passes through unchanged."""
    result = parse_detected_date("2003-07-04")
    assert result is not None
    assert result.to_dict() == {"year": 2003, "month": 7, "day": 4}


def test_invalid_date_returns_none():
    """A month of 13 must not be accepted, even with valid surrounding fields."""
    assert parse_detected_date("13/45/99") is None
    assert parse_detected_date("nothing here") is None
    assert parse_detected_date("") is None


def test_two_digit_year_under_90_is_2000s():
    """YY < 90 maps to the 2000s (e.g. 05 -> 2005)."""
    result = parse_detected_date("06/12/05")
    assert result is not None
    assert result.year == 2005


def test_dd_mon_yyyy_format():
    """e.g. 12 JUL 1998 should resolve correctly."""
    result = parse_detected_date("12 JUL 1998")
    assert result is not None
    assert result.to_dict() == {"year": 1998, "month": 7, "day": 12}
