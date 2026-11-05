import { createContext } from 'react';
import type { Session, User } from '@supabase/supabase-js';

export interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string, name?: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

// Keep the context outside the refreshable provider/hook module so mounted
// providers and refreshed consumers always use the same context identity.
export const AuthContext = createContext<AuthContextValue | undefined>(undefined);