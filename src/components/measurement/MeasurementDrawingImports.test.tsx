import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MeasurementWorkspace from './MeasurementWorkspace';
import { newMeasuredRow, type MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import type { MeasurementRepository } from '@/lib/measurementWorkspaceStore';
import type { TakeoffPlan, TakeoffRepository } from '@/lib/planTakeoff';

vi.mock('@/components/planTakeoff/PlanTakeoff', () => ({ default: ({ repository }: { repository: TakeoffRepository }) =>
  <button onClick={() => { void (async () => {
    let catalog = await repository.load();
    const first: TakeoffPlan = { id: 'floor-0', name: '0º ANDAR.dxf', floor: '0º andar', kind: 'dxf', file: new Blob(['0']), scales: { 1: 1 }, measures: [], chapterId: 'c' };
    catalog = await repository.save([...catalog, first], catalog) ?? [...catalog, first];
    const second: TakeoffPlan = { ...first, id: 'floor-1', name: '1º ANDAR.dxf', floor: '1º andar', file: new Blob(['1']) };
    await repository.save([...catalog, second], catalog);
  })(); }}>Importar duas plantas</button>,
}));

afterEach(cleanup);
beforeEach(() => localStorage.clear());

it('aceita adições consecutivas após o servidor confirmar o caminho da primeira planta', async () => {
  let saved: Workspace = {
    schema: 1, projectId: 'p', projectName: 'Obra', revision: 0,
    services: [{ id: 's', item: '1.1', description: 'Placas', unit: 'UN', contracted: 100, priceNoBDI: 1, priceWithBDI: 1, bdi: 0, importedPrice: true, chapterId: 'c', chapter: 'Prédio', path: 'Prédio', availableFromNumber: 1 }],
    periods: [{ id: 'm', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'draft' }],
    entries: [{ projectId: 'p', measurementId: 'm', serviceId: 's', rows: [newMeasuredRow('r')] }], plans: [], audit: [], importedKeys: [], backupId: 'b',
  };
  const repository: MeasurementRepository = {
    savedLabel: 'Salvo na nuvem', load: vi.fn(async () => saved), initialize: vi.fn(async () => saved),
    commit: vi.fn(async candidate => { saved = { ...candidate, plans: candidate.plans.map(plan => ({ ...plan, storagePath: `p/${plan.id}.dxf` })) }; return saved; }),
    pending: vi.fn(async () => null), pendingSaves: vi.fn(async () => []), archivePending: vi.fn(async () => undefined),
    drafts: vi.fn(async () => []), writeDraft: vi.fn(async () => undefined), clearDraft: vi.fn(async () => undefined), backup: vi.fn(async () => null),
  };
  render(<MeasurementWorkspace repository={repository} actor={{ id: 'u', name: 'Engenheiro', canEdit: true }} />);
  fireEvent.click(await screen.findByLabelText('Quantidade de Placas'));
  fireEvent.focus(screen.getByLabelText('Unidades da linha 1'));
  fireEvent.click(screen.getByRole('button', { name: 'Planta DXF' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Importar duas plantas' }));
  await waitFor(() => expect(saved.plans).toHaveLength(2));
  expect(repository.commit).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('As plantas mudaram. Reabra o visualizador.')).not.toBeInTheDocument();
  expect(saved.entries[0].rows[0].multiplier).toBe(0);
});
