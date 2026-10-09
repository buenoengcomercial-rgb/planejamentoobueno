import { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { getCurrentMembership, OrgMembership } from '@/lib/organizations';
import { withReadDeadline } from '@/lib/readDeadline';

interface OrgContextValue {
  membership: OrgMembership | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}
const OrgContext = createContext<OrgContextValue | undefined>(undefined);

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [state, setState] = useState<{ userId?: string; membership: OrgMembership | null; loading: boolean; error: string | null }>({ membership: null, loading: true, error: null });
  const sequence = useRef(0);
  const userId = user?.id;
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    if (!userId) {
      setState({ membership: null, loading: false, error: null });
      return;
    }
    setState(previous => ({ userId, membership: previous.userId === userId ? previous.membership : null, loading: true, error: null }));
    try {
      const membership = await withReadDeadline(getCurrentMembership());
      if (request === sequence.current) setState({ userId, membership, loading: false, error: null });
    } catch {
      if (request === sequence.current) setState(previous => ({ ...previous, loading: false, error: 'Não foi possível verificar o acesso à empresa. Confira sua conexão e tente novamente.' }));
    }
  }, [userId]);
  useEffect(() => {
    if (!authLoading) void reload();
    // Request version ref: discard reads resolving after cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { sequence.current++; };
  }, [authLoading, reload]);
  const sameUser = state.userId === userId;
  return <OrgContext.Provider value={{ membership: sameUser ? state.membership : null, loading: authLoading || !sameUser || (state.loading && !state.membership), error: sameUser ? state.error : null, reload }}>{children}</OrgContext.Provider>;
}

export function useOrganization() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrganization must be used within OrganizationProvider');
  return ctx;
}
