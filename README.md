# Memories Scanner

Scan printed disposable-camera photos, OCR the date stamp, embed it into
EXIF metadata, then save back to your iPhone Photos library, iCloud
Drive, or Google Drive.

A React Native (Expo) iOS app with a FastAPI + Tesseract + OpenCV
backend. Sign in with Apple — no passwords stored anywhere.

## Repo layout

```
backend/   FastAPI service (OCR, EXIF, auth, photo storage)
app/       Expo SDK 54 app (expo-router, TypeScript)
docs/      Design notes, screenshots
```

## Quick start

```bash
# One-time install (Tesseract via brew/apt, Python venv, npm)
make install

# Run the backend (port 8000)
make backend

# In another terminal, run the app
make app
```

If `make install` can't install Tesseract automatically (no Homebrew on
macOS, or no sudo on Linux), install it yourself, then rerun
`make install` to pick up the Python/Node deps.

For per-package details:

- Backend: see [`backend/README.md`](backend/README.md).
- App: see [`app/README.md`](app/README.md).

## Configuration

Copy each `.env.example` to `.env` and fill in:

- `backend/.env`: `APPLE_CLIENT_ID`, `SESSION_SECRET`, `DATABASE_URL`,
  `ALLOWED_ORIGINS`.
- `app/.env`: `EXPO_PUBLIC_BACKEND_URL` (defaults to
  `http://localhost:8000`).

## Auth

Sign in with Apple is the only sign-in path. The backend verifies
Apple's identity-token JWT against Apple's JWKS, then issues a
short-lived session JWT. We never see or store passwords.

## CI

GitHub Actions runs `flake8` on the backend and `tsc --noEmit` on the
app for every push and PR. See
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).
