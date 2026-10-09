import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrganizationProvider, useOrganization } from './useOrganization';
const mocks = vi.hoisted(() => ({ user: { id: 'user-1' }, load: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock('@/lib/organizations', () => ({ getCurrentMembership: mocks.load }));
function Probe() {
  const { loading, membership, error, reload } = useOrganization();
  return <><span>{loading ? 'loading' : error ? 'technical-error' : membership ? membership.organization.id : 'pending'}</span><button onClick={() => void reload()}>retry</button></>;
}
beforeEach(() => { mocks.user = { id: 'user-1' }; mocks.load.mockReset(); });
describe('falhas de acesso', () => {
  it('distingue timeout de acesso pendente e permite nova tentativa', async () => {
    mocks.load.mockRejectedValueOnce(new Error('504')).mockResolvedValueOnce({ organization: { id: 'org-1' } });
    render(<OrganizationProvider><Probe /></OrganizationProvider>);
    expect(await screen.findByText('technical-error')).toBeInTheDocument();
    expect(screen.queryByText('pending')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('retry'));
    expect(await screen.findByText('org-1')).toBeInTheDocument();
  });
  it('mantém acesso pendente somente para consulta válida sem vínculo', async () => {
    mocks.load.mockResolvedValue(null);
    render(<OrganizationProvider><Probe /></OrganizationProvider>);
    expect(await screen.findByText('pending')).toBeInTheDocument();
  });
  it('não incorpora acesso de uma identidade anterior em resposta tardia', async () => {
    let resolve!: (value: unknown) => void;
    mocks.load.mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValueOnce(null);
    const view = render(<OrganizationProvider><Probe /></OrganizationProvider>);
    mocks.user = { id: 'user-2' };
    view.rerender(<OrganizationProvider><Probe /></OrganizationProvider>);
    expect(await screen.findByText('pending')).toBeInTheDocument();
    await act(async () => resolve({ organization: { id: 'old-org' } }));
    expect(screen.queryByText('old-org')).not.toBeInTheDocument();
  });
});
