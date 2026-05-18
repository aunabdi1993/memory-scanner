/**
 * StoreKit (Apple In-App Purchase) glue.
 *
 * Wraps ``expo-iap`` for the three flows the paywall needs:
 *   • initialise the connection (idempotent)
 *   • fetch the localized price for the Pro product
 *   • purchase / restore + send the resulting JWS to our backend
 *
 * All four operations are exposed as simple async functions so the
 * paywall screen can read like a script. Errors are surfaced via the
 * thrown exceptions from expo-iap — we don't swallow them.
 */

import { Platform } from 'react-native';

import { verifyReceipt, type EntitlementSnapshot } from './api';

/**
 * Product identifiers as configured in App Store Connect. Must match
 * the server-side constants in backend/billing.py.
 *
 * PRO_PRODUCT_ID: auto-renewing monthly subscription.
 * LIFETIME_PRODUCT_ID: non-consumable one-time purchase.
 */
export const PRO_PRODUCT_ID = 'com.memoriesscanner.pro.monthly';
export const LIFETIME_PRODUCT_ID = 'com.memoriesscanner.pro.lifetime';

interface IapModule {
  initConnection: () => Promise<boolean>;
  endConnection: () => Promise<void>;
  getSubscriptions: (skus: { ios?: string[]; android?: string[] }) => Promise<
    Array<{ id: string; displayPrice?: string; price?: string; currency?: string }>
  >;
  getProducts: (skus: { ios?: string[]; android?: string[] }) => Promise<
    Array<{ id: string; displayPrice?: string; price?: string; currency?: string }>
  >;
  requestPurchase: (params: {
    sku?: string;
    skus?: string[];
    ios?: { sku: string };
    android?: { skus: string[]; subscriptionOffers?: unknown[] };
  }) => Promise<unknown>;
  getAvailablePurchases: () => Promise<
    Array<{
      id?: string;
      productId?: string;
      transactionId?: string;
      purchaseToken?: string;
      jwsRepresentationIos?: string;
      transactionReceipt?: string;
    }>
  >;
  finishTransaction: (params: {
    purchase: unknown;
    isConsumable?: boolean;
  }) => Promise<void>;
}

let _iap: IapModule | null | undefined;
let _initialized = false;

/**
 * Lazily resolve expo-iap. Tests / Expo Go (which can't run StoreKit)
 * will get null and the paywall will refuse to render a Subscribe
 * button, falling back to "Open in App Store" copy.
 */
function loadIap(): IapModule | null {
  if (_iap !== undefined) return _iap;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _iap = require('expo-iap') as IapModule;
  } catch {
    _iap = null;
  }
  return _iap;
}

export function isIapAvailable(): boolean {
  return Platform.OS === 'ios' && loadIap() !== null;
}

export async function initIAP(): Promise<void> {
  if (_initialized) return;
  const mod = loadIap();
  if (!mod) return;
  await mod.initConnection();
  _initialized = true;
}

export async function endIAP(): Promise<void> {
  if (!_initialized) return;
  const mod = loadIap();
  if (!mod) return;
  try {
    await mod.endConnection();
  } finally {
    _initialized = false;
  }
}

export interface ProProduct {
  id: string;
  /** Localized display price from StoreKit, e.g. "£4.99". Never hardcoded. */
  displayPrice: string;
}

export async function getProProduct(): Promise<ProProduct | null> {
  const mod = loadIap();
  if (!mod) return null;
  await initIAP();
  const list = await mod.getSubscriptions({ ios: [PRO_PRODUCT_ID] });
  const match = list.find((p) => p.id === PRO_PRODUCT_ID) ?? list[0];
  if (!match) return null;
  return {
    id: match.id,
    displayPrice: match.displayPrice ?? match.price ?? '',
  };
}

/**
 * Fetch the non-consumable lifetime IAP. Distinct from the subscription
 * lookup because Apple separates products from subscriptions in the
 * StoreKit API surface.
 */
export async function getLifetimeProduct(): Promise<ProProduct | null> {
  const mod = loadIap();
  if (!mod) return null;
  await initIAP();
  const list = await mod.getProducts({ ios: [LIFETIME_PRODUCT_ID] });
  const match = list.find((p) => p.id === LIFETIME_PRODUCT_ID) ?? list[0];
  if (!match) return null;
  return {
    id: match.id,
    displayPrice: match.displayPrice ?? match.price ?? '',
  };
}

async function runPurchase(sku: string): Promise<EntitlementSnapshot> {
  const mod = loadIap();
  if (!mod) throw new Error('In-app purchase is not available in this build.');
  await initIAP();
  const purchase = (await mod.requestPurchase({
    sku,
    ios: { sku },
  })) as
    | {
        jwsRepresentationIos?: string;
        transactionReceipt?: string;
      }
    | undefined;
  const jws = purchase?.jwsRepresentationIos ?? purchase?.transactionReceipt;
  if (!jws) throw new Error('Apple returned no transaction JWS to verify.');
  const snapshot = await verifyReceipt(jws);
  try {
    await mod.finishTransaction({ purchase, isConsumable: false });
  } catch {
    // Non-fatal: the backend already accepted the entitlement.
  }
  return snapshot;
}

/**
 * Kick off the StoreKit purchase sheet for the monthly subscription.
 * Returns the entitlement snapshot the backend produced after
 * verifying the receipt.
 */
export async function purchaseMonthly(): Promise<EntitlementSnapshot> {
  return runPurchase(PRO_PRODUCT_ID);
}

/**
 * Kick off the StoreKit purchase sheet for the non-consumable lifetime
 * IAP. Same verification path as the subscription — the backend
 * classifies the entitlement by productId.
 */
export async function purchaseLifetime(): Promise<EntitlementSnapshot> {
  return runPurchase(LIFETIME_PRODUCT_ID);
}

/**
 * Replay every active purchase tied to the current Apple ID through
 * the backend so a fresh install / new device picks up the entitlement.
 *
 * Returns the freshest entitlement we observed. If the Apple ID has no
 * Pro purchase, returns null.
 */
export async function restorePurchases(): Promise<EntitlementSnapshot | null> {
  const mod = loadIap();
  if (!mod) throw new Error('In-app purchase is not available in this build.');
  await initIAP();
  const purchases = await mod.getAvailablePurchases();
  let latest: EntitlementSnapshot | null = null;
  for (const p of purchases) {
    const jws = p.jwsRepresentationIos ?? p.transactionReceipt;
    if (!jws) continue;
    latest = await verifyReceipt(jws);
  }
  return latest;
}
