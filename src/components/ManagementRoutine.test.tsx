import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@/types/project';
import ManagementRoutine from './ManagementRoutine';

const project = {
  id: 'project-routine',
  name: 'Obra teste',
  startDate: '2026-08-01',
  endDate: '2026-09-30',
  totalBudget: 0,
  scheduleCalendar: { uf: 'RO', municipio: 'Porto Velho', trabalhaSabado: false },
  phases: [{
    id: 'chapter-1',
    name: 'Incêndio',
    customNumber: '1',
    color: '#0ea5e9',
    tasks: [{
      id: 'task-1',
      name: 'Instalar detector de fumaça',
      phase: 'chapter-1',
      startDate: '2026-08-10',
      duration: 2,
      dependencies: [],
      percentComplete: 0,
      materials: [],
      level: 0,
      quantity: 20,
      unit: 'un',
      dailyLogs: [],
    }],
  }],
} as unknown as Project;

describe('ManagementRoutine compacta', () => {
  it('busca atividade fora da data e grava produção com reprogramação aprovada', () => {
    const onProjectChange = vi.fn();
    render(
      <ManagementRoutine
        project={project}
        onProjectChange={onProjectChange}
        onOpenDailyReport={vi.fn()}
        onOpenProduction={vi.fn()}
        canRequestReschedule
        canApproveReschedule
        auditActor={{ userName: 'Proprietário', userEmail: 'owner@example.com' }}
        initialWeek="2026-08-20"
      />,
    );

    expect(screen.queryByText('Instalar detector de fumaça')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar atividade' }), { target: { value: 'detector' } });
    fireEvent.click(screen.getByRole('button', { name: /Instalar detector de fumaça/i }));
    fireEvent.change(screen.getByLabelText(/Quantidade executada em 20\/08\/2026/i), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar' }));

    const updater = onProjectChange.mock.calls.at(-1)?.[0] as (previous: Project) => Project;
    const updated = updater(project);
    const task = updated.phases[0].tasks[0];
    expect(task.startDate).toBe('2026-08-20');
    expect(task.dailyLogs).toEqual(expect.arrayContaining([expect.objectContaining({ date: '2026-08-20', actualQuantity: 4 })]));
    expect(task.operationalReschedule).toMatchObject({ startDate: '2026-08-20' });
    expect(updated.rescheduleRequests).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: 'task-1', status: 'approved' })]));
  });
});
