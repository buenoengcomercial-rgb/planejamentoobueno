import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { buildWeeklyRoutine, diaryStatusForDate, findNextScheduledActivity, groupWeeklyRoutineActivities, startOfWeekISO } from './weeklyRoutine';

const project = {
  id: 'p1',
  name: 'Obra',
  startDate: '2026-08-10',
  endDate: '2026-08-30',
  totalBudget: 0,
  phases: [{
    id: 'phase-1',
    name: 'Instalações',
    tasks: [{
      id: 'task-1',
      name: 'Instalar hidrantes',
      phase: 'phase-1',
      startDate: '2026-08-12',
      duration: 3,
      dependencies: [],
      responsible: 'João',
      percentComplete: 0,
      materials: [],
      level: 0,
      quantity: 30,
      unit: 'un',
      dailyLogs: [{ date: '2026-08-13', plannedQuantity: 10, actualQuantity: 10 }],
    }],
  }],
  dailyReports: [{
    id: 'dr-1',
    date: '2026-08-13',
    responsible: 'João',
    createdAt: '2026-08-13T10:00:00.000Z',
    updatedAt: '2026-08-13T10:00:00.000Z',
  }],
} as unknown as Project;

describe('weeklyRoutine', () => {
  it('normaliza a semana de segunda a domingo', () => {
    expect(startOfWeekISO('2026-08-15')).toBe('2026-08-10');
    expect(startOfWeekISO('2026-08-16')).toBe('2026-08-10');
  });

  it('distribui a atividade nos dias em que cruza o cronograma', () => {
    const week = buildWeeklyRoutine(project, '2026-08-10');
    expect(week).toHaveLength(7);
    expect(week.find(day => day.date === '2026-08-12')?.activities).toHaveLength(1);
    expect(week.find(day => day.date === '2026-08-13')?.activities[0]).toMatchObject({
      plannedQuantity: 10,
      actualQuantity: 10,
      completed: true,
    });
    expect(week.find(day => day.date === '2026-08-15')?.activities).toHaveLength(0);
  });

  it('remove da agenda os bloqueios operacionais pendentes, sem remover serviços com saldo contratual', () => {
    const projectWithPendingAdditive = {
      ...project,
      phases: [{
        ...project.phases[0],
        tasks: [
          ...project.phases[0].tasks,
          {
            ...project.phases[0].tasks[0],
            id: 'suppressed-pending',
            name: 'Item suprimido pendente',
            startDate: '2026-08-12',
          },
          {
            ...project.phases[0].tasks[0],
            id: 'suspended-pending',
            name: 'Aguarda contratação',
            startDate: '2026-08-12',
          },
          {
            ...project.phases[0].tasks[0],
            id: 'dependency-pending',
            name: 'Bloqueada por dependência',
            startDate: '2026-08-12',
          },
          {
            ...project.phases[0].tasks[0],
            id: 'contracted-balance',
            name: 'Saldo contratado executável',
            startDate: '2026-08-12',
          },
        ],
      }],
    } as Project;
    const blocked = new Set(['suppressed-pending', 'suspended-pending', 'dependency-pending']);

    const week = buildWeeklyRoutine(projectWithPendingAdditive, '2026-08-10', blocked);
    expect(week.find(day => day.date === '2026-08-12')?.activities.map(activity => activity.taskId)).toEqual([
      'task-1',
      'contracted-balance',
    ]);
    expect(findNextScheduledActivity(projectWithPendingAdditive, '2026-08-12', blocked)?.taskId).toBe('task-1');
  });

  it('deriva os estados do diário sem tratar ausência como sem produção', () => {
    expect(diaryStatusForDate(undefined)).toBe('notFilled');
    expect(diaryStatusForDate({ noProductionDeclared: true } as never)).toBe('noProduction');
    expect(diaryStatusForDate({ impediments: 'Chuva' } as never)).toBe('impediment');
  });

  it('usa a programação atual em vez da baseline e organiza o caminho de capítulos', () => {
    const scheduledProject = {
      ...project,
      phases: [
        { id: 'main', name: 'Incêndio', tasks: [], order: 0 },
        {
          ...project.phases[0],
          id: 'sub',
          parentId: 'main',
          name: 'Hidrantes',
          order: 0,
          tasks: [{
            ...project.phases[0].tasks[0],
            id: 'esguicho',
            name: 'Esguicho reprogramado',
            phase: 'sub',
            startDate: '2026-09-16',
            duration: 2,
            baseline: { startDate: '2026-08-24', endDate: '2026-08-25', duration: 2, capturedAt: '2026-08-01T00:00:00.000Z' },
            current: { startDate: '2026-08-24', endDate: '2026-08-25', duration: 2, updatedAt: '2026-08-01T00:00:00.000Z' },
          }],
        },
      ],
    } as Project;

    expect(buildWeeklyRoutine(scheduledProject, '2026-08-24').flatMap(day => day.activities)).toHaveLength(0);
    const septemberWeek = buildWeeklyRoutine(scheduledProject, '2026-09-14');
    expect(septemberWeek.find(day => day.date === '2026-09-16')?.activities[0]).toMatchObject({
      taskId: 'esguicho', startDate: '2026-09-16', endDate: '2026-09-17',
      chapterPath: [
        { id: 'main', name: 'Incêndio', number: '1' },
        { id: 'sub', name: 'Hidrantes', number: '1.1' },
      ],
    });
    const groups = groupWeeklyRoutineActivities(septemberWeek.find(day => day.date === '2026-09-16')!.activities);
    expect(groups).toMatchObject([{ chapter: { id: 'main' }, totalActivities: 1, children: [{ chapter: { id: 'sub' }, totalActivities: 1 }] }]);
  });
});
