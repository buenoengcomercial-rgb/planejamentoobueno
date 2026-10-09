import { createContext, useContext, useEffect, useState, useRef, useCallback, ReactNode } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { withReadDeadline } from '@/lib/readDeadline';

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string, name?: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const result = await withReadDeadline(supabase.auth.getSession());
      if (result.error) throw result.error;
      if (request !== sequence.current) return;
      const s = result.data.session;
      setSession(s);
      setUser(prev => prev?.id === s?.user?.id ? prev : s?.user ?? null);
    } catch {
      if (request === sequence.current) setError('Não foi possível verificar sua sessão. Confira sua conexão e tente novamente.');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Set up listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      // Avoid swapping the user object reference on TOKEN_REFRESHED / USER_UPDATED
      // when the identity didn't actually change. Otherwise downstream effects
      // (org reload, queries) re-run every time the tab regains focus.
      setUser(prev => {
        const next = s?.user ?? null;
        if (prev?.id === next?.id) return prev;
        return next;
      });
    });

    void reload();
    // Request version ref: discard reads resolving after cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { sequence.current++; subscription.unsubscribe(); };
  }, [reload]);

  const signIn: AuthContextValue['signIn'] = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  };

  const signUp: AuthContextValue['signUp'] = async (email, password, name) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/`,
        data: name ? { name } : undefined,
      },
    });
    return { error: error?.message ?? null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, error, reload, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
