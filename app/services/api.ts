/**
 * Typed wrapper around the backend HTTP API.
 *
 * BASE_URL is read from the EXPO_PUBLIC_BACKEND_URL env var (or
 * expo-constants extra), defaulting to http://localhost:8000.
 */

import Constants from 'expo-constants';

export const BASE_URL: string =
  process.env.EXPO_PUBLIC_BACKEND_URL ??
  (Constants.expoConfig?.extra as { backendUrl?: string } | undefined)?.backendUrl ??
  'http://localhost:8000';

export interface HealthResponse {
  status: string;
  version: string;
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface ScanResponse {
  photo_id: string;
  detected: boolean;
  date: DateParts | null;
  confidence: number;
}

export interface ProcessResponse {
  photo_id: string;
  processed_path: string;
  exif_embedded: boolean;
}

export interface PhotoSummary {
  photo_id: string;
  filename: string;
  size_kb: number;
  processed_at: string;
}

export interface PhotoListResponse {
  photos: PhotoSummary[];
  count: number;
}

/** Throw a descriptive error on non-2xx responses. */
async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body?.detail) detail = String(body.detail);
  } catch {
    // ignore parse errors
  }
  throw new Error(`API error: ${detail}`);
}

/** GET /health — ping the backend. */
export async function checkHealth(): Promise<HealthResponse> {
  const res = await fetch(`${BASE_URL}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  await ensureOk(res);
  return (await res.json()) as HealthResponse;
}

/**
 * Marker thrown by every public function in this module — callers can
 * tell our errors from generic ones with `instanceof ApiError`.
 */
export class ApiError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * POST /scan — upload a JPEG and run OCR.
 *
 * @param uri  Local file:// URI from the camera or image picker.
 */
export async function scanPhoto(uri: string): Promise<ScanResponse> {
  const form = new FormData();
  form.append('photo', {
    uri,
    name: 'photo.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/scan`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new ApiError('Network error during scan', e);
  }
  await ensureOk(res);
  return (await res.json()) as ScanResponse;
}

/** POST /process/{id} — embed the chosen date into EXIF. */
export async function processPhoto(
  photoId: string,
  date: DateParts,
  source: 'auto' | 'manual',
): Promise<ProcessResponse> {
  const res = await fetch(`${BASE_URL}/process/${photoId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, source }),
    signal: AbortSignal.timeout(30000),
  });
  await ensureOk(res);
  return (await res.json()) as ProcessResponse;
}

/** Returns the URL the app should download the processed JPEG from. */
export function downloadUrl(photoId: string): string {
  return `${BASE_URL}/download/${photoId}`;
}

/** GET /photos — list the user's processed photos. */
export async function listPhotos(): Promise<PhotoListResponse> {
  const res = await fetch(`${BASE_URL}/photos`, {
    signal: AbortSignal.timeout(15000),
  });
  await ensureOk(res);
  return (await res.json()) as PhotoListResponse;
}
