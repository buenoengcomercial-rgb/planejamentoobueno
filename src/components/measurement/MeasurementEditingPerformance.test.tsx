import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MeasurementWorkspace from './MeasurementWorkspace';
import { newMeasuredRow, type MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import type { MeasurementRepository, WorkspaceDraft } from '@/lib/measurementWorkspaceStore';
vi.mock('@/components/planTakeoff/PlanTakeoff', () => ({ default: () => <div>Visualizador de teste</div> }));

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

it('não cria rascunhos persistentes no modo nuvem e avisa antes de fechar com gravação pendente', async () => {
  const { repository } = setup(3);
  repository.savedLabel = 'Salvo na nuvem';
  repository.stage = undefined;
  repository.drafts = vi.fn(async () => []);
  repository.writeDraft = vi.fn(async () => undefined);
  repository.clearDraft = vi.fn(async () => undefined);
  vi.mocked(repository.commit).mockImplementation(() => new Promise(() => undefined));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  const first = screen.getByLabelText('Quantidade de Serviço 0');
  fireEvent.change(first, { target: { value: '1' } }); fireEvent.blur(first);
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 1'));
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  expect(repository.stage).toBeUndefined();
  expect(await repository.drafts()).toEqual([]);
  const leave = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true);
});

it('retoma após recarga a tarefa em edição antes dos dois segundos de espera', async () => {
  const { repository } = setup(1);
  let confirmed = (await repository.load())!;
  const staged = new Map<string, { baseRevision: number; candidate: Workspace }>();
  vi.mocked(repository.load).mockImplementation(async () => confirmed);
  repository.stage = vi.fn(async (candidate, base) => {
    staged.set(candidate.audit.at(-1)!.id, { baseRevision: base.revision, candidate: structuredClone(candidate) });
  });
  repository.queued = vi.fn(async () => [...staged.values()]);
  vi.mocked(repository.commit).mockImplementation(async candidate => {
    confirmed = candidate; staged.delete(candidate.audit.at(-1)!.id); return candidate;
  });
  const first = render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const a = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(a, { target: { value: '7' } }); fireEvent.blur(a);
  await waitFor(() => expect(staged.size).toBe(1));
  expect(repository.commit).not.toHaveBeenCalled();
  first.unmount();
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  expect(await screen.findByLabelText('Quantidade de Serviço 0')).toHaveValue(7);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  expect(staged.size).toBe(0);
  expect(confirmed.entries[0].rows[0].multiplier).toBe(7);
}, 10000);

it('troca de tarefa após a escrita local sem aguardar a resposta da nuvem', async () => {
  const { repository } = setup(2);
  let releaseLocal!: () => void;
  repository.stage = vi.fn(() => new Promise<void>(resolve => { releaseLocal = resolve; }));
  vi.mocked(repository.commit).mockImplementation(() => new Promise(() => undefined));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  const first = await screen.findByLabelText('Quantidade de Serviço 0');
  fireEvent.change(first, { target: { value: '4' } }); fireEvent.blur(first);
  const second = screen.getByLabelText('Quantidade de Serviço 1');
  fireEvent.click(second);
  await waitFor(() => expect(repository.stage).toHaveBeenCalledTimes(1));
  expect(second).toHaveAttribute('aria-expanded', 'false');
  expect(repository.commit).not.toHaveBeenCalled();
  const started = performance.now();
  await act(async () => releaseLocal());
  await waitFor(() => expect(second).toHaveAttribute('aria-expanded', 'true'));
  console.info(JSON.stringify({ localStageToTaskSwitchMs: Math.round(performance.now() - started) }));
  expect(repository.commit).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(4);
});

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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
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
  expect(typingRenders).toBeLessThanOrEqual(3);
  expect(immediatelyUpdated).toBe(true);
  const next = screen.getByLabelText('Quantidade de Serviço 1');
  act(() => next.focus()); fireEvent.change(next, { target: { value: '2' } });
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  await act(async () => confirm(vi.mocked(repository.commit).mock.calls[0][0]));
  await waitFor(() => expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(12345));
  // The first RPC may finish while the operator is typing into another task.
  expect(screen.getByLabelText('Quantidade de Serviço 1')).toBe(next);
  expect(next).toHaveFocus(); expect(next).toHaveValue(2);
  fireEvent.blur(next);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  const third = screen.getByLabelText('Quantidade de Serviço 2');
  act(() => third.focus()); fireEvent.change(third, { target: { value: '3' } }); fireEvent.blur(third);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(3), { timeout: 3000 });
  expect((await repository.load())?.entries.map(entry => [entry.serviceId, entry.rows[0].multiplier])).toEqual([['s0', 12345], ['s1', 2], ['s2', 3]]);
}, 60000);


it('atualiza A/B imediatamente e envia uma única operação após a pausa sem apagar o rascunho', async () => {
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
  expect(repository.commit).not.toHaveBeenCalled();
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(screen.getByLabelText('Medida da linha 1')).toBe(b);
  const [candidate, base] = vi.mocked(repository.commit).mock.calls[0];
  expect(base).toBe(0); expect(candidate.entries[0].rows[0]).toMatchObject({ multiplier: 1, measuredQuantity: 2 });
  expect(repository.clearDraft).not.toHaveBeenCalled();
  await act(async () => confirmations.shift()!());
  await waitFor(() => expect(repository.clearDraft).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('status')).toHaveTextContent('Salvo neste navegador');
}, 10000);

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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  await act(async () => failFirst(new Error('canceling statement due to statement timeout')));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Precisa resolver conflito'));
  expect(drafts().map(d => d.serviceId).sort()).toEqual(['s0', 's1', 's2']);
  expect(screen.getByLabelText('Quantidade de Serviço 2')).toHaveValue(3);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(4), { timeout: 3500 });
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Salvo neste navegador'));
  const calls = vi.mocked(repository.commit).mock.calls;
  expect(calls[0][0].audit.at(-1)?.id).toBe(calls[1][0].audit.at(-1)?.id);
  expect(calls.slice(1).map(([candidate]) => candidate.audit.length)).toEqual([1, 2, 3]);
  expect(confirmed.entries.map(entry => [entry.serviceId, entry.rows[0].multiplier])).toEqual([['s0', 1], ['s1', 2], ['s2', 3]]);
  await waitFor(() => expect(drafts()).toHaveLength(0));
  mounted.unmount(); render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  for (const [index, value] of [[0, 1], [1, 2], [2, 3]] as const) expect(await screen.findByLabelText(`Quantidade de Serviço ${index}`)).toHaveValue(value);
});

it('no modo nuvem, recarga durante falha exige aviso e reabre só o último valor confirmado', async () => {
  const { repository, saved } = setup(3);
  repository.savedLabel = 'Salvo na nuvem'; repository.stage = undefined;
  repository.drafts = vi.fn(async () => []);
  repository.writeDraft = vi.fn(async () => undefined);
  repository.clearDraft = vi.fn(async () => undefined);
  vi.mocked(repository.commit).mockImplementationOnce(() => new Promise(() => undefined));
  const first = render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  const input = screen.getByLabelText('Quantidade de Serviço 0');
  fireEvent.change(input, { target: { value: '1' } }); fireEvent.blur(input);
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 1'));
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  const leave = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leave); expect(leave.defaultPrevented).toBe(true);
  first.unmount();
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  expect(await screen.findByLabelText('Quantidade de Serviço 0')).toHaveValue(0);
  expect(saved().entries[0].rows[0].multiplier).toBe(0);
  expect(screen.queryByText(/Rascunhos locais/)).not.toBeInTheDocument();
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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  await act(async () => fail(new Error('Sem conexão')));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Precisa resolver conflito'));
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
  expect(repository.commit).not.toHaveBeenCalled();
  fireEvent.blur(b);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(screen.getByLabelText('Medida da linha 1')).toBe(b); expect(b).toHaveValue(2);
  expect(vi.mocked(repository.commit).mock.calls[0][0].entries[0].rows[0]).toMatchObject({ comment: 'Térreo', multiplier: 1, measuredQuantity: 2 });
  await act(async () => confirm(vi.mocked(repository.commit).mock.calls[0][0]));
  expect(repository.commit).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: /Levantar coluna/ })).not.toBeInTheDocument();
});

it('aceita a revisão materializada mais recente após recibo e continua salvando sobre ela', async () => {
  const { repository } = setup(1);
  repository.confirmedOperation = vi.fn(async () => true);
  vi.mocked(repository.commit).mockImplementationOnce(async candidate => ({ ...candidate, revision: candidate.revision + 1, audit: [] }));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const a = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(a, { target: { value: '2' } }); fireEvent.blur(a);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Salvo neste navegador'), { timeout: 3000 });
  expect(repository.confirmedOperation).toHaveBeenCalledWith(vi.mocked(repository.commit).mock.calls[0][0].audit.at(-1)?.id, 1);
  fireEvent.change(a, { target: { value: '3' } }); fireEvent.blur(a);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(vi.mocked(repository.commit).mock.calls[1][1]).toBe(2);
  await waitFor(() => expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(3));
});

it('confirma criação de medição com resposta perdida e rebate a célula seguinte na versão salva', async () => {
  const { repository } = setup(1);
  let remote = (await repository.load())!;
  let loseResponse!: (cause: Error) => void;
  repository.confirmedOperation = vi.fn(async (operationId, revision) => remote.audit.some(event => event.id === operationId && remote.revision >= revision));
  vi.mocked(repository.load).mockImplementation(async () => remote);
  vi.mocked(repository.commit).mockImplementationOnce(candidate => new Promise((_resolve, reject) => {
    remote = candidate; loseResponse = reject;
  })).mockImplementation(async candidate => { remote = candidate; return candidate; });
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  fireEvent.click(screen.getByRole('button', { name: 'Nova medição' }));
  fireEvent.click(screen.getByRole('button', { name: 'Criar medição' }));
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 0'));
  const cell = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(cell, { target: { value: '2' } }); fireEvent.blur(cell);
  await act(async () => loseResponse(new Error('Resposta perdida após confirmar na nuvem')));
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2), { timeout: 3500 });
  const [rebased, baseRevision] = vi.mocked(repository.commit).mock.calls[1];
  expect(baseRevision).toBe(1);
  expect(rebased.periods).toHaveLength(2);
  expect(rebased.entries[0].rows[0].multiplier).toBe(2);
  await waitFor(() => expect(document.querySelector('main [role="status"]')).toHaveTextContent('Salvo neste navegador'));
  expect(remote.entries[0].rows[0].multiplier).toBe(2);
});

it('não rebate célula sobre alteração concorrente da mesma entrada após resposta perdida', async () => {
  const { repository, drafts } = setup(1);
  let remote = (await repository.load())!;
  let loseResponse!: (cause: Error) => void;
  repository.confirmedOperation = vi.fn(async () => true);
  vi.mocked(repository.load).mockImplementation(async () => remote);
  vi.mocked(repository.commit).mockImplementationOnce(candidate => new Promise((_resolve, reject) => {
    remote = candidate; loseResponse = reject;
  })).mockImplementation(async candidate => { remote = candidate; return candidate; });
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  fireEvent.click(screen.getByRole('button', { name: 'Nova medição' }));
  fireEvent.click(screen.getByRole('button', { name: 'Criar medição' }));
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 0'));
  const cell = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(cell, { target: { value: '2' } }); fireEvent.blur(cell);
  remote = { ...remote, revision: remote.revision + 1, entries: [{ ...remote.entries[0], rows: [{ ...remote.entries[0].rows[0], multiplier: 7 }] }] };
  await act(async () => loseResponse(new Error('Resposta perdida após confirmar na nuvem')));
  // Wait for recovery to inspect the newer cloud state, rather than merely
  // accepting the initial lost-response warning before the automatic retry.
  await screen.findAllByText('A medição mudou em outro computador. Os lançamentos locais permanecem preservados para conferência.');
  expect(document.querySelector('main [role="status"]')).toHaveTextContent('Precisa resolver conflito');
  expect(repository.commit).toHaveBeenCalledTimes(1);
  expect(remote.entries[0].rows[0].multiplier).toBe(7);
  expect(drafts()).toHaveLength(1);
});

it('não declara salvo um período quando a resposta falha sem operação confirmada', async () => {
  const { repository } = setup(1);
  repository.confirmedOperation = vi.fn(async () => false);
  vi.mocked(repository.commit).mockRejectedValueOnce(new Error('Sem conexão'));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  fireEvent.click(screen.getByRole('button', { name: 'Nova medição' }));
  fireEvent.click(screen.getByRole('button', { name: 'Criar medição' }));
  await waitFor(() => expect(repository.load).toHaveBeenCalledTimes(2));
  expect(document.querySelector('main [role="status"]')).toHaveTextContent('Precisa resolver conflito');
  expect(repository.commit).toHaveBeenCalledTimes(1);
});

it('abre o levantamento depois de recuperar uma falha anterior sem bloquear pelo resultado antigo', async () => {
  const { repository } = setup(1);
  vi.mocked(repository.commit).mockRejectedValueOnce(new Error('Falha temporária'));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const a = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(a, { target: { value: '2' } }); fireEvent.blur(a);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2), { timeout: 4000 });
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Salvo neste navegador'));
  fireEvent.focus(screen.getByLabelText('Unidades da linha 1'));
  fireEvent.click(screen.getByRole('button', { name: 'Planta DXF' }));
  expect(await screen.findByText('Visualizador de teste')).toBeVisible();
});

it('aceita quantidade acima do contrato e sinaliza somente a linha excedida', async () => {
  const { repository } = setup(1);
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const a = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(a, { target: { value: '100001' } }); fireEvent.blur(a);
  expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(100001);
  expect(screen.getByTestId('service-s0')).toHaveAttribute('data-over-limit', 'true');
  expect(screen.getByTestId('service-s0')).toHaveTextContent('Ultrapassou o limite contratado');
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 0'));
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1), { timeout: 3000 });
});

it('falha de uma tarefa não bloqueia outra, e a repetição conserva os dois lançamentos', async () => {
  const { repository, saved } = setup(2);
  repository.savedLabel = 'Salvo na nuvem'; repository.stage = undefined;
  repository.drafts = vi.fn(async () => []);
  repository.writeDraft = vi.fn(async () => undefined);
  repository.clearDraft = vi.fn(async () => undefined);
  vi.mocked(repository.commit).mockRejectedValueOnce(new Error('Falha de rede'));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  const first = await screen.findByLabelText('Quantidade de Serviço 0');
  fireEvent.change(first, { target: { value: '3' } }); fireEvent.blur(first);
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 1'));
  expect(await screen.findByRole('button', { name: 'Reenviar 1.1' })).toBeVisible();
  const second = screen.getByLabelText('Quantidade de Serviço 1');
  fireEvent.change(second, { target: { value: '5' } }); fireEvent.blur(second);
  expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(3);
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 0'));
  await waitFor(() => expect(saved().entries.find(entry => entry.serviceId === 's1')?.rows[0].multiplier).toBe(5));
  expect(saved().entries.find(entry => entry.serviceId === 's0')?.rows[0].multiplier).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar 1.1' }));
  await waitFor(() => expect(saved().entries.find(entry => entry.serviceId === 's0')?.rows[0].multiplier).toBe(3));
  expect(screen.queryByRole('button', { name: 'Reenviar 1.1' })).not.toBeInTheDocument();
  expect(repository.commit).toHaveBeenCalledTimes(3);
});

it('permite corrigir a própria tarefa após falha, sem painel bloqueante', async () => {
  const { repository, saved } = setup(2);
  repository.savedLabel = 'Salvo na nuvem'; repository.stage = undefined;
  repository.drafts = vi.fn(async () => []);
  repository.writeDraft = vi.fn(async () => undefined);
  repository.clearDraft = vi.fn(async () => undefined);
  vi.mocked(repository.commit).mockRejectedValueOnce(new Error('Falha de rede'));
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  fireEvent.click(await screen.findByLabelText('Quantidade de Serviço 0'));
  const a = screen.getByLabelText('Unidades da linha 1');
  fireEvent.change(a, { target: { value: '3' } }); fireEvent.blur(a);
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 1'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reenviar 1.1' })).toBeVisible(), { timeout: 3500 });
  expect(screen.queryByText(/Confira ou tente salvar esta tarefa/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 0'));
  const retryInput = screen.getByLabelText('Unidades da linha 1');
  expect(retryInput).toBeEnabled();
  fireEvent.change(retryInput, { target: { value: '4' } }); fireEvent.blur(retryInput);
  fireEvent.click(screen.getByLabelText('Quantidade de Serviço 1'));
  await waitFor(() => expect(saved().entries[0].rows[0].multiplier).toBe(4), { timeout: 4000 });
  expect(screen.getByLabelText('Quantidade de Serviço 0')).toHaveValue(4);
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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1), { timeout: 3000 });
  const originalId = vi.mocked(repository.commit).mock.calls[0][0].entries[0].rows[0].id;
  await act(async () => fail(new Error('Sem conexão')));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Salvo neste navegador'));
  await waitFor(() => expect(repository.clearDraft).toHaveBeenCalledTimes(2));
  expect(saved().entries[0].rows).toHaveLength(1);
  expect(saved().entries[0].rows[0]).toMatchObject({ id: originalId, comment: 'Térreo', multiplier: 3 });
});
