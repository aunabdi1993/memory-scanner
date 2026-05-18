import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  ApiError,
  getBillingStatus,
  type EntitlementSnapshot,
} from '../services/api';
import { useAuth } from './AuthContext';

interface EntitlementContextValue {
  snapshot: EntitlementSnapshot | null;
  isLoading: boolean;
  /** True for active/grace subscribers; false on free tier or while loading. */
  isPro: boolean;
  /** -1 means unlimited; otherwise scans left on the free tier. */
  scansRemaining: number;
  /** Re-fetch from the backend. Call after every successful scan or purchase. */
  refresh: () => Promise<void>;
}

const EntitlementContext = createContext<EntitlementContextValue | undefined>(
  undefined,
);

export function EntitlementProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<EntitlementSnapshot | null>(null);
  const [isLoading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    try {
      const snap = await getBillingStatus();
      setSnapshot(snap);
    } catch (e) {
      // Swallow read errors; the scan flow will surface a server-side
      // 402 if the cached snapshot is stale.
      if (!(e instanceof ApiError)) throw e;
    } finally {
      setLoading(false);
    }
  }, [user]);

  // Fetch once on sign-in, clear on sign-out.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<EntitlementContextValue>(() => {
    const tier = snapshot?.tier ?? 'free';
    return {
      snapshot,
      isLoading,
      isPro: tier === 'pro',
      scansRemaining: snapshot?.scans_remaining ?? Infinity,
      refresh,
    };
  }, [snapshot, isLoading, refresh]);

  return (
    <EntitlementContext.Provider value={value}>
      {children}
    </EntitlementContext.Provider>
  );
}

export function useEntitlement(): EntitlementContextValue {
  const ctx = useContext(EntitlementContext);
  if (!ctx) {
    throw new Error('useEntitlement must be used inside <EntitlementProvider>');
  }
  return ctx;
}
