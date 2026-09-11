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
});
