# Memories Scanner — App

Expo SDK 51 (React Native + TypeScript) iOS app.

## Setup

```bash
npm install
npx expo start
```

Scan the QR code with the Expo Go app, or press `i` to open in the iOS
simulator.

## Configuration

Copy `.env.example` to `.env` and set `EXPO_PUBLIC_BACKEND_URL` to your
backend's address (the LAN IP of the host machine when testing on a
real iPhone, or `http://localhost:8000` for the simulator).

## Layout

```
app/                expo-router file-based screens
  _layout.tsx       Stack navigator wrapping the app
  index.tsx         home (PR 7)
  scan.tsx          camera + capture (PR 8)
  review.tsx        date confirm + save (PR 9)
  library.tsx       processed photos (PR 10)
  login.tsx         Sign in with Apple (PR 14)
constants/theme.ts  vintage-film palette + fonts
services/api.ts     backend HTTP wrapper
services/auth.ts    Apple sign-in + session storage (PR 14)
contexts/           AuthContext (PR 14)
components/         shared UI bits (PR 13)
```

## Type-check

```bash
npm run typecheck
```

## Notes

- `usesAppleSignIn` is enabled in `app.json` — Sign in with Apple will
  only work in a real iOS build with a configured bundle ID
  (`com.memoriesscanner.app`) and an Apple Developer team.
- The camera/library/media-library permissions are declared in
  `infoPlist`. iOS will prompt on first use.
```
