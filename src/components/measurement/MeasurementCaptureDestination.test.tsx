import { useRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MeasurementWorkspace from './MeasurementWorkspace';
import { captureMeasurement, newMeasuredRow, type MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import type { MeasurementRepository } from '@/lib/measurementWorkspaceStore';
import type { TakeoffMeasure, TakeoffPlan } from '@/lib/planTakeoff';

vi.mock('@/components/planTakeoff/PlanTakeoff', () => ({
  default: function MockDXF({ onUseMeasure, measureContext, destinationColumn }: {
    onUseMeasure: (plan: TakeoffPlan, mark: TakeoffMeasure, result: number, next: TakeoffPlan) => Promise<boolean>;
    measureContext: { projectId: string; measurementId: string; serviceId: string };
    destinationColumn: string;
  }) {
    const plan = useRef<TakeoffPlan>({ id: 'plan', name: 'Teste.dxf', floor: 'Térreo', kind: 'dxf', file: new Blob(), scales: { 1: 1 }, measures: [] });
    const count = useRef(0);
    return <button onClick={() => {
      const mark: TakeoffMeasure = { id: `mark-${++count.current}`, name: `Captura ${count.current}`, kind: 'count', page: 1,
        points: [{ x: count.current, y: 1 }], ...measureContext };
      const next = { ...plan.current, measures: [...plan.current.measures, mark] };
      void onUseMeasure(plan.current, mark, 1, next).then(ok => { if (ok) plan.current = next; });
    }}>Confirmar DXF na coluna {destinationColumn}</button>;
  },
}));

afterEach(cleanup);
beforeEach(() => localStorage.clear());
const actor = { id: 'u', name: 'Engenheiro', canEdit: true };
function setup(rows: Workspace['entries'][number]['rows']) {
  const initial: Workspace = {
    schema: 1, projectId: 'p', projectName: 'Obra', revision: 0,
    services: [{ id: 's', item: '1.1', description: 'Placas', unit: 'UN', contracted: 100, priceNoBDI: 1, priceWithBDI: 1, bdi: 0,
      importedPrice: true, chapterId: 'c', chapter: 'Prédio', path: 'Prédio', availableFromNumber: 1 }],
    periods: [{ id: 'm', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'draft' }],
    entries: rows.length ? [{ projectId: 'p', measurementId: 'm', serviceId: 's', rows }] : [],
    plans: [{ id: 'plan', name: 'Teste.dxf', floor: 'Térreo', chapterId: 'c', kind: 'dxf', file: new Blob(), scales: { 1: 1 }, measures: [] }],
    audit: [], importedKeys: [], backupId: 'b',
  };
  let confirmed = initial;
  const repository: MeasurementRepository = {
    savedLabel: 'Salvo na nuvem',
    load: vi.fn(async () => confirmed), initialize: vi.fn(async () => confirmed),
    commit: vi.fn(async next => { confirmed = next; return next; }),
    pending: vi.fn(async () => null), pendingSaves: vi.fn(async () => []), archivePending: vi.fn(async () => undefined),
    drafts: vi.fn(async () => []), writeDraft: vi.fn(async () => undefined), clearDraft: vi.fn(async () => undefined),
    backup: vi.fn(async () => null),
  };
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  const open = async () => {
    fireEvent.click(await screen.findByLabelText('Quantidade de Placas'));
    fireEvent.focus(screen.getByLabelText('Medida da linha 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Planta DXF' }));
    await screen.findByRole('button', { name: 'Confirmar DXF na coluna B' });
  };
  return { repository, open, confirmed: () => confirmed, replaceConfirmed: (next: Workspace) => { confirmed = next; } };
}

describe('destino da captura DXF na Medição', () => {
  it('usa a célula escolhida e a linha imediatamente abaixo sem sobrescrever outra linha', async () => {
    const { open, confirmed } = setup([newMeasuredRow('first'), newMeasuredRow('next'), { ...newMeasuredRow('occupied'), measuredQuantity: 9 }]);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar DXF na coluna B' }));
    await screen.findByText(/Linha 2, coluna B/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar DXF na coluna B' }));
    await screen.findByText(/Linha 3, coluna B/);
    await waitFor(() => expect(confirmed().plans[0].measures).toHaveLength(2));
    const rows = confirmed().entries[0].rows;
    expect(rows.map(row => row.id)).toEqual(['first', 'next', expect.any(String), 'occupied']);
    expect(rows.map(row => row.measuredQuantity)).toEqual([1, 1, 0, 9]);
    expect(rows[0].source?.measureId).toBe('mark-1');
    expect(rows[1].source?.measureId).toBe('mark-2');
  });

  it('recupera a primeira marca após falha da nuvem antes de captar na linha seguinte', async () => {
    const { open, repository, confirmed } = setup([newMeasuredRow('first')]);
    vi.mocked(repository.commit).mockRejectedValueOnce(new Error('Sem internet'));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar DXF na coluna B' }));
    await screen.findByText('Reenviar 1.1');
    expect(screen.getByText(/Linha 2, coluna B/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar DXF na coluna B' }));
    await waitFor(() => expect(confirmed().plans[0].measures).toHaveLength(2));
    expect(confirmed().entries[0].rows.slice(0, 2).map(row => row.measuredQuantity)).toEqual([1, 1]);
    expect(screen.queryByText('Célula de destino não encontrada.')).not.toBeInTheDocument();
    expect(screen.queryByText('Reenviar 1.1')).not.toBeInTheDocument();
  });

  it('reconstitui a linha aberta na planta se sua criação falha antes da primeira captura', async () => {
    const { open, repository, confirmed } = setup([]);
    vi.mocked(repository.commit).mockRejectedValueOnce(new Error('Sem internet'));
    await open();
    await screen.findByText('Reenviar 1.1');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar DXF na coluna B' }));
    await waitFor(() => expect(confirmed().plans[0].measures).toHaveLength(1));
    expect(confirmed().entries[0].rows[0].measuredQuantity).toBe(1);
    expect(screen.queryByText('Célula de destino não encontrada.')).not.toBeInTheDocument();
  });

  it('rebaseia capturas pendentes sem apagar uma marca confirmada por outra sessão', async () => {
    const { open, repository, confirmed, replaceConfirmed } = setup([
      newMeasuredRow('first'), newMeasuredRow('next'), newMeasuredRow('remote'),
    ]);
    await open();
    const base = confirmed();
    const otherMark: TakeoffMeasure = { id: 'remote-mark', name: 'Outra sessão', kind: 'count', page: 1,
      points: [{ x: 10, y: 1 }, { x: 20, y: 1 }], projectId: 'p', measurementId: 'm', serviceId: 's' };
    replaceConfirmed(captureMeasurement(base, actor,
      { measurementId: 'm', serviceId: 's', rowId: 'remote', field: 'measuredQuantity' },
      { ...base.plans[0], measures: [otherMark] }, otherMark));
    vi.mocked(repository.commit).mockRejectedValueOnce(new Error('Conflito: outra sessão alterou a medição'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar DXF na coluna B' }));
    await screen.findByText('Reenviar 1.1');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar DXF na coluna B' }));
    await waitFor(() => expect(confirmed().plans[0].measures).toHaveLength(3));
    expect(confirmed().plans[0].measures.map(mark => mark.id)).toEqual(['remote-mark', 'mark-1', 'mark-2']);
    expect(confirmed().entries[0].rows.map(row => row.measuredQuantity)).toEqual([1, 1, 0, 2]);
    expect(confirmed().entries[0].rows.at(-1)?.source?.measureId).toBe('remote-mark');
  });

  it('não substitui a mesma célula quando outra sessão já confirmou uma marca nela', async () => {
    const { open, repository, confirmed, replaceConfirmed } = setup([newMeasuredRow('first')]);
    await open();
    const base = confirmed();
    const otherMark: TakeoffMeasure = { id: 'remote-mark', name: 'Outra sessão', kind: 'count', page: 1,
      points: [{ x: 10, y: 1 }, { x: 20, y: 1 }], projectId: 'p', measurementId: 'm', serviceId: 's' };
    replaceConfirmed(captureMeasurement(base, actor,
      { measurementId: 'm', serviceId: 's', rowId: 'first', field: 'measuredQuantity' },
      { ...base.plans[0], measures: [otherMark] }, otherMark));
    vi.mocked(repository.commit).mockRejectedValueOnce(new Error('Conflito: outra sessão alterou a medição'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar DXF na coluna B' }));
    await screen.findByText('Reenviar 1.1');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar DXF na coluna B' }));
    await waitFor(() => expect(screen.getAllByText(/A célula escolhida mudou em outro computador/).length).toBeGreaterThan(0));
    expect(confirmed().plans[0].measures.map(mark => mark.id)).toEqual(['remote-mark']);
    expect(confirmed().entries[0].rows[0].measuredQuantity).toBe(2);
    expect(confirmed().entries[0].rows[0].source?.measureId).toBe('remote-mark');
  });
});
