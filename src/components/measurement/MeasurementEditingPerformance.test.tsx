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
  const repository: MeasurementRepository = { load: vi.fn(async () => w), initialize: vi.fn(async () => w), commit: vi.fn(async candidate => { w = candidate; return candidate; }), pending: vi.fn(async () => null), pendingSaves: vi.fn(async () => []), archivePending: vi.fn(async () => undefined), backup: vi.fn(async () => null), drafts: vi.fn(async () => drafts), writeDraft: vi.fn(async d => { const same = (x: WorkspaceDraft) => x.measurementId === d.measurementId && x.serviceId === d.serviceId && x.rowId === d.rowId; const old = drafts.find(same); drafts = [...drafts.filter(x => !same(x)), { ...d, changes: { ...old?.changes, ...d.changes } }]; }), clearDraft: vi.fn(async (mid, sid, rid) => { drafts = drafts.filter(d => d.measurementId !== mid || d.serviceId !== sid || d.rowId !== rid); }) };
  return { repository, saved: () => w, drafts: () => drafts };
}

it('permite a tarefa seguinte enquanto a primeira salva e inicia o boletim recolhido após recarga', async () => {
  const { repository } = setup(2);
  let confirm!: (candidate: Workspace) => void;
  vi.mocked(repository.commit).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  const mounted = render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  const current = await screen.findByLabelText('Quantidade de Serviço 0');
  expect(screen.getByRole('button', { name: /Boletim de Medição para Pagamento/ })).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(current);
  const a = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(a, { target: { value: '2' } }); fireEvent.blur(a);
  const next = screen.getByLabelText('Quantidade de Serviço 1');
  expect(next).toBeEnabled();
  fireEvent.click(next);
  expect(screen.getByLabelText('Unidades da linha 1')).toHaveValue(0);
  expect(screen.getByLabelText('Quantidade de Serviço 1')).toHaveAttribute('aria-expanded', 'true');
  await act(async () => confirm(vi.mocked(repository.commit).mock.calls[0][0]));
  await waitFor(() => expect(screen.getByLabelText('Quantidade de Serviço 1')).toBeEnabled());
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 1'));
  expect(screen.getByLabelText('Unidades da linha 1')).toHaveValue(0);
  mounted.unmount(); render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  expect(screen.getByRole('button', { name: /Boletim de Medição para Pagamento/ })).toHaveAttribute('aria-expanded', 'false');
});

it('mede edição com a base completa de 402 serviços e confirmação atrasada', async () => {
  const { repository } = setup();
  let renders = 0;
  let reactRenderMs = 0;
  render(<Profiler id="measurement" onRender={(_id, _phase, actualDuration) => { renders++; reactRenderMs += actualDuration; }}><MeasurementWorkspace repository={repository} actor={actor}/></Profiler>);
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
  reactRenderMs = 0;
  const started = performance.now();
  fireEvent.blur(input);
  const elapsed = performance.now() - started;
  const immediatelyUpdated = screen.getByLabelText('Quantidade de Serviço 0').getAttribute('value') === '12345';
  console.info(JSON.stringify({ services: 402, typingRenders, immediatelyUpdated, blurRenderMs: Math.round(elapsed), reactRenderMs: Math.round(reactRenderMs) }));
  expect(typingRenders).toBe(0);
  expect(immediatelyUpdated).toBe(true);
  const next = screen.getByLabelText('Quantidade de Serviço 1');
  act(() => next.focus()); fireEvent.change(next, { target: { value: '2' } });
  await act(async () => confirm(vi.mocked(repository.commit).mock.calls[0][0]));
  await waitFor(() => expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(12345));
  // The first RPC may finish while the operator is typing into another task.
  expect(screen.getByLabelText('Quantidade de Serviço 1')).toBe(next);
  expect(next).toHaveFocus(); expect(next).toHaveValue(2);
  fireEvent.blur(next);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2));
  const third = screen.getByLabelText('Quantidade de Serviço 2');
  act(() => third.focus()); fireEvent.change(third, { target: { value: '3' } }); fireEvent.blur(third);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(3));
  expect((await repository.load())?.entries.map(entry => [entry.serviceId, entry.rows[0].multiplier])).toEqual([['s0', 12345], ['s1', 2], ['s2', 3]]);
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

it('fila A→B→C: timeout na primeira tarefa, continua editando e confirma cada tarefa uma vez após retry', async () => {
  const { repository, drafts } = setup(3);
  let confirmed = (await repository.load())!;
  let failFirst!: (cause: Error) => void;
  vi.mocked(repository.load).mockImplementation(async () => confirmed);
  vi.mocked(repository.commit).mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
    .mockImplementation(async candidate => { confirmed = candidate; return candidate; });
  const mounted = render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  for (const [index, value] of [[0, '1'], [1, '2'], [2, '3']] as const) {
    fireEvent.click(screen.getByLabelText(`Quantidade de Serviço ${index}`));
    const cell = screen.getByLabelText('Unidades da linha 1');
    fireEvent.focus(cell); fireEvent.change(cell, { target: { value } }); fireEvent.blur(cell);
    expect(screen.getByLabelText(`Quantidade de Serviço ${index}`)).toHaveValue(Number(value));
  }
  expect(repository.commit).toHaveBeenCalledTimes(1);
  await act(async () => failFirst(new Error('canceling statement due to statement timeout')));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Não salvo'));
  expect(drafts().map(d => d.serviceId).sort()).toEqual(['s0', 's1', 's2']);
  expect(screen.getByLabelText('Quantidade de Serviço 2')).toHaveValue(3);
  fireEvent.click(screen.getByRole('button', { name: 'Tentar salvar novamente' }));
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Salvo neste navegador'));
  const calls = vi.mocked(repository.commit).mock.calls;
  expect(calls[0][0].audit.at(-1)?.id).toBe(calls[1][0].audit.at(-1)?.id);
  expect(calls.slice(1).map(([candidate]) => candidate.audit.length)).toEqual([1, 2, 3]);
  expect(confirmed.entries.map(entry => [entry.serviceId, entry.rows[0].multiplier])).toEqual([['s0', 1], ['s1', 2], ['s2', 3]]);
  await waitFor(() => expect(drafts()).toHaveLength(0));
  mounted.unmount(); render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  for (const [index, value] of [[0, 1], [1, 2], [2, 3]] as const) expect(await screen.findByLabelText(`Quantidade de Serviço ${index}`)).toHaveValue(value);
});

it('A→B→C recarregado antes da resposta mantém os três rascunhos recuperáveis', async () => {
  const { repository, drafts, saved } = setup(3);
  let pending: { baseRevision: number; candidate: Workspace } | null = null;
  vi.mocked(repository.pending).mockImplementation(async () => pending);
  vi.mocked(repository.commit).mockImplementationOnce(() => new Promise(() => undefined));
  const first = render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  for (const [index, value] of [[0, '1'], [1, '2'], [2, '3']] as const) {
    const input = screen.getByLabelText(`Quantidade de Serviço ${index}`);
    fireEvent.focus(input); fireEvent.change(input, { target: { value } }); fireEvent.blur(input);
  }
  await waitFor(() => expect(drafts()).toHaveLength(3));
  expect(repository.commit).toHaveBeenCalledTimes(1);
  pending = { baseRevision: 0, candidate: vi.mocked(repository.commit).mock.calls[0][0] };
  const leave = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true);
  first.unmount();
  vi.mocked(repository.commit).mockImplementation(async candidate => {
    const current = saved();
    if (candidate.revision !== current.revision + 1) throw new Error('Revisão duplicada');
    // The in-memory mock models a confirmed cloud write after reopening.
    Object.assign(current, candidate);
    pending = null;
    return candidate;
  });
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  expect(screen.getByText(/Rascunhos desta medição preservados \(3\)/)).toHaveTextContent('Próxima tarefa: 1.1 — Serviço 0');
  fireEvent.click(screen.getByRole('button', { name: 'Tentar salvar novamente' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Salvo neste navegador'));
  for (const remaining of [2, 1, 0]) {
    fireEvent.click(screen.getByRole('button', { name: 'Recuperar rascunho' }));
    await waitFor(() => expect(drafts()).toHaveLength(remaining));
    if (remaining > 0) {
      expect(screen.getByText(new RegExp(`Rascunhos desta medição preservados \\(${remaining}\\)`))).toHaveTextContent(`Próxima tarefa: 1.${4 - remaining} — Serviço ${3 - remaining}`);
    } else {
      expect(screen.queryByText(/Rascunhos desta medição preservados/)).not.toBeInTheDocument();
    }
  }
  expect(saved().entries.map(entry => [entry.serviceId, entry.rows[0].multiplier])).toEqual([['s0', 1], ['s1', 2], ['s2', 3]]);
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
  expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(12);
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
