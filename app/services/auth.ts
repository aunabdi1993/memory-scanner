/**
 * Sign in with Apple + first-party session storage.
 *
 * Flow:
 *   1. AppleAuthentication.signInAsync() returns an identityToken.
 *   2. POST it to /auth/apple, get back our own session JWT.
 *   3. Save the JWT in expo-secure-store (Keychain on iOS).
 *   4. Subsequent api.ts calls attach it as Bearer.
 */

import * as AppleAuthentication from 'expo-apple-authentication';
import * as SecureStore from 'expo-secure-store';

import { ApiError, BASE_URL, HttpError } from './api';

const TOKEN_KEY = 'memories.session.token';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface SignInResult {
  user: AuthUser;
  sessionToken: string;
}

/** Read the persisted session token, or null if signed out. */
export async function getSessionToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function setSessionToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

/** Wipe the session token from secure storage. */
export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // ignored
  }
}

/** Resolves true if Sign in with Apple is usable on this device. */
export function isAppleAuthAvailable(): Promise<boolean> {
  return AppleAuthentication.isAvailableAsync();
}

/**
 * Trigger the native Sign in with Apple sheet, exchange the resulting
 * identity token with our backend, and persist the returned session.
 */
export async function signInWithApple(): Promise<SignInResult> {
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });

  if (!credential.identityToken) {
    throw new ApiError('Apple did not return an identity token');
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/auth/apple`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity_token: credential.identityToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ApiError('Could not reach the backend during sign-in', e);
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      // ignored
    }
    throw new HttpError(res.status, detail);
  }

  const body = (await res.json()) as {
    session_token: string;
    user: AuthUser;
  };
  await setSessionToken(body.session_token);
  return { user: body.user, sessionToken: body.session_token };
}

/** Fetch /auth/me using the persisted session, or null if unauthenticated. */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const token = await getSessionToken();
  if (!token) return null;
  const res = await fetch(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) {
    await clearSession();
    return null;
  }
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return (await res.json()) as AuthUser;
}
