import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './useAuth';
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), onAuthStateChange: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: mocks } }));
function Probe() { const { loading, error, reload, user } = useAuth(); return <><span>{loading ? 'loading' : error ? 'technical-error' : user ? 'authenticated' : 'signed-out'}</span><button onClick={() => void reload()}>retry</button></>; }
beforeEach(() => { vi.clearAllMocks(); mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }); });
afterEach(() => vi.useRealTimers());
describe('abertura da sessão', () => {
  it('does not restore an old session after a newer sign-out event', async () => {
    let resolveSession: (value: unknown) => void;
    let listener: (event: string, session: unknown) => void;
    mocks.getSession.mockReturnValue(new Promise(resolve => { resolveSession = resolve; }));
    mocks.onAuthStateChange.mockImplementation(callback => { listener = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
    render(<AuthProvider><Probe /></AuthProvider>);
    act(() => listener('SIGNED_OUT', null));
    await act(async () => resolveSession({ data: { session: { user: { id: 'old-user' } } }, error: null }));
    expect(screen.getByText('signed-out')).toBeInTheDocument();
  });
  it('encerra requisição pendurada e oferece recuperação', async () => {
    vi.useFakeTimers();
    mocks.getSession.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce({ data: { session: { user: { id: 'user-1' } } }, error: null });
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByText('technical-error')).toBeInTheDocument();
    fireEvent.click(screen.getByText('retry'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('authenticated')).toBeInTheDocument();
  });
});
