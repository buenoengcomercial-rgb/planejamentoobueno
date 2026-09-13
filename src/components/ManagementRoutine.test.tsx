import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('ManagementRoutine semanal por capítulo', () => {
  beforeEach(() => localStorage.clear());

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
    fireEvent.click(screen.getByRole('button', { name: 'Buscar atividade' }));
    fireEvent.change(screen.getByLabelText('Atividade'), { target: { value: 'detector' } });
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

  it('mostra somente o capítulo escolhido e guarda a preferência por obra', () => {
    const onProjectChange = vi.fn();
    const projectWithTwoChapters = {
      ...project,
      managementRoutine: {
        responsibleName: 'Responsável preservado',
        weeklyChecklist: [],
        roles: [],
        meetings: [],
      },
      phases: [
        { ...project.phases[0], tasks: [{ ...project.phases[0].tasks[0], startDate: '2026-08-10' }] },
        {
          id: 'chapter-1-1',
          parentId: 'chapter-1',
          name: 'Detecção',
          customNumber: '1.1',
          color: '#38bdf8',
          tasks: [{ ...project.phases[0].tasks[0], id: 'task-1-1', phase: 'chapter-1-1', name: 'Testar central de alarme', startDate: '2026-08-10' }],
        },
        {
          id: 'chapter-2',
          name: 'Hidráulica',
          customNumber: '2',
          color: '#10b981',
          tasks: [{ ...project.phases[0].tasks[0], id: 'task-2', phase: 'chapter-2', name: 'Instalar hidrante', startDate: '2026-08-10' }],
        },
      ],
    } as unknown as Project;

    render(
      <ManagementRoutine
        project={projectWithTwoChapters}
        onProjectChange={onProjectChange}
        onOpenDailyReport={vi.fn()}
        onOpenProduction={vi.fn()}
        initialWeek="2026-08-10"
      />,
    );

    expect(screen.queryByRole('tab', { name: 'Agenda da semana' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Configuração da rotina' })).not.toBeInTheDocument();
    expect(screen.queryByText('Responsáveis e parâmetros')).not.toBeInTheDocument();
    expect(screen.getByText('Capítulo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Incêndio' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('Instalar detector de fumaça').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Testar central de alarme').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1\.1 · Detecção/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('Instalar hidrante')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hidráulica' }));
    expect(screen.queryByText('Instalar detector de fumaça')).not.toBeInTheDocument();
    expect(screen.queryByText('Testar central de alarme')).not.toBeInTheDocument();
    expect(screen.getAllByText('Instalar hidrante').length).toBeGreaterThan(0);
    expect(localStorage.getItem('obraplanner:routine-chapter:project-routine')).toBe('chapter-2');
    expect(onProjectChange).not.toHaveBeenCalled();
  });
});
