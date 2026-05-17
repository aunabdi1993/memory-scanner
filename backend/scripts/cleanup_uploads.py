"""Delete orphaned upload files older than N days.

A photo can become orphaned if:
  - the user deleted the DB row but the unlink races / fails,
  - a /scan crashed after writing the upload but before the Photo row
    committed.

Usage:
    DATABASE_URL=... ./venv/bin/python scripts/cleanup_uploads.py --days 30
    # add --dry-run to print without deleting

Designed to be run as a cron / scheduled task on the Fly machine.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

# Allow running from inside `backend/`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import SessionLocal  # noqa: E402
from models import Photo  # noqa: E402

logger = logging.getLogger("cleanup")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    uploads_dir = Path(os.getenv("UPLOADS_DIR", "uploads")).resolve()
    if not uploads_dir.exists():
        logger.info("Uploads dir %s does not exist; nothing to do", uploads_dir)
        return 0

    cutoff = time.time() - args.days * 86400
    deleted = 0
    skipped = 0

    with SessionLocal() as db:
        known_ids = {row[0] for row in db.query(Photo.id).all()}

    for user_dir in uploads_dir.iterdir():
        if not user_dir.is_dir():
            continue
        for f in user_dir.glob("*.jpg"):
            photo_id = f.stem
            if photo_id in known_ids:
                continue  # still referenced
            if f.stat().st_mtime > cutoff:
                continue  # too recent
            if args.dry_run:
                logger.info("[dry-run] would delete %s", f)
            else:
                try:
                    f.unlink()
                    deleted += 1
                    logger.info("deleted %s", f)
                except OSError:
                    skipped += 1
                    logger.exception("failed to delete %s", f)

    logger.info("done: deleted=%d skipped=%d", deleted, skipped)
    return 0


if __name__ == "__main__":
    sys.exit(main())
