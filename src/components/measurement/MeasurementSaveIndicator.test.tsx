import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MeasurementWorkspace from './MeasurementWorkspace';
import { newMeasuredRow, type MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import type { MeasurementRepository } from '@/lib/measurementWorkspaceStore';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

it('mostra confirmação da nuvem quando a resposta da tarefa se perdeu mas a operação foi confirmada', async () => {
  const actor = { id: 'editor', name: 'Editor', canEdit: true };
  let confirmed: Workspace = {
    schema: 1, projectId: 'p', projectName: 'Obra', revision: 0,
    services: [0, 1].map(index => ({
      id: `s${index}`, item: `1.${index + 1}`, description: `Serviço ${index}`,
      unit: 'UN', contracted: 100, priceNoBDI: 1, priceWithBDI: 1, bdi: 0,
      importedPrice: true, chapterId: 'c', chapter: 'Capítulo', path: 'Capítulo', availableFromNumber: 1,
    })),
    periods: [{ id: 'm', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'draft' }],
    entries: [{ projectId: 'p', measurementId: 'm', serviceId: 's0', rows: [newMeasuredRow('r0')] }],
    plans: [], audit: [], importedKeys: [], backupId: 'b',
  };
  const repository: MeasurementRepository = {
    savedLabel: 'Salvo na nuvem',
    load: vi.fn(async () => confirmed),
    initialize: vi.fn(async () => confirmed),
    commit: vi.fn(async candidate => {
      confirmed = candidate;
      throw new Error('Resposta perdida depois da confirmação');
    }),
    confirmedOperation: vi.fn(async (operationId, revision) =>
      confirmed.revision >= revision && confirmed.audit.some(event => event.id === operationId)),
    pending: vi.fn(async () => null),
    pendingSaves: vi.fn(async () => []),
    archivePending: vi.fn(async () => undefined),
    backup: vi.fn(async () => null),
    drafts: vi.fn(async () => []),
    writeDraft: vi.fn(async () => undefined),
    clearDraft: vi.fn(async () => undefined),
  };

  render(<MeasurementWorkspace repository={repository} actor={actor} />);
  const first = await screen.findByLabelText('Quantidade de Serviço 0');
  fireEvent.change(first, { target: { value: '3' } });
  fireEvent.blur(first);
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 1'));
  const retry = await screen.findByRole('button', { name: 'Reenviar 1.1' });
  expect(retry).toBeVisible();
  expect(screen.getByText('Aguardando envio à nuvem')).toBeVisible();

  fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Reenviar 1.1' })).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByText('Salvo e conferido na nuvem')).toBeVisible());
  expect(screen.queryByText('Aguardando envio à nuvem')).not.toBeInTheDocument();
  expect(repository.commit).toHaveBeenCalledTimes(1);
  expect(confirmed.entries[0].rows[0].multiplier).toBe(3);
});
