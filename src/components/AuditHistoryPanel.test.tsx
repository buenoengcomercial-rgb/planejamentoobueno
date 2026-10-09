import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AuditHistoryPanel from './AuditHistoryPanel';
import type { Project } from '@/types/project';
const mocks = vi.hoisted(() => ({ page: vi.fn(), detail: vi.fn() }));
vi.mock('@/lib/auditHistory', () => ({ loadAuditHistoryPage: mocks.page, loadAuditHistoryDetail: mocks.detail }));
const project = { id: 'project-1', name: 'Obra', phases: [], auditLogs: [] } as unknown as Project;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.page.mockResolvedValue({ logs: [{ id: 'audit-1', at: '2026-10-09T12:00:00Z', entityType: 'measurement', entityId: 'measurement-1', action: 'updated', title: 'Medição corrigida' }], hasMore: false });
  mocks.detail.mockResolvedValue({ id: 'audit-1', at: '2026-10-09T12:00:00Z', action: 'updated', title: 'Medição corrigida', before: 2, after: 3 });
});
describe('consulta do Histórico', () => {
  it('não consulta com painel fechado e busca detalhes somente por ação explícita', async () => {
    const props = { project, entityType: 'measurement' as const, entityId: 'measurement-1', onOpenChange: vi.fn() };
    const view = render(<AuditHistoryPanel {...props} open={false} />);
    expect(mocks.page).not.toHaveBeenCalled();
    view.rerender(<AuditHistoryPanel {...props} open />);
    expect(await screen.findByText('Medição corrigida')).toBeInTheDocument();
    expect(mocks.detail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }));
    expect(await screen.findByText('Antes')).toBeInTheDocument();
    expect(mocks.detail).toHaveBeenCalledWith(project.id, 'audit-1');
    expect(project.auditLogs).toEqual([]);
  });
  it('mostra erro de histórico em vez de afirmar que nenhum evento existe', async () => {
    mocks.page.mockRejectedValue(new Error('504'));
    render(<AuditHistoryPanel project={project} entityType="measurement" entityId="measurement-1" open onOpenChange={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar');
    expect(screen.queryByText('Nenhum evento registrado ainda.')).not.toBeInTheDocument();
  });
});
