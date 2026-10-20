import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ProjectHeaderSyncStatus from './ProjectHeaderSyncStatus';

vi.mock('@/components/SaveStatusIndicator', () => ({
  default: ({ status }: { status: string }) => <output data-testid="general-save-status">{status}</output>,
}));

const base = {
  activeView: 'measurement', independentMeasurement: true, status: 'saved' as const,
  confirmedAt: '2026-10-20T10:00:00Z', lastCheckedAt: null, projectId: 'obra-1',
  live: true, remoteUpdateAt: null, pendingRemoteAreas: [], partialSyncPending: false,
  partialSyncDraftProtected: false, syncRetrying: false, dailyReportHasErrors: false,
};

describe('status de sincronização por área', () => {
  it('deixa a Medição independente apresentar sua própria confirmação', () => {
    render(<ProjectHeaderSyncStatus {...base} />);
    expect(screen.queryByTestId('general-save-status')).not.toBeInTheDocument();
  });

  it('identifica falha de outra área sem atribuí-la à Medição', () => {
    render(<ProjectHeaderSyncStatus {...base} status="error" />);
    expect(screen.getByText('Outras áreas da obra')).toBeInTheDocument();
    expect(screen.getByTestId('general-save-status')).toHaveTextContent('error');
  });

  it('identifica pendência do Diário ao visualizar outra aba', () => {
    render(<ProjectHeaderSyncStatus {...base} activeView="tasks" independentMeasurement={false} dailyReportHasErrors />);
    expect(screen.getByText('Pendência no Diário de Obra')).toBeInTheDocument();
    expect(screen.getByTestId('general-save-status')).toHaveTextContent('error');
  });
});
