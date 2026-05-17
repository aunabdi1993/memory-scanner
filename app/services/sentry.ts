/**
 * Sentry init wrapper.
 *
 * Safe to call from app startup. No-op when EXPO_PUBLIC_SENTRY_DSN is
 * unset (dev / Expo Go), so the same code paths work in every build.
 */

import * as Sentry from '@sentry/react-native';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
const ENV = process.env.EXPO_PUBLIC_ENV ?? 'development';

let initialized = false;

export function initSentry(): void {
  if (initialized || !DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend(event) {
      // Strip the email claim — it can come from Apple's relay address.
      if (event.user?.email) delete event.user.email;
      return event;
    },
  });
  initialized = true;
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!DSN) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
