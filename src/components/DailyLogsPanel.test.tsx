import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import DailyLogsPanel from './DailyLogsPanel';
import type { Task } from '@/types/project';
import { flushPendingEditCommits } from '@/lib/pendingEditCommits';

vi.mock('@/components/planTakeoff/PlanTakeoff', () => ({
  default: ({ onUseMeasure, embedded, linkedMeasureIds, executedMeasureIds }: { linkedMeasureIds: string[]; executedMeasureIds: string[]; onUseMeasure: (plan: object, measure: object, result: number) => boolean; embedded: boolean }) =>
    <div><span data-testid="linked-points">{linkedMeasureIds?.join(",")}</span><span data-testid="executed-points">{executedMeasureIds?.join(",")}</span>{embedded && <span>Visualizador sem tabela de levantamentos</span>}<button onClick={() => onUseMeasure({ id: 'plan-1', name: 'Placas.pdf', chapterId: 'phase-1' }, { id: 'measure-1', name: 'Executadas', kind: 'count', page: 2, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }] }, 3)}>Concluir contagem de teste</button><button onClick={() => onUseMeasure({ id: 'plan-1', name: 'Placas.pdf', chapterId: 'phase-1' }, { id: 'measure-2', name: 'Segundo grupo', kind: 'count', page: 2, points: [{ x: 70, y: 80 }, { x: 90, y: 100 }] }, 2)}>Concluir outra contagem</button><button onClick={() => onUseMeasure({ id: 'plan-1', name: 'Placas.pdf', chapterId: 'phase-1' }, { id: 'measure-length', name: 'Largura executada', kind: 'length', page: 2, points: [{ x: 10, y: 20 }, { x: 40, y: 20 }] }, 3)}>Concluir comprimento de teste</button></div>,
}));

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Instalar hidrante',
    phase: 'phase-1',
    startDate: '2026-09-08',
    duration: 2,
    dependencies: [],
    responsible: '',
    percentComplete: 0,
    materials: [],
    level: 0,
    quantity: 16,
    unit: 'UND',
    ...overrides,
  };
}

describe('DailyLogsPanel', () => {
  it('recupera um rascunho antigo e bloqueia confirmação automática se a origem mudou', () => {
    const saved = buildTask({dailyLogs:[{id:'l',date:'2026-10-01',actualQuantity:4,plannedQuantity:8}]});
    const key = 'obraplanner:production-field-draft:draft-protection:task-1';
    localStorage.setItem(key, JSON.stringify({base:'[]',savedAt:0,drafts:{'log:l:actualQuantity':'5'}}));
    const onChange = vi.fn();
    render(<DailyLogsPanel projectId="draft-protection" task={saved} onChange={onChange} />);
    expect(screen.getByRole('button',{name:'Revisar valores recuperados'})).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toContain('log:l:actualQuantity');
    fireEvent.click(screen.getByRole('button',{name:'Descartar somente rascunho'}));
    expect(localStorage.getItem(key)).toBeNull();
    expect(saved.dailyLogs![0].actualQuantity).toBe(4);
  });
  it('lança três pontos por medição, edita, exclui e recupera após recarga sem inventar uma data', async () => {
    const periods = [{ key: 'draft-1', number: 1, startDate: '2026-09-01', endDate: '2026-09-30' }];
    const legacy = { id: 'old', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 2, notes: 'Preservar' };
    let saved = buildTask({ dailyLogs: [legacy] });
    function Harness() {
      const [task, setTask] = useState(saved);
      return <DailyLogsPanel task={task} measurementPeriods={periods} chapterId="phase-1" takeoffStorageKey="scope" onChange={dailyLogs => { saved = { ...task, dailyLogs }; setTask(saved); }} />;
    }
    const first = render(<Harness />);
    expect(screen.queryByText(/Apontamento Diário — meta/)).not.toBeInTheDocument();
    expect(screen.queryByText('SALDO DIA')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Total da 1ª medição')).toHaveTextContent('2 UND');
    fireEvent.click(screen.getByText('Abrir detalhe de quantitativos'));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna A da linha 1 na planta' }));
    fireEvent.click(await screen.findByText('Concluir contagem de teste'));
    expect(saved.dailyLogs![0]).toEqual(legacy);
    expect(saved.dailyLogs![1]).toMatchObject({ date: '', actualQuantity: 3, quantityDetailsAppliedTotal: 3, measurementPeriod: { number: 1 } });
    expect(saved.dailyLogs![1].quantityDetails![0].multiplierSource?.points).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByLabelText('Total da 1ª medição')).toHaveTextContent('5 UND');
    first.unmount();
    saved = JSON.parse(JSON.stringify(saved));
    render(<Harness />);
    expect(screen.getByLabelText('Total da 1ª medição')).toHaveTextContent('5 UND');
    expect(screen.getByRole('img', { name: 'Origem na planta da linha 1' })).toBeInTheDocument();
    const value = screen.getByRole('spinbutton', { name: 'Unidades da linha 1' });
    fireEvent.change(value, { target: { value: '4' } }); fireEvent.blur(value);
    expect(screen.getByLabelText('Total da 1ª medição')).toHaveTextContent('6 UND');
    fireEvent.click(screen.getByRole('button', { name: 'Excluir linha 1' }));
    expect(saved.dailyLogs![1].actualQuantity).toBe(0);
    expect(saved.dailyLogs![0]).toEqual(legacy);
    expect(screen.getByLabelText('Total da 1ª medição')).toHaveTextContent('2 UND');
  });
  it('não permite novos quantitativos em medição aprovada ou sem período definido', () => {
    const onChange = vi.fn();
    const view = render(<DailyLogsPanel task={buildTask()} onChange={onChange} measurementPeriods={[{ key: 'm1', number: 1, startDate: '2026-09-01', endDate: '2026-09-30', blockedReason: 'Medição aprovada: somente consulta.' }]} />);
    expect(screen.queryByText('Abrir detalhe de quantitativos')).not.toBeInTheDocument();
    expect(screen.getByText(/Medição aprovada/)).toBeInTheDocument();
    view.rerender(<DailyLogsPanel task={buildTask()} onChange={onChange} measurementPeriods={[]} />);
    expect(screen.getByText(/Defina o número e as datas/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('envia ao visualizador somente as referências e execuções do dia aberto', async () => {
    const source = (measureId: string) => ({ planId: 'plan-1', planName: 'Placas.pdf', measureId, measureName: 'Placas', page: 1, kind: 'count' as const, points: [{ x: 1, y: 1 }] });
    const row = (id: string) => ({ id, location: '', comment: '', formula: 'A*B' as const, multiplier: 1, measuredQuantity: 1, source: source(id) });
    const task = buildTask({ dailyLogs: [
      { id: 'ontem', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 1, quantityDetailsAppliedTotal: 1, quantityDetails: [row('ponto-ontem')] },
      { id: 'hoje', date: '2026-09-09', plannedQuantity: 8, actualQuantity: 1, quantityDetailsAppliedTotal: 1, quantityDetails: [row('ponto-hoje')] },
    ] });
    render(<DailyLogsPanel task={task} chapterId="phase-1" takeoffStorageKey="scope" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-09' }));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna B da linha 1 na planta' }));
    expect(await screen.findByTestId('linked-points')).toHaveTextContent(/^ponto-hoje$/);
    expect(screen.getByTestId('executed-points')).toHaveTextContent(/^ponto-hoje$/);
  });

  it('mostra a subtabela A-D com fórmula real, parcial e subtotal acumulado', () => {
    const initial = buildTask({ unit: 'm²', quantity: 100, dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    const detail = screen.getByRole('region', { name: 'Detalhe de quantitativo' });
    expect(screen.queryByRole('button', { name: 'Linha' })).not.toBeInTheDocument();
    expect(detail.querySelector('tbody tr:first-child td:first-child')).toHaveTextContent('');
    expect(detail.querySelectorAll('thead tr')).toHaveLength(2);
    for (const label of ['Loc.', 'Comentário', 'Fórmula', 'A', 'B', 'C', 'D', 'Parcial', 'Subtotal', 'Uds.', 'Compr. (m)', 'Largura (m)', 'Altura (m)']) {
      expect(screen.getByRole('columnheader', { name: label })).toBeInTheDocument();
    }
    expect(detail.querySelector('tbody tr')?.querySelectorAll('td')).toHaveLength(9);
    expect(screen.getByRole('spinbutton', { name: 'Unidades da linha 1' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 1' })).toHaveValue(0);
    expect(detail.querySelectorAll('tbody tr')[0]).toHaveTextContent('0');
    fireEvent.change(screen.getByRole('combobox', { name: 'Fórmula da linha 1' }), { target: { value: 'A*B' } });
    expect(screen.getByRole('columnheader', { name: 'Área (m²)' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Fórmula da linha 1' }), { target: { value: 'A*B*C' } });
    expect(screen.getByRole('columnheader', { name: 'Compr. (m)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Largura (m)' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Largura da linha 1' })).toHaveValue(0);
    const length = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    fireEvent.change(length, { target: { value: '3' } }); fireEvent.blur(length);
    expect(screen.getByRole('spinbutton', { name: 'Unidades da linha 1' })).toHaveValue(1);
    expect(screen.getByRole('spinbutton', { name: 'Largura da linha 1' })).toHaveValue(1);
    expect(screen.getAllByText('1 neutro')).toHaveLength(2);
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(3);
    const width = screen.getByRole('spinbutton', { name: 'Largura da linha 1' });
    fireEvent.change(width, { target: { value: '4' } }); fireEvent.blur(width);
    expect(detail.querySelectorAll('tbody tr')[0]).toHaveTextContent('12');
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(12);
    const nextMeasure = screen.getByRole('spinbutton', { name: 'Medida da linha 2' });
    fireEvent.change(nextMeasure, { target: { value: '2' } }); fireEvent.blur(nextMeasure);
    expect(detail.querySelectorAll('tbody tr')[1]).toHaveTextContent('14');
    expect(detail.querySelector('tfoot')).toHaveTextContent('14 m²');
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(14);
  });
  it('edita C e D, numera a linha preenchida e abre a próxima linha sem botão', () => {
    const initial = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 2, quantityDetails: [
      { id: 'legacy-blank', location: '', comment: '', formula: 'A*B', multiplier: 0, measuredQuantity: 0, dimensionC: 0, dimensionD: 0 },
    ] }] });
    let saved = initial;
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} onChange={dailyLogs => setTask(previous => { saved = { ...previous, dailyLogs }; return saved; })} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    const detail = screen.getByRole('region', { name: 'Detalhe de quantitativo' });
    expect(detail.querySelector('tbody tr:first-child td:first-child')?.textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Linha' })).not.toBeInTheDocument();
    const c = screen.getByRole('spinbutton', { name: 'Largura da linha 1' });
    fireEvent.change(c, { target: { value: '4' } }); fireEvent.blur(c);
    expect(detail.querySelector('tbody tr:first-child td:first-child')).toHaveTextContent('1');
    expect(detail.querySelector('tbody tr:last-child td:first-child')?.textContent).toBe('');
    expect(screen.getByRole('spinbutton', { name: 'Largura da linha 2' })).toHaveValue(0);
    const d = screen.getByRole('spinbutton', { name: 'Altura da linha 1' });
    fireEvent.change(d, { target: { value: '2' } }); fireEvent.blur(d);
    expect(saved.dailyLogs?.[0].quantityDetails?.[0]).toMatchObject({ dimensionC: 4, dimensionD: 2, multiplier: 0, measuredQuantity: 0 });
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(2);
    expect(detail.querySelector('tbody tr:first-child td:nth-child(8)')).toHaveTextContent('0');
    const b = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    fireEvent.change(b, { target: { value: '3' } }); fireEvent.blur(b);
    expect(detail.querySelector('tbody tr:first-child td:nth-child(8)')).toHaveTextContent('3');
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(3);
  });
  it('segue o Standard: B 3,8 e D 2,7 geram parcial, subtotal e realizado 10,26', () => {
    const initial = buildTask({ unit: 'm²', quantity: 100, dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    let saved = initial;
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} onChange={dailyLogs => setTask(previous => { saved = { ...previous, dailyLogs }; return saved; })} />;
    }
    const { container, unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    const detail = screen.getByRole('region', { name: 'Detalhe de quantitativo' });
    expect(screen.getByRole('combobox', { name: 'Fórmula da linha 1' })).toHaveValue('STANDARD');
    expect(screen.getByRole('columnheader', { name: 'Compr. (m)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Altura (m)' })).toBeInTheDocument();
    const b = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    fireEvent.change(b, { target: { value: '3.8' } }); fireEvent.blur(b);
    expect(screen.getByRole('spinbutton', { name: 'Unidades da linha 1' })).toHaveValue(0);
    expect(screen.queryByText('1 neutro')).not.toBeInTheDocument();
    const d = screen.getByRole('spinbutton', { name: 'Altura da linha 1' });
    fireEvent.change(d, { target: { value: '2.7' } }); fireEvent.blur(d);
    expect(detail.querySelector('tbody tr:first-child td:nth-child(8)')).toHaveTextContent('10,26');
    expect(detail).toHaveTextContent('Subtotal: 10,26 m²');
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(10.26);
    expect(saved.dailyLogs?.[0].quantityDetails?.[0]).toMatchObject({ formula: 'STANDARD', multiplier: 0, measuredQuantity: 3.8, dimensionC: 0, dimensionD: 2.7 });
    expect(saved.quantity).toBe(100);
    unmount();
    const reopened = render(<DailyLogsPanel task={saved} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    expect(screen.getByRole('combobox', { name: 'Fórmula da linha 1' })).toHaveValue('STANDARD');
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 1' })).toHaveValue(3.8);
    expect(screen.getByRole('spinbutton', { name: 'Altura da linha 1' })).toHaveValue(2.7);
    expect(reopened.container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(10.26);
  });
  it('bloqueia a dimensão que ultrapassa o contratado e preserva o valor Standard anterior', () => {
    const initial = buildTask({ unit: 'm²', quantity: 4, dailyLogs: [
      { id: 'log-0', date: '2026-09-07', plannedQuantity: 3, actualQuantity: 3 },
      { id: 'log-1', date: '2026-09-08', plannedQuantity: 1, actualQuantity: 0 },
    ] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    const b = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    fireEvent.change(b, { target: { value: '0.8' } }); fireEvent.blur(b);
    const d = screen.getByRole('spinbutton', { name: 'Altura da linha 1' });
    fireEvent.change(d, { target: { value: '2' } }); fireEvent.blur(d);
    expect(screen.getByRole('spinbutton', { name: 'Altura da linha 1' })).toHaveValue(0);
    expect(screen.getByRole('region', { name: 'Detalhe de quantitativo' })).toHaveTextContent('Subtotal: 0,8 m²');
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(0.8);
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-0"]')).toHaveValue(3);
    expect(screen.getByRole('alert')).toHaveTextContent(/contratad|ultrapass/i);
  });
  it('leva comprimento da planta para C e mantém seus pontos no lançamento', async () => {
    window.scrollTo = vi.fn();
    const initial = buildTask({ unit: 'm²', quantity: 100, dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    let saved = initial;
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} chapterId="phase-1" takeoffStorageKey="scope" onChange={dailyLogs => setTask(previous => { saved = { ...previous, dailyLogs }; return saved; })} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Fórmula da linha 1' }), { target: { value: 'A*B*C' } });
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna C da linha 1 na planta' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir comprimento de teste' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('spinbutton', { name: 'Largura da linha 1' })).toHaveValue(3);
    expect(screen.getByRole('img', { name: 'Origem na planta da linha 1' })).toHaveAttribute('title', expect.stringContaining('C: Placas.pdf'));
    expect(screen.getByRole('region', { name: 'Detalhe de quantitativo' })).not.toHaveTextContent('Placas.pdf');
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(3);
    expect(saved.dailyLogs?.[0].quantityDetails?.[0].dimensionCSource?.points).toEqual([{ x: 10, y: 20 }, { x: 40, y: 20 }]);
  });
  it('linha zerada preserva o manual; primeiro valor atualiza o realizado automaticamente', () => {
    const initial = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 2 }] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    expect(screen.getByRole('spinbutton', { name: 'Unidades da linha 1' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 1' })).toHaveValue(0);
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(2);
    const measure = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    fireEvent.change(measure, { target: { value: '7' } });
    fireEvent.blur(measure);
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(7);
    expect(screen.getByRole('spinbutton', { name: 'Unidades da linha 1' })).toHaveValue(0);
    expect(screen.queryByText('1 neutro')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Detalhe de quantitativo' })).toHaveTextContent('Subtotal: 7 UND');
    expect(screen.queryByRole('button', { name: 'Atualizar realizado pelo detalhe' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Detalhe de quantitativo' })).toHaveTextContent('Dia: 7 UND');
  });
  it('vincula pontos da planta ao dia e impede reutilizar a mesma marcação em outra linha', async () => {
    window.scrollTo = vi.fn();
    const initial = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} chapterId="phase-1" takeoffStorageKey="scope" onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna B da linha 1 na planta' }));
    expect(await screen.findByText('Visualizador sem tabela de levantamentos')).toBeInTheDocument();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir contagem de teste' })); });
    expect(screen.getByRole('dialog')).toHaveTextContent('linha 2, coluna B');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('img', { name: 'Origem na planta da linha 1' })).toHaveAttribute('title', expect.stringContaining('B: Placas.pdf'));
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 1' })).toHaveValue(3);
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 2' })).toHaveValue(0);
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna A da linha 2 na planta' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir contagem de teste' })); });
    expect(screen.getByRole('dialog')).toHaveTextContent('já está vinculada a outra célula');
  });
  it('avança pela mesma coluna após cada grupo sem sobrescrever outra linha', async () => {
    window.scrollTo = vi.fn();
    const initial = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} chapterId="phase-1" takeoffStorageKey="scope" onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna B da linha 1 na planta' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir contagem de teste' })); });
    expect(screen.getByRole('dialog')).toHaveTextContent('linha 2, coluna B');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Concluir outra contagem' })); });
    expect(screen.getByRole('dialog')).toHaveTextContent('linha 3, coluna B');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 1' })).toHaveValue(3);
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 2' })).toHaveValue(2);
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 3' })).toHaveValue(0);
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(5);
  });
  it('insere a próxima captura antes de uma linha já preenchida', async () => {
    window.scrollTo = vi.fn();
    const initial = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 1, quantityDetailsAppliedTotal: 1, quantityDetails: [
      { id: 'row-1', location: '', comment: '', multiplier: 0, measuredQuantity: 0 },
      { id: 'row-existing', location: 'Pavimento 2', comment: 'Lançamento anterior', multiplier: 1, measuredQuantity: 1 },
    ] }] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} chapterId="phase-1" takeoffStorageKey="scope" onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna B da linha 1 na planta' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir contagem de teste' })); });
    expect(screen.getByRole('dialog')).toHaveTextContent('linha 2, coluna B');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 2' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 3' })).toHaveValue(1);
    expect(screen.queryByRole('textbox', { name: 'Local da linha 3' })).not.toBeInTheDocument();
    expect(screen.getByTitle('Local registrado anteriormente: Pavimento 2')).toHaveTextContent('3');
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(4);
  });
  it('preenche a coluna A pela planta e atualiza o realizado do dia', async () => {
    window.scrollTo = vi.fn();
    const initial = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} chapterId="phase-1" takeoffStorageKey="scope" onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna A da linha 1 na planta' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir contagem de teste' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('spinbutton', { name: 'Unidades da linha 1' })).toHaveValue(3);
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 1' })).toHaveValue(0);
    expect(screen.getByRole('img', { name: 'Origem na planta da linha 1' })).toHaveAttribute('title', expect.stringContaining('A: Placas.pdf'));
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(3);
  });
  it('aceita medida sem escala na coluna A e permite substituir pelo teclado', async () => {
    window.scrollTo = vi.fn();
    let saved = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    function Harness() {
      const [task, setTask] = useState(saved);
      return <DailyLogsPanel task={task} chapterId="phase-1" takeoffStorageKey="scope" onChange={dailyLogs => setTask(previous => { saved = { ...previous, dailyLogs }; return saved; })} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna A da linha 1 na planta' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir comprimento de teste' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('spinbutton', { name: 'Unidades da linha 1' })).toHaveValue(3);
    expect(screen.getByText('u.d.')).toBeInTheDocument();
    expect(saved.dailyLogs?.[0].quantityDetails?.[0].multiplierSource).toMatchObject({ kind: 'length', resultUnit: 'u.d.' });
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(3);
    const input = screen.getByRole('spinbutton', { name: 'Unidades da linha 1' });
    fireEvent.change(input, { target: { value: '4' } }); fireEvent.blur(input);
    expect(saved.dailyLogs?.[0].quantityDetails?.[0].multiplierSource).toBeUndefined();
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(4);
  });
  it('mantém a contagem de três pontos, subtotal e realizado após remontar o lançamento', async () => {
    window.scrollTo = vi.fn();
    let saved = buildTask({ quantity: 16, dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    function Harness({ initial }: { initial: Task }) {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} chapterId="phase-1" takeoffStorageKey="scope" onChange={dailyLogs => setTask(previous => { saved = { ...previous, dailyLogs }; return saved; })} />;
    }
    const first = render(<Harness initial={saved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna B da linha 1 na planta' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir contagem de teste' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(first.container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(3);
    expect(saved.quantity).toBe(16);
    first.unmount();

    const second = render(<Harness initial={saved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 1' })).toHaveValue(3);
    expect(screen.getByRole('region', { name: 'Detalhe de quantitativo' })).toHaveTextContent('Subtotal: 3 UND');
    expect(second.container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(3);
    expect(saved.dailyLogs?.[0].quantityDetails?.[0].source?.points).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }]);
  });
  it('guarda grupos diferentes nas colunas A e B da mesma linha', async () => {
    window.scrollTo = vi.fn();
    const initial = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} chapterId="phase-1" takeoffStorageKey="scope" onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna A da linha 1 na planta' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir contagem de teste' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Levantar coluna B da linha 1 na planta' }));
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Concluir outra contagem' })); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const detail = screen.getByRole('region', { name: 'Detalhe de quantitativo' });
    expect(screen.getByRole('img', { name: 'Origem na planta da linha 1' })).toHaveAttribute('title', expect.stringContaining('A: Placas.pdf'));
    expect(screen.getByRole('img', { name: 'Origem na planta da linha 1' })).toHaveAttribute('title', expect.stringContaining('B: Placas.pdf'));
    expect(detail).not.toHaveTextContent('Placas.pdf');
    expect(detail).toHaveTextContent('Subtotal: 6 UND');
  });
  it('recalcula o realizado após edição, exclusão e remontagem do lançamento', () => {
    let saved = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    function Harness({ initial }: { initial: Task }) {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} onChange={dailyLogs => setTask(previous => { saved = { ...previous, dailyLogs }; return saved; })} />;
    }
    const first = render(<Harness initial={saved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    const measure = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    fireEvent.change(measure, { target: { value: '3' } }); fireEvent.blur(measure);
    expect(first.container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(3);
    const changed = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    fireEvent.change(changed, { target: { value: '5' } }); fireEvent.blur(changed);
    expect(first.container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(5);
    first.unmount();
    const second = render(<Harness initial={saved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 1' })).toHaveValue(5);
    expect(second.container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(5);
    fireEvent.click(screen.getByRole('button', { name: 'Excluir linha 1' }));
    expect(second.container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(0);
  });
  it('bloqueia detalhe acima do saldo contratado sem alterar valor anterior', () => {
    const initial = buildTask({ quantity: 4, dailyLogs: [
      { id: 'log-0', date: '2026-09-07', plannedQuantity: 3, actualQuantity: 3 },
      { id: 'log-1', date: '2026-09-08', plannedQuantity: 1, actualQuantity: 0 },
    ] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    const measure = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    fireEvent.change(measure, { target: { value: '2' } }); fireEvent.blur(measure);
    expect(screen.getByRole('spinbutton', { name: 'Medida da linha 1' })).toHaveValue(0);
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(0);
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-0"]')).toHaveValue(3);
    expect(screen.getByRole('alert')).toHaveTextContent(/contratad|ultrapass/i);
  });
  it('mostra quantidade total e saldo a executar mesmo sem lançamentos', () => {
    render(<DailyLogsPanel task={buildTask()} onChange={vi.fn()} />);

    expect(screen.getByText(/Quantidade total:/)).toHaveTextContent('Quantidade total: 16 UND');
    expect(screen.getByText(/A executar:/)).toHaveTextContent('A executar: 16 UND');
    expect(screen.getByRole('button', { name: /Adicionar lançamento/i })).toBeEnabled();
  });

  it('deixa um único novo lançamento abaixo da última linha e o cria no dia seguinte', () => {
    const onChange = vi.fn();
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 10 }] });
    const { container } = render(<DailyLogsPanel task={task} onChange={onChange} />);

    const addButton = screen.getByRole('button', { name: /Novo lançamento/i });
    expect(screen.getAllByRole('button', { name: /Novo lançamento/i })).toHaveLength(1);
    expect(container.querySelector('[data-log-date="2026-09-08"]')?.compareDocumentPosition(addButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.click(addButton);
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ date: '2026-09-09', actualQuantity: 0 }),
    ]));
  });

  it('mostra saldo zero e bloqueia novo lançamento quando concluída', () => {
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 16 }] });
    render(<DailyLogsPanel task={task} onChange={vi.fn()} />);

    expect(screen.getByText(/A executar:/)).toHaveTextContent('A executar: 0 UND');
    expect(screen.getByRole('button', { name: /Novo lançamento/i })).toBeDisabled();
  });

  it('mantém o realizado em rascunho e confirma somente uma vez ao sair do campo', () => {
    const onChange = vi.fn();
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 1 }] });
    const { container } = render(<DailyLogsPanel task={task} onChange={onChange} />);
    const actual = container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')!;

    fireEvent.change(actual, { target: { value: '5' } });
    fireEvent.change(actual, { target: { value: '12' } });
    fireEvent.change(actual, { target: { value: '15' } });

    expect(actual).toHaveValue(15);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(actual);
    fireEvent.blur(actual);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'log-1', actualQuantity: 15 }),
    ]);
  });

  it('não incrementa o Realizado com setas ou roda do mouse', () => {
    const onChange = vi.fn();
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 3 }] });
    const { container } = render(<DailyLogsPanel task={task} onChange={onChange} />);
    const actual = container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')!;
    expect(actual).toHaveClass('no-spinner');
    fireEvent.focus(actual);
    expect(fireEvent.keyDown(actual, { key: 'ArrowUp' })).toBe(false);
    expect(fireEvent.keyDown(actual, { key: 'ArrowDown' })).toBe(false);
    fireEvent.wheel(actual, { deltaY: -100 });
    expect(actual).toHaveValue(3);
    expect(actual).not.toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('recupera a última digitação local após desmontagem sem enviar a obra', () => {
    const onChange = vi.fn();
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 1 }] });
    const first = render(<DailyLogsPanel projectId="project-1" task={task} onChange={onChange} />);
    fireEvent.change(first.container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')!, { target: { value: '7' } });
    expect(onChange).not.toHaveBeenCalled();
    first.unmount();

    const second = render(<DailyLogsPanel projectId="project-1" task={task} onChange={onChange} />);
    expect(second.container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(7);
    second.unmount();
    localStorage.clear();
  });

  it('confirma o campo pendente antes de uma navegação protegida', () => {
    const onChange = vi.fn();
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 1 }] });
    const { container } = render(<DailyLogsPanel projectId="project-2" task={task} onChange={onChange} />);
    fireEvent.change(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')!, { target: { value: '6' } });
    act(() => { flushPendingEditCommits(); });
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ actualQuantity: 6 })]);
    localStorage.clear();
  });

  it('confirma no Enter sem duplicar a gravação no blur seguinte', () => {
    const onChange = vi.fn();
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 1 }] });
    const { container } = render(<DailyLogsPanel task={task} onChange={onChange} />);
    const actual = container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')!;

    fireEvent.change(actual, { target: { value: '9' } });
    fireEvent.keyDown(actual, { key: 'Enter' });
    fireEvent.blur(actual);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'log-1', actualQuantity: 9 }),
    ]);
  });

  it('descarta o rascunho com Escape sem alterar o lançamento confirmado', () => {
    const onChange = vi.fn();
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 5 }] });
    const { container } = render(<DailyLogsPanel task={task} onChange={onChange} />);
    const actual = container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')!;

    fireEvent.change(actual, { target: { value: '14' } });
    fireEvent.keyDown(actual, { key: 'Escape' });
    fireEvent.blur(actual);

    expect(actual).toHaveValue(5);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('preserva rascunho inválido e não ultrapassa o contratado ao confirmar', () => {
    const onChange = vi.fn();
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 15 }] });
    const { container } = render(<DailyLogsPanel task={task} onChange={onChange} />);
    const actual = container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')!;

    fireEvent.change(actual, { target: { value: '17' } });
    fireEvent.blur(actual);

    expect(actual).toHaveValue(17);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/não pode ultrapassar/i);
  });

  it('confirma data, meta, observação e mão de obra em uma única atualização', () => {
    const onChange = vi.fn();
    const task = buildTask({
      dailyLogs: [{
        id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 1, notes: '',
        laborEntries: [{ id: 'labor-1', role: 'Pedreiro', workerName: 'João', teamCode: 'A', hours: 8, hourlyCost: 15 }],
      }],
    });
    const { container } = render(<DailyLogsPanel task={task} onChange={onChange} />);
    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    const date = inputs[0];
    const planned = inputs[1];
    const notes = inputs[3];
    const worker = screen.getByPlaceholderText('Nome');
    const hours = inputs[7];

    fireEvent.change(date, { target: { value: '2026-09-09' } });
    fireEvent.change(planned, { target: { value: '10' } });
    fireEvent.change(notes, { target: { value: 'Concretagem concluída' } });
    fireEvent.change(worker, { target: { value: 'Maria' } });
    fireEvent.change(hours, { target: { value: '6' } });
    fireEvent.blur(hours);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        date: '2026-09-09', plannedQuantity: 10, notes: 'Concretagem concluída',
        laborEntries: [expect.objectContaining({ workerName: 'Maria', hours: 6 })],
      }),
    ]);
  });

  it('inclui mão de obra junto com os rascunhos pendentes, sem uma gravação por campo', () => {
    const onChange = vi.fn();
    const task = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 1 }] });
    const { container } = render(<DailyLogsPanel task={task} onChange={onChange} />);
    const actual = container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')!;

    fireEvent.change(actual, { target: { value: '4' } });
    fireEvent.click(screen.getByTitle('Apontar mão de obra deste dia'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ actualQuantity: 4, laborEntries: [expect.objectContaining({ hours: 8 })] }),
    ]);
  });
});
