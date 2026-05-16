import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { setSessionTokenProvider } from '../services/api';
import {
  clearSession,
  fetchCurrentUser,
  getSessionToken,
  signInWithApple,
  type AuthUser,
} from '../services/auth';

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setLoading] = useState(true);

  // Stable callback ref so api.ts always sees the freshest token.
  const tokenRef = useRef<() => Promise<string | null>>(getSessionToken);
  useEffect(() => {
    setSessionTokenProvider(() => tokenRef.current());
    return () => setSessionTokenProvider(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await fetchCurrentUser();
        if (!cancelled) setUser(u);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async () => {
    const result = await signInWithApple();
    setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    await clearSession();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, isLoading, signIn, signOut }),
    [user, isLoading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
