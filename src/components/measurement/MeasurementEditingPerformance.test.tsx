import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MeasurementWorkspace from './MeasurementWorkspace';
import { newMeasuredRow, type MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import type { MeasurementRepository, WorkspaceDraft } from '@/lib/measurementWorkspaceStore';

afterEach(cleanup);
beforeEach(() => localStorage.clear());
const actor = { id: 'editor', name: 'Editor', canEdit: true };
function setup(size = 402) {
  let w: Workspace = { schema: 1, projectId: 'performance', projectName: 'Isolada', revision: 0,
    services: Array.from({ length: size }, (_, i) => ({ id: `s${i}`, item: `1.${i + 1}`, description: `Serviço ${i}`, unit: 'UN', contracted: 100000, priceNoBDI: 1, priceWithBDI: 1, bdi: 0, importedPrice: true, chapterId: 'c', chapter: 'Prédio', path: 'Prédio', availableFromNumber: 1 })),
    periods: [{ id: 'm', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'draft' }],
    entries: [{ projectId: 'performance', measurementId: 'm', serviceId: 's0', rows: [newMeasuredRow('r')] }], plans: [], audit: [], importedKeys: [], backupId: 'b' };
  let drafts: WorkspaceDraft[] = [];
  const repository: MeasurementRepository = { load: vi.fn(async () => w), initialize: vi.fn(async () => w), commit: vi.fn(async candidate => { w = candidate; return candidate; }), pending: vi.fn(async () => null), pendingSaves: vi.fn(async () => []), archivePending: vi.fn(async () => undefined), backup: vi.fn(async () => null), drafts: vi.fn(async () => drafts), writeDraft: vi.fn(async d => { const old = drafts.find(x => x.rowId === d.rowId); drafts = [...drafts.filter(x => x.rowId !== d.rowId), { ...d, changes: { ...old?.changes, ...d.changes } }]; }), clearDraft: vi.fn(async (_m, _s, rid) => { drafts = drafts.filter(d => d.rowId !== rid); }) };
  return { repository, saved: () => w, drafts: () => drafts };
}

it('mede edição com a base completa de 402 serviços e confirmação atrasada', async () => {
  const { repository } = setup();
  let renders = 0;
  render(<Profiler id="measurement" onRender={() => renders++}><MeasurementWorkspace repository={repository} actor={actor}/></Profiler>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const input = screen.getByLabelText('Unidades da linha 1');
  fireEvent.focus(input);
  const before = renders;
  for (const value of ['1', '12', '123', '1234', '12345']) {
    fireEvent.change(input, { target: { value } });
    await act(async () => { await Promise.resolve(); });
  }
  const typingRenders = renders - before;
  let confirm!: (candidate: Workspace) => void;
  vi.mocked(repository.commit).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  const started = performance.now();
  fireEvent.blur(input);
  const immediatelyUpdated = screen.getByLabelText('Quantidade de Serviço 0').getAttribute('value') === '12345';
  const elapsed = performance.now() - started;
  console.info(JSON.stringify({ services: 402, typingRenders, immediatelyUpdated, blurRenderMs: Math.round(elapsed) }));
  expect(typingRenders).toBe(0);
  expect(immediatelyUpdated).toBe(true);
  await act(async () => confirm(vi.mocked(repository.commit).mock.calls[0][0]));
  await waitFor(() => expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(12345));
}, 30000);


it('atualiza imediatamente e salva A/B em sequência sem bloquear foco ou apagar o rascunho mais novo', async () => {
  const { repository } = setup(1);
  const confirmations: Array<() => void> = [];
  vi.mocked(repository.commit).mockImplementation(candidate => new Promise(resolve => confirmations.push(() => resolve(candidate))));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const a = screen.getByLabelText('Unidades da linha 1'), b = screen.getByLabelText('Medida da linha 1');
  fireEvent.focus(a); expect(a).toHaveValue(null);
  fireEvent.change(a, { target: { value: '1' } }); fireEvent.blur(a);
  expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(1);
  act(() => b.focus()); fireEvent.change(b, { target: { value: '2' } }); fireEvent.blur(b);
  expect(b).toBeEnabled(); expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(2);
  expect(repository.commit).toHaveBeenCalledTimes(1);
  await act(async () => confirmations.shift()!());
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Medida da linha 1')).toBe(b);
  const [candidate, base] = vi.mocked(repository.commit).mock.calls[1];
  expect(base).toBe(1); expect(candidate.entries[0].rows[0]).toMatchObject({ multiplier: 1, measuredQuantity: 2 });
  expect(repository.clearDraft).not.toHaveBeenCalled();
  await act(async () => confirmations.shift()!());
  await waitFor(() => expect(repository.clearDraft).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('status')).toHaveTextContent('Salvo neste navegador');
});

it('mantém todos os campos em rascunho se a primeira confirmação falhar e não envia os seguintes', async () => {
  const { repository, drafts } = setup(1);
  let fail!: (error: Error) => void;
  vi.mocked(repository.commit).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  for (const [label, value] of [['Unidades', '3'], ['Medida', '4']]) {
    const input = screen.getByLabelText(`${label} da linha 1`);
    fireEvent.focus(input); fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
  }
  expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(12);
  await act(async () => fail(new Error('Sem conexão')));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Não salvo'));
  expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(0);
  expect(drafts()[0].changes).toMatchObject({ multiplier: '3', measuredQuantity: '4' });
  expect(repository.commit).toHaveBeenCalledTimes(1); expect(repository.clearDraft).not.toHaveBeenCalled();
});

it('preserva os mesmos inputs ao confirmar comentário de uma nova linha e seguir por A–D', async () => {
  const { repository } = setup(1);
  const w = await repository.load(); w!.entries = [];
  let confirm!: (candidate: Workspace) => void;
  vi.mocked(repository.commit).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const comment = screen.getByLabelText('Comentário da linha 1'), a = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(comment, { target: { value: 'Térreo' } }); fireEvent.blur(comment);
  expect(screen.getByLabelText('Comentário da linha 1')).toBe(comment);
  expect(screen.getByLabelText('Unidades da linha 1')).toBe(a); expect(a).toBeEnabled();
  fireEvent.focus(a); fireEvent.change(a, { target: { value: '1' } }); fireEvent.blur(a);
  const b = screen.getByLabelText('Medida da linha 1'); act(() => b.focus()); fireEvent.change(b, { target: { value: '2' } });
  await act(async () => confirm(vi.mocked(repository.commit).mock.calls[0][0]));
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2));
  expect(b).toHaveFocus(); expect(b).toHaveValue(2);
  fireEvent.blur(b);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(3));
  expect(vi.mocked(repository.commit).mock.calls[2][0].entries[0].rows[0]).toMatchObject({ comment: 'Térreo', multiplier: 1, measuredQuantity: 2 });
  expect(screen.queryByRole('button', { name: /Levantar coluna/ })).not.toBeInTheDocument();
});

it('rejeita quantidade acima do contrato antes de alterar a planilha', async () => {
  const { repository } = setup(1);
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const a = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(a, { target: { value: '100001' } }); fireEvent.blur(a);
  expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(0);
  expect(repository.commit).not.toHaveBeenCalled(); expect(a).toHaveValue(0);
});

it('recupera comentário e quantidade da mesma nova linha após falha, sem duplicar o registro', async () => {
  const { repository, saved } = setup(1);
  (await repository.load())!.entries = [];
  let fail!: (error: Error) => void;
  vi.mocked(repository.commit).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const comment = screen.getByLabelText('Comentário da linha 1');
  fireEvent.change(comment, { target: { value: 'Térreo' } }); fireEvent.blur(comment);
  const a = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(a, { target: { value: '3' } }); fireEvent.blur(a);
  const originalId = vi.mocked(repository.commit).mock.calls[0][0].entries[0].rows[0].id;
  await act(async () => fail(new Error('Sem conexão')));
  fireEvent.click(await screen.findByText('Arquivar rascunho e usar versão salva'));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Versão salva carregada'));
  fireEvent.click(screen.getByText('Recuperar rascunho'));
  await waitFor(() => expect(repository.clearDraft).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('Recuperar rascunho'));
  await waitFor(() => expect(repository.clearDraft).toHaveBeenCalledTimes(2));
  expect(saved().entries[0].rows).toHaveLength(1);
  expect(saved().entries[0].rows[0]).toMatchObject({ id: originalId, comment: 'Térreo', multiplier: 3 });
});
