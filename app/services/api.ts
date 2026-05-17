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

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Base error every public function in this module throws. */
export class ApiError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

/** TCP/DNS/CORS-level failure — backend was never reached. */
export class NetworkError extends ApiError {
  constructor(message = 'Network unreachable', cause?: unknown) {
    super(message, cause);
    this.name = 'NetworkError';
  }
}

/** Request didn't complete inside the per-call timeout. */
export class TimeoutError extends ApiError {
  constructor(message = 'Request timed out', cause?: unknown) {
    super(message, cause);
    this.name = 'TimeoutError';
  }
}

/** Backend responded but with a 4xx/5xx. */
export class HttpError extends ApiError {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * 402 from /scan when the free tier is exhausted. Carries the parsed
 * detail so the scan screen can route straight to the paywall with
 * accurate "X of Y scans used" copy.
 */
export class QuotaExhaustedError extends HttpError {
  constructor(
    public readonly scansUsed: number,
    public readonly limit: number,
    public readonly productId: string,
  ) {
    super(402, `Free quota exhausted (${scansUsed}/${limit})`);
    this.name = 'QuotaExhaustedError';
  }
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 30_000;

interface RequestOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

/**
 * Set by AuthContext on mount: returns the current session token (or
 * null if signed out). We avoid a hard import to dodge a circular
 * dependency between api.ts and auth.ts.
 */
let sessionTokenProvider: (() => Promise<string | null>) | null = null;

export function setSessionTokenProvider(
  fn: (() => Promise<string | null>) | null,
): void {
  sessionTokenProvider = fn;
}

async function attempt(path: string, opts: RequestOptions): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = opts;
  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (sessionTokenProvider) {
    const token = await sessionTokenProvider();
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') {
      throw new TimeoutError(`Timed out after ${timeoutMs}ms`, e);
    }
    throw new NetworkError('Could not reach the backend', e);
  }

  if (!res.ok) {
    let detail: unknown = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail !== undefined) detail = body.detail;
    } catch {
      // body wasn't JSON — keep status text.
    }
    throw buildHttpError(res.status, detail);
  }
  return res;
}

function buildHttpError(status: number, detail: unknown): HttpError {
  if (
    status === 402 &&
    detail &&
    typeof detail === 'object' &&
    (detail as { code?: string }).code === 'quota_exhausted'
  ) {
    const d = detail as {
      scans_used?: number;
      limit?: number;
      product_id?: string;
    };
    return new QuotaExhaustedError(
      d.scans_used ?? 0,
      d.limit ?? 0,
      d.product_id ?? '',
    );
  }
  return new HttpError(status, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await attempt(path, opts);
    } catch (e) {
      lastErr = e;
      // Skip retry on 4xx — the request itself is wrong, not the network.
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) throw e;
      if (i < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
      }
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** GET /health — ping the backend. Throws on any failure. */
export async function checkHealth(): Promise<HealthResponse> {
  const res = await request('/health', { timeoutMs: 5_000 });
  return (await res.json()) as HealthResponse;
}

/**
 * Lower-noise version of {@link checkHealth} for the home-screen status
 * dot: returns 'ok' or 'unreachable' instead of throwing.
 */
export async function connectivityCheck(): Promise<'ok' | 'unreachable'> {
  try {
    const h = await checkHealth();
    return h.status === 'ok' ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
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
  const res = await request('/scan', { method: 'POST', body: form });
  return (await res.json()) as ScanResponse;
}

/**
 * Same as {@link scanPhoto} but reports upload progress 0-1 via *onProgress*.
 *
 * Uses XMLHttpRequest because fetch doesn't expose upload progress in
 * React Native. Used by the scan screen's progress bar (PR 13).
 */
export async function scanPhotoWithProgress(
  uri: string,
  onProgress?: (fraction: number) => void,
): Promise<ScanResponse> {
  const token = sessionTokenProvider ? await sessionTokenProvider() : null;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}/scan`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.timeout = DEFAULT_TIMEOUT_MS;

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress(ev.loaded / ev.total);
      }
    };
    xhr.ontimeout = () =>
      reject(new TimeoutError(`Timed out after ${DEFAULT_TIMEOUT_MS}ms`));
    xhr.onerror = () => reject(new NetworkError('Could not reach the backend'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as ScanResponse);
        } catch (e) {
          reject(new ApiError('Malformed scan response', e));
        }
      } else {
        let detail: unknown = `${xhr.status} ${xhr.statusText}`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body?.detail !== undefined) detail = body.detail;
        } catch {
          // not json
        }
        reject(buildHttpError(xhr.status, detail));
      }
    };

    const form = new FormData();
    form.append('photo', {
      uri,
      name: 'photo.jpg',
      type: 'image/jpeg',
    } as unknown as Blob);
    xhr.send(form);
  });
}

/** POST /process/{id} — embed the chosen date into EXIF. */
export async function processPhoto(
  photoId: string,
  date: DateParts,
  source: 'auto' | 'manual',
): Promise<ProcessResponse> {
  const res = await request(`/process/${photoId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, source }),
  });
  return (await res.json()) as ProcessResponse;
}

/** Returns the URL the app should download the processed JPEG from. */
export function downloadUrl(photoId: string): string {
  return `${BASE_URL}/download/${photoId}`;
}

/** GET /photos — list the user's processed photos. */
export async function listPhotos(): Promise<PhotoListResponse> {
  const res = await request('/photos', { timeoutMs: 15_000 });
  return (await res.json()) as PhotoListResponse;
}

/** Warn callers when a file is over the practical upload size. */
export const LARGE_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Helper: returns true if a file size in bytes exceeds the warning threshold. */
export function isLargeUpload(sizeBytes: number): boolean {
  return sizeBytes > LARGE_UPLOAD_BYTES;
}

/* ------------------------------------------------------------------ */
/* Billing                                                             */
/* ------------------------------------------------------------------ */

export interface EntitlementSnapshot {
  tier: 'free' | 'pro';
  scans_used: number;
  /** -1 indicates unlimited (Pro). Otherwise free-tier remaining. */
  scans_remaining: number;
  expires_at: string | null;
  /** "lifetime" is set for non-consumable-IAP owners. */
  status: 'free' | 'active' | 'grace' | 'expired' | 'refunded' | 'lifetime';
  free_limit: number;
  /** Monthly subscription product identifier. */
  product_id: string;
  /** Non-consumable lifetime IAP identifier. */
  lifetime_product_id?: string;
  /** True if the user owns the lifetime IAP. */
  has_lifetime?: boolean;
}

/** GET /billing/status — fetch the user's current entitlement. */
export async function getBillingStatus(): Promise<EntitlementSnapshot> {
  const res = await request('/billing/status', { timeoutMs: 10_000 });
  return (await res.json()) as EntitlementSnapshot;
}

/**
 * POST /billing/verify-receipt — hand a StoreKit-signed transaction JWS
 * to the backend. Returns the freshly-projected entitlement.
 *
 * Called once on every successful purchase, and once per JWS during a
 * Restore-Purchases flow.
 */
export async function verifyReceipt(
  signedTransactionJws: string,
): Promise<EntitlementSnapshot> {
  const res = await request('/billing/verify-receipt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signed_transaction_jws: signedTransactionJws }),
  });
  return (await res.json()) as EntitlementSnapshot;
}
