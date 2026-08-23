import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@/types/project';
import { approveRescheduleRequest, createRescheduleRequest, reschedulePreview, submitRescheduleRequest } from './taskRescheduling';
import { buildWeeklyRoutine } from './weeklyRoutine';

const config = { uf: 'SP', municipio: 'São Paulo', jornadaDiaria: 8, trabalhaSabado: false };
const baseTask: Task = {
  id: 'task-1', name: 'Instalar hidrante', phase: 'phase-1', startDate: '2026-09-10', duration: 3,
  dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0, quantity: 30, unit: 'm',
};
const project = (): Project => ({ id: 'project-1', name: 'Obra', startDate: '2026-09-01', endDate: '2026-10-01', totalBudget: 0, phases: [{ id: 'phase-1', name: 'Capítulo', tasks: [baseTask] }] });

describe('taskRescheduling', () => {
  it('preserva duração, move a atividade e reposiciona o cartão semanal', () => {
    const request = createRescheduleRequest(baseTask, '2026-09-15', 'Frente liberada posteriormente', config, { userName: 'Engenheiro' });
    const requested = submitRescheduleRequest(project(), request, { userName: 'Engenheiro' });
    const approved = approveRescheduleRequest(requested, request.id, config, { userName: 'Administrador' });
    const task = approved.phases[0].tasks[0];

    expect(task.startDate).toBe('2026-09-15');
    expect(task.duration).toBe(3);
    expect(task.baseline?.startDate).toBe('2026-09-10');
    expect(task.operationalReschedule?.endDate).toBe('2026-09-17');
    expect(buildWeeklyRoutine(approved, '2026-09-07', new Set(), config).flatMap(day => day.activities)).toHaveLength(0);
    expect(buildWeeklyRoutine(approved, '2026-09-14', new Set(), config).flatMap(day => day.activities).map(activity => activity.date)).toEqual(['2026-09-15', '2026-09-16', '2026-09-17']);
  });

  it('reprograma somente o saldo após produção real', () => {
    const started: Task = { ...baseTask, dailyLogs: [{ id: 'log', date: '2026-09-10', plannedQuantity: 10, actualQuantity: 10 }] };
    const preview = reschedulePreview(started, '2026-09-15', config);

    expect(preview).toMatchObject({ scope: 'remaining_work', quantity: 20, duration: 2, endDate: '2026-09-16' });
  });
});
