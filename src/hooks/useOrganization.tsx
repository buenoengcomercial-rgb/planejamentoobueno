import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { getCurrentMembership, OrgMembership } from '@/lib/organizations';

interface OrgContextValue {
  membership: OrgMembership | null;
  loading: boolean;
  reload: () => Promise<void>;
}

const OrgContext = createContext<OrgContextValue | undefined>(undefined);

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [membership, setMembership] = useState<OrgMembership | null>(null);
  const [loading, setLoading] = useState(true);
  const hasLoadedRef = (typeof window !== 'undefined') ? (window as any) : null;

  const reload = useCallback(async () => {
    if (!user) {
      setMembership(null);
      setLoading(false);
      return;
    }
    // Only show loading on the FIRST fetch — silent refresh afterwards
    // so returning to the tab doesn't blank the screen.
    setLoading(prev => (membership ? false : prev));
    try {
      const m = await getCurrentMembership();
      setMembership(m);
    } catch (e) {
      console.error('[org] erro ao carregar empresa', e);
      // Keep previous membership on error to avoid losing UI state.
    } finally {
      setLoading(false);
    }
  }, [user, membership]);

  useEffect(() => {
    if (authLoading) return;
    void reload();
    // Intentionally depend only on user identity, not on the reload callback
    // (which would re-fire on every membership change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  return (
    <OrgContext.Provider value={{ membership, loading, reload }}>
      {children}
    </OrgContext.Provider>
  );
}

export function useOrganization() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrganization must be used within OrganizationProvider');
  return ctx;
}
