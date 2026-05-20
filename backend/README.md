# Memories Scanner — Backend

FastAPI service that handles photo uploads, OCR date detection, EXIF
embedding, and authenticated user storage.

## Setup

```bash
./setup.sh                       # installs tesseract + venv + deps
source venv/bin/activate
alembic upgrade head             # apply schema migrations
uvicorn main:app --reload --port 8000
```

Or from repo root: `make install && make migrate && make backend`.
(`make backend` runs migrations automatically on startup unless
`RUN_MIGRATIONS_ON_START=false`.)

### Docker

```bash
make docker-build       # builds the production image (Tesseract baked in)
make docker-up          # starts backend on :8000 with a persistent volume
```

Uploads, processed JPEGs, and the SQLite DB all live on the named
`backend_data` volume under `/data`. See `../docker-compose.yml`.

## Endpoints

| Method | Path                  | Description                                  |
|--------|-----------------------|----------------------------------------------|
| GET    | `/health`             | Liveness probe (no auth).                    |
| POST   | `/auth/apple`         | Exchange Apple identity token for session.   |
| GET    | `/auth/me`            | Current user (auth).                         |
| POST   | `/scan`               | Upload photo, run OCR (auth).                |
| POST   | `/process/{photo_id}` | Embed date into EXIF, write final (auth).    |
| GET    | `/download/{photo_id}`| Serve processed JPEG (auth).                 |
| GET    | `/photos`             | List the user's processed photos (auth).     |

## Environment

See [`.env.example`](.env.example). Copy to `.env` for local overrides.

## Tests

```bash
pytest tests/ -v
```

OCR unit tests cover regex parsing only (no Tesseract binary needed).
End-to-end `/scan` testing requires a real `tesseract` install.

## Type checking

```bash
mypy .
```

Config lives in [`mypy.ini`](mypy.ini). `tests/`, `alembic/versions/`, and
`scripts/` are excluded. Third-party libs without stubs
(`piexif`, `pytesseract`, `cv2`, `slowapi`, `pythonjsonlogger`, `alembic`)
have `ignore_missing_imports = True`. Run from `make lint` at the repo
root.

## Layout

```
main.py             FastAPI app, routes, middleware
ocr.py              Image preprocessing + Tesseract pipeline
exif_writer.py      piexif-based EXIF date embedding
auth.py             Apple JWKS verification + session JWTs
db.py / models.py   SQLAlchemy engine + User model
alembic/            Schema migrations (alembic upgrade head)
tests/              pytest suite
uploads/            (gitignored) raw uploads, namespaced per user
processed/          (gitignored) EXIF-embedded results
```
