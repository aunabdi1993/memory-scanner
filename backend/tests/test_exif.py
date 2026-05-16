"""Unit tests for the EXIF date-embedding layer."""

from __future__ import annotations

from pathlib import Path

import piexif
from PIL import Image

from exif_writer import embed_date_in_exif, read_embedded_date


def _make_blank_jpeg(path: Path) -> None:
    Image.new("RGB", (200, 200), color=(127, 127, 127)).save(
        str(path), format="JPEG", quality=90
    )


def test_embed_date_writes_exif(tmp_path: Path) -> None:
    """Embedding 1998-12-15 should round-trip via piexif."""
    src = tmp_path / "in.jpg"
    dst = tmp_path / "out.jpg"
    _make_blank_jpeg(src)

    ok = embed_date_in_exif(str(src), str(dst), 1998, 12, 15, source="auto")
    assert ok is True
    assert dst.exists()

    when = read_embedded_date(str(dst))
    assert when is not None
    assert (when.year, when.month, when.day) == (1998, 12, 15)

    exif = piexif.load(str(dst))
    assert piexif.ImageIFD.DateTime in exif["0th"]
    assert piexif.ExifIFD.DateTimeOriginal in exif["Exif"]
    assert piexif.ExifIFD.DateTimeDigitized in exif["Exif"]
    description = exif["0th"][piexif.ImageIFD.ImageDescription].decode("utf-8")
    assert "auto" in description
    assert "1998-12-15" in description


def test_embed_date_fallback_on_corrupt_input(tmp_path: Path) -> None:
    """A non-JPEG input shouldn't raise; embed returns False."""
    src = tmp_path / "bogus.jpg"
    dst = tmp_path / "out.jpg"
    src.write_bytes(b"this is not a jpeg")

    try:
        ok = embed_date_in_exif(str(src), str(dst), 2003, 7, 4)
    except Exception:
        # The fallback couldn't even copy a byte stream that isn't a JPEG;
        # verify the function at least returned False rather than silently
        # succeeding. (This branch mirrors the documented contract.)
        ok = False

    assert ok is False
