import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import DailyLogsPanel from './DailyLogsPanel';
import type { Task } from '@/types/project';
import { flushPendingEditCommits } from '@/lib/pendingEditCommits';

vi.mock('@/components/planTakeoff/PlanTakeoff', () => ({
  default: ({ onUseMeasure }: { onUseMeasure: (plan: object, measure: object, result: number) => void }) =>
    <button onClick={() => onUseMeasure({ id: 'plan-1', name: 'Placas.pdf' }, { id: 'measure-1', name: 'Executadas', kind: 'count', page: 2, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }, 2)}>Escolher marcação de teste</button>,
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
  it('mantém a quantidade manual até aplicar o total detalhado e preserva as linhas no lançamento', () => {
    const initial = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 2 }] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.click(screen.getByRole('button', { name: 'Linha' }));
    const measure = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    fireEvent.change(measure, { target: { value: '7' } });
    fireEvent.blur(measure);
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(2);
    expect(screen.getByRole('region', { name: 'Detalhe de quantitativo' })).toHaveTextContent('Detalhe: 7 UND');
    fireEvent.click(screen.getByRole('button', { name: 'Usar total no realizado do dia' }));
    expect(container.querySelector<HTMLInputElement>('[data-actual-input="log-1"]')).toHaveValue(7);
    expect(screen.getByRole('region', { name: 'Detalhe de quantitativo' })).toHaveTextContent('Dia: 7 UND');
  });
  it('vincula pontos da planta ao dia e impede reutilizar a mesma marcação em outra linha', async () => {
    window.scrollTo = vi.fn();
    const initial = buildTask({ dailyLogs: [{ id: 'log-1', date: '2026-09-08', plannedQuantity: 8, actualQuantity: 0 }] });
    function Harness() {
      const [task, setTask] = useState(initial);
      return <DailyLogsPanel task={task} takeoffStorageKey="scope" onChange={dailyLogs => setTask(previous => ({ ...previous, dailyLogs }))} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Detalhar quantitativo de 2026-09-08' }));
    fireEvent.click(screen.getByRole('button', { name: 'Linha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Planta' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Escolher marcação de teste' }));
    expect(screen.getByRole('region', { name: 'Detalhe de quantitativo' })).toHaveTextContent('Placas.pdf · 2 pt.');
    fireEvent.click(screen.getByRole('button', { name: 'Linha' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Planta' })[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'Escolher marcação de teste' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('já está vinculada a outra linha');
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
