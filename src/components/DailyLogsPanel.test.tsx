import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DailyLogsPanel from './DailyLogsPanel';
import type { Task } from '@/types/project';

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
