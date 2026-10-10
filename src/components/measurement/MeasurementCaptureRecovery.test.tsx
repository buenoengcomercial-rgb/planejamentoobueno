import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MeasurementWorkspace from './MeasurementWorkspace';
import type { MeasurementRepository, WorkspaceDraft } from '@/lib/measurementWorkspaceStore';
import { newMeasuredRow, type MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import type { TakeoffDraft } from '@/lib/planTakeoff';

vi.mock('@/components/planTakeoff/PlanTakeoff', () => ({ default: ({ onDraftChange, initialDraft }: { onDraftChange: (draft: TakeoffDraft) => void; initialDraft?: TakeoffDraft }) => <div>
  <span>Recuperados: {initialDraft?.points.length ?? 0}</span>
  <button onClick={() => onDraftChange({ planId: 'plan', page: 1, kind: 'count', name: 'Teste', heightMeters: '3', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })}>Traçar dois pontos</button>
</div> }));
afterEach(cleanup);
beforeEach(() => localStorage.clear());
const actor = { id: 'actor', name: 'Engenheiro', canEdit: true };
function setup(empty = false) {
  let w: Workspace = { schema: 1, projectId: 'p', projectName: 'Teste', revision: 0, services: [{ id: 's', item: '1.1', description: 'Placas', unit: 'UN', contracted: 100, priceNoBDI: 1, priceWithBDI: 1, bdi: 0, importedPrice: true, chapterId: 'c', chapter: 'Prédio', path: 'Prédio', availableFromNumber: 1 }], periods: [{ id: 'm', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'draft' }], entries: empty ? [] : [{ projectId: 'p', measurementId: 'm', serviceId: 's', rows: [newMeasuredRow('r')] }], plans: [], audit: [], importedKeys: [], backupId: 'b' };
  let drafts: WorkspaceDraft[] = [];
  const repository: MeasurementRepository = { load: vi.fn(async () => w), initialize: vi.fn(async () => w), commit: vi.fn(async candidate => { w = candidate; return w; }), pending: vi.fn(async () => null), pendingSaves: vi.fn(async () => []), archivePending: vi.fn(async () => undefined), backup: vi.fn(async () => null), drafts: vi.fn(async () => drafts), writeDraft: vi.fn(async d => { drafts = [...drafts.filter(x => x.rowId !== d.rowId), d]; }), clearDraft: vi.fn(async (_m, _s, rid) => { drafts = drafts.filter(d => d.rowId !== rid); }) };
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  const open = async (column = 'A') => { fireEvent.click(await screen.findByLabelText('Quantidade de Placas')); fireEvent.click(screen.getByRole('button', { name: `Levantar coluna ${column} da linha 1 na planta` })); await screen.findByText('Traçar dois pontos'); };
  return { repository, open };
}
describe('saída segura do levantamento na Medição', () => {
  it('fecha com traçado pendente, reabre seus pontos e não os aplica a outra coluna', async () => {
    const { repository, open } = setup(); await open();
    fireEvent.click(screen.getByText('Traçar dois pontos'));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar página' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(repository.commit).not.toHaveBeenCalled();
    await open('B'); expect(screen.getByText('Recuperados: 0')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await open('A'); expect(screen.getByText('Recuperados: 2')).toBeVisible();
  });
  it('aguarda escrita durável e mantém a janela aberta em falha; novo clique pode tentar novamente', async () => {
    const { repository, open } = setup(); await open();
    let fail!: (cause: Error) => void;
    vi.mocked(repository.writeDraft).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; })).mockRejectedValueOnce(new Error('Disco indisponível'));
    fireEvent.click(screen.getByText('Traçar dois pontos'));
    await waitFor(() => expect(repository.writeDraft).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Fechar página' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    await act(async () => fail(new Error('Disco indisponível')));
    await waitFor(() => expect(screen.getAllByRole('alert').some(a => a.textContent?.includes('Disco indisponível'))).toBe(true));
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar página' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('só abre uma nova célula depois da confirmação da linha e não abre se a gravação falhar', async () => {
    const { repository } = setup(true);
    let confirm!: (candidate: Workspace) => void;
    vi.mocked(repository.commit).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    fireEvent.click(await screen.findByLabelText('Quantidade de Placas'));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna A da linha 1 na planta' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => confirm(vi.mocked(repository.commit).mock.calls[0][0]));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Linha 1, coluna A');
  });
  it('falha ao criar a linha mantém rascunho e não abre uma célula inexistente', async () => {
    const { repository } = setup(true); vi.mocked(repository.commit).mockRejectedValue(new Error('Sem conexão'));
    fireEvent.click(await screen.findByLabelText('Quantidade de Placas'));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna A da linha 1 na planta' }));
    await screen.findByText('Sem conexão'); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(repository.clearDraft).not.toHaveBeenCalled();
  });
});
