# iOS Release Runbook

End-to-end steps to ship a TestFlight build from a clean checkout.

## One-time setup

### 1. Apple Developer Program

- Enroll the team account at <https://developer.apple.com/programs/>
  (US$99/yr). Personal accounts work; team accounts give you internal
  TestFlight distribution.

### 2. Apple identifiers

In the Apple Developer portal:

- **App ID**: identifier `com.memoriesscanner.app` (matches
  `app/app.json:ios.bundleIdentifier`). Enable the **Sign in with Apple**
  capability.
- **Service ID** (for Sign in with Apple verification on the server):
  identifier `com.memoriesscanner.app`. Same string as the App ID is
  fine; what matters is that `APPLE_CLIENT_ID` on the backend equals
  the `aud` claim Apple stamps into identity tokens, which is the
  bundle id.

### 3. Hosted backend

iOS builds bake the backend URL into the bundle, so the staging /
production backends must be reachable over HTTPS **before** the first
build.

Set `EXPO_PUBLIC_BACKEND_URL` in `app/eas.json` to your real domains
(currently `https://staging.example.com` / `https://api.example.com`
as placeholders). Set the matching `APPLE_CLIENT_ID` and
`SESSION_SECRET` in the backend env.

### 4. EAS account + credentials

```bash
npm install -g eas-cli
eas login                # one-time per machine
cd app
eas credentials          # follow the prompts: let EAS manage signing
```

EAS will create or import the iOS distribution cert and the App Store
provisioning profile and store them in the EAS cloud.

## Per-release flow

### Simulator preview (no signing)

```bash
cd app
eas build --platform ios --profile preview
```

Produces an `.app` you can drag into Xcode's Simulator. Useful for
smoke-testing the bundle against staging before paying for an over-
the-air build.

### TestFlight build

```bash
cd app
eas build --platform ios --profile production
```

EAS bumps `ios.buildNumber` (because of `autoIncrement: true`),
compiles, signs, and uploads the `.ipa`. Build takes ~15-25 min the
first time, ~10 min cached.

### Submit to TestFlight

```bash
eas submit --platform ios --latest
```

First submission asks for App Store Connect API key credentials.
Subsequent submissions reuse them.

The build appears in **App Store Connect → TestFlight → iOS** after
~10 min of Apple processing. Add internal testers (no review needed)
or external testers (one-time beta review, ~24h).

## Smoke test on the build

1. Install via TestFlight on a real iPhone.
2. Sign in with Apple → confirm `/auth/apple` returns 200 in backend
   logs.
3. Scan a photo → `/scan` 200 → review screen shows the OCR badge.
4. Save to Photos → confirm the saved photo's EXIF "Date Taken" matches.
5. Trigger Sentry (force a render error in a dev build via the
   `react-devtools` shake menu) → confirm event in Sentry within 30s.

## Common pitfalls

- **`APPLE_CLIENT_ID` mismatch** → `/auth/apple` returns 401 with
  "Invalid Apple token: Audience doesn't match". Check that the value
  in `backend/.env` equals `app/app.json:ios.bundleIdentifier`.
- **Forgot to update `EXPO_PUBLIC_BACKEND_URL` per profile** → app
  hits `localhost:8000` from a real device. Hard-coded in the bundle;
  requires a new build to change.
- **Sentry events not showing** → Sentry's React Native SDK only loads
  in dev clients and release builds, not Expo Go. Test with a
  development build (`eas build --profile development`).
