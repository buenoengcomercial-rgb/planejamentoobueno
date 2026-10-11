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

it('retoma três tarefas guardadas localmente sem esperar a primeira resposta cloud', async () => {
  const { repository } = setup(3);
  let cloud = (await repository.load())!;
  vi.mocked(repository.load).mockImplementation(async () => cloud);
  const staged: Array<{ baseRevision: number; candidate: Workspace }> = [];
  repository.stage = vi.fn(async (candidate, base) => {
    staged.push({ baseRevision: base.revision, candidate });
  });
  repository.queued = vi.fn(async () => staged.slice());
  vi.mocked(repository.commit).mockImplementationOnce(() => new Promise(() => undefined))
    .mockImplementation(async candidate => {
      cloud = candidate;
      staged.splice(staged.findIndex(row => row.candidate.audit.at(-1)?.id === candidate.audit.at(-1)?.id), 1);
      return candidate;
    });
  const first = render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  await screen.findByLabelText('Quantidade de Serviço 0');
  for (const [index, value] of [[0, '1'], [1, '2'], [2, '3']] as const) {
    const cell = screen.getByLabelText(`Quantidade de Serviço ${index}`);
    fireEvent.change(cell, { target: { value } }); fireEvent.blur(cell);
  }
  await waitFor(() => expect(staged).toHaveLength(3));
  expect(screen.getByRole('button', { name: /Enviar para fiscalização/ })).toBeDisabled();
  await waitFor(() => {
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });
  first.unmount();
  render(<MeasurementWorkspace repository={repository} actor={actor}/>);
  for (const [index, value] of [[0, 1], [1, 2], [2, 3]] as const)
    expect(await screen.findByLabelText(`Quantidade de Serviço ${index}`)).toHaveValue(value);
  await waitFor(() => expect(staged).toHaveLength(0));
  expect(screen.getByRole('status')).toHaveTextContent('Confirmado');
});

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
  expect(typingRenders).toBe(0);
  expect(immediatelyUpdated).toBe(true);
  const next = screen.getByLabelText('Quantidade de Serviço 1');
  act(() => next.focus()); fireEvent.change(next, { target: { value: '2' } });
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  await act(async () => confirmations.shift()!());
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Medida da linha 1')).toBe(b);
  const [candidate, base] = vi.mocked(repository.commit).mock.calls[1];
  expect(base).toBe(1); expect(candidate.entries[0].rows[0]).toMatchObject({ multiplier: 1, measuredQuantity: 2 });
  expect(repository.clearDraft).not.toHaveBeenCalled();
  await act(async () => confirmations.shift()!());
  await waitFor(() => expect(repository.clearDraft).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('status')).toHaveTextContent('Confirmado');
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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  await act(async () => failFirst(new Error('canceling statement due to statement timeout')));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Precisa resolver conflito'));
  expect(drafts().map(d => d.serviceId).sort()).toEqual(['s0', 's1', 's2']);
  expect(screen.getByLabelText('Quantidade de Serviço 2')).toHaveValue(3);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Confirmado'));
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
  // A durable local queue permits closing while the cloud is still pending.
  await waitFor(() => {
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
  });
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
  fireEvent.click(screen.getByText('Rascunhos locais (3)'));
  expect(screen.getByText(/Próxima tarefa: 1.1 — Serviço 0/)).toBeVisible();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Confirmado'));
  for (const remaining of [2, 1, 0]) {
    fireEvent.click(screen.getByRole('button', { name: 'Recuperar rascunho' }));
    await waitFor(() => expect(drafts()).toHaveLength(remaining));
    if (remaining > 0) {
      expect(screen.getByText(`Rascunhos locais (${remaining})`)).toBeVisible();
      expect(screen.getByText(new RegExp(`Próxima tarefa: 1\\.${4 - remaining} — Serviço ${3 - remaining}`))).toBeVisible();
    } else {
      expect(screen.queryByText(/Rascunhos locais/)).not.toBeInTheDocument();
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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  await act(async () => confirm(vi.mocked(repository.commit).mock.calls[0][0]));
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2));
  expect(b).toHaveFocus(); expect(b).toHaveValue(2);
  fireEvent.blur(b);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(3));
  expect(vi.mocked(repository.commit).mock.calls[2][0].entries[0].rows[0]).toMatchObject({ comment: 'Térreo', multiplier: 1, measuredQuantity: 2 });
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
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Confirmado'));
  expect(repository.confirmedOperation).toHaveBeenCalledWith(vi.mocked(repository.commit).mock.calls[0][0].audit.at(-1)?.id, 1);
  fireEvent.change(a, { target: { value: '3' } }); fireEvent.blur(a);
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2));
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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2));
  const [rebased, baseRevision] = vi.mocked(repository.commit).mock.calls[1];
  expect(baseRevision).toBe(1);
  expect(rebased.periods).toHaveLength(2);
  expect(rebased.entries[0].rows[0].multiplier).toBe(2);
  await waitFor(() => expect(document.querySelector('main [role="status"]')).toHaveTextContent('Confirmado'));
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
  await waitFor(() => expect(document.querySelector('main [role="status"]')).toHaveTextContent('Precisa resolver conflito'));
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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Confirmado'));
  fireEvent.focus(screen.getByLabelText('Unidades da linha 1'));
  fireEvent.click(screen.getByRole('button', { name: 'Planta DXF' }));
  expect(await screen.findByText('Visualizador de teste')).toBeVisible();
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
  await waitFor(() => expect(repository.commit).toHaveBeenCalledTimes(1));
  const originalId = vi.mocked(repository.commit).mock.calls[0][0].entries[0].rows[0].id;
  await act(async () => fail(new Error('Sem conexão')));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Confirmado'));
  await waitFor(() => expect(repository.clearDraft).toHaveBeenCalledTimes(2));
  expect(saved().entries[0].rows).toHaveLength(1);
  expect(saved().entries[0].rows[0]).toMatchObject({ id: originalId, comment: 'Térreo', multiplier: 3 });
});
