import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@/types/project';
import { approveRescheduleRequest, createRescheduleRequest, reschedulePreview, submitRescheduleRequest } from './taskRescheduling';
import { buildWeeklyRoutine } from './weeklyRoutine';
import { buildOperationalProjectFromPendingAdditives } from './additiveSchedule';
import { getWorkEndDate } from '@/components/gantt/utils';
import { mergeOperationalProjectIntoRaw } from './operationalProject';
import { applyDailyProductionLogs, upsertDailyProductionLog } from './dailyProductionLogs';

const config = { uf: 'SP', municipio: 'São Paulo', jornadaDiaria: 8, trabalhaSabado: false };
const baseTask: Task = {
  id: 'task-1', name: 'Instalar hidrante', phase: 'phase-1', startDate: '2026-09-10', duration: 3,
  dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0, quantity: 30, unit: 'm',
};
const project = (): Project => ({ id: 'project-1', name: 'Obra', startDate: '2026-09-01', endDate: '2026-10-01', totalBudget: 0, phases: [{ id: 'phase-1', name: 'Capítulo', color: '#3b82f6', tasks: [baseTask] }] });

describe('taskRescheduling', () => {
  it('acrescenta os dias úteis até a data escolhida e reposiciona o cartão semanal', () => {
    const request = createRescheduleRequest(baseTask, '2026-09-15', 'Frente liberada posteriormente', config, { userName: 'Engenheiro' });
    const requested = submitRescheduleRequest(project(), request, { userName: 'Engenheiro' });
    const approved = approveRescheduleRequest(requested, request.id, config, { userName: 'Administrador' });
    const task = approved.phases[0].tasks[0];

    expect(task.startDate).toBe('2026-09-15');
    expect(task.duration).toBe(6);
    expect(task.baseline?.startDate).toBe('2026-09-10');
    expect(task.operationalReschedule?.endDate).toBe('2026-09-22');
    expect(buildWeeklyRoutine(approved, '2026-09-07', new Set(), config).flatMap(day => day.activities)).toHaveLength(0);
    const activities = buildWeeklyRoutine(approved, '2026-09-14', new Set(), config).flatMap(day => day.activities);
    expect(activities.map(activity => activity.date)).toEqual(['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
    expect(buildWeeklyRoutine(approved, '2026-09-21', new Set(), config).flatMap(day => day.activities).map(activity => activity.date)).toEqual(['2026-09-21', '2026-09-22']);
    expect(activities.every(activity => activity.reprogrammed)).toBe(true);
  });

  it('reprograma somente o saldo após produção real', () => {
    const started: Task = { ...baseTask, dailyLogs: [{ id: 'log', date: '2026-09-10', plannedQuantity: 10, actualQuantity: 10 }] };
    const preview = reschedulePreview(started, '2026-09-15', config);

    expect(preview).toMatchObject({ scope: 'remaining_work', quantity: 20, delayDuration: 3, duration: 5, endDate: '2026-09-21' });
  });

  it('normaliza feriado, domingo e sábado sem expediente para o próximo dia útil', () => {
    const holiday = reschedulePreview(baseTask, '2026-09-07', config); // Independência do Brasil em 2026
    const sunday = reschedulePreview(baseTask, '2026-09-13', config);
    const saturday = reschedulePreview(baseTask, '2026-09-12', config);

    expect(holiday).toMatchObject({ startDate: '2026-09-08', endDate: '2026-09-10' });
    expect(sunday).toMatchObject({ startDate: '2026-09-14', duration: 5, endDate: '2026-09-18' });
    expect(saturday.startDate).toBe('2026-09-14');
    expect(getWorkEndDate('2026-09-04', 2, false, config)).toBe('2026-09-08');
  });

  it('permite antecipação sem acrescentar dias de atraso', () => {
    const preview = reschedulePreview(baseTask, '2026-09-08', config);

    expect(preview).toMatchObject({ startDate: '2026-09-08', delayDuration: 0, duration: 3, endDate: '2026-09-10' });
  });

  it('reprograma tarefa filha e persiste a data na hierarquia', () => {
    const child: Task = { ...baseTask, id: 'child-task', name: 'Subatividade', startDate: '2026-09-10' };
    const hierarchical: Project = {
      ...project(),
      phases: [{
        ...project().phases[0],
        tasks: [{ ...baseTask, id: 'parent-task', name: 'Resumo', children: [child] }, {
          ...baseTask, id: 'successor', startDate: '2026-09-14', dependencies: ['child-task'], name: 'Sucessora',
        }],
      }],
    };
    const request = createRescheduleRequest(child, '2026-09-15', 'Frente liberada posteriormente', config, { userName: 'Engenheiro' });
    const approved = approveRescheduleRequest(submitRescheduleRequest(hierarchical, request, { userName: 'Engenheiro' }), request.id, config, { userName: 'Administrador' });
    const persistedChild = approved.phases[0].tasks[0].children?.[0];

    expect(persistedChild).toMatchObject({ startDate: '2026-09-15', operationalReschedule: { requestId: request.id } });
    expect(approved.phases[0].tasks[1].startDate).not.toBe('2026-09-14');
    expect(buildWeeklyRoutine(approved, '2026-09-14', new Set(), config).flatMap(day => day.activities)
      .some(activity => activity.taskId === 'child-task')).toBe(true);
  });

  it('atualiza o plano pendente do aditivo para a rotina não restaurar as datas antigas', () => {
    const raw = {
      ...project(),
      additives: [{
        id: 'add-1', name: 'Aditivo pendente', importedAt: '2026-09-01T00:00:00.000Z', status: 'aprovado', compositions: [],
        scheduleDraft: {
          version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', dependentTaskIds: [], plannedTasks: [],
          contractedTaskPlans: [{ taskId: 'task-1', startDate: '2026-09-12', duration: 3, dependencies: [], responsible: '', durationMode: 'manual', isManual: true, manualDuration: 3 }],
        },
      }],
    } as Project;
    const operational = buildOperationalProjectFromPendingAdditives(raw);
    const task = operational.phases[0].tasks[0];
    const request = createRescheduleRequest(task, '2026-09-15', 'Frente liberada posteriormente', config, { userName: 'Engenheiro' });
    const approved = approveRescheduleRequest(submitRescheduleRequest(operational, request, { userName: 'Engenheiro' }), request.id, config, { userName: 'Administrador' });
    const persisted = mergeOperationalProjectIntoRaw(raw, approved);

    expect(approved.phases[0].tasks[0]).toMatchObject({ startDate: '2026-09-15', duration: 5 });
    expect(approved.additives?.[0].scheduleDraft?.contractedTaskPlans?.[0]).toMatchObject({ startDate: '2026-09-15', duration: 5 });
    expect(persisted.phases[0].tasks[0]).toMatchObject({ startDate: '2026-09-10', duration: 3 });
    expect(persisted.rescheduleRequests?.find(item => item.id === request.id)?.status).toBe('approved');
    expect(buildOperationalProjectFromPendingAdditives(persisted).phases[0].tasks[0]).toMatchObject({ startDate: '2026-09-15', duration: 5 });
  });

  it('preserva a produção de tarefa controlada por aditivo pendente ao voltar da Rotina', () => {
    const raw = {
      ...project(),
      additives: [{
        id: 'add-1', name: 'Aditivo pendente', importedAt: '2026-09-01T00:00:00.000Z', status: 'aprovado', compositions: [],
        scheduleDraft: {
          version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', dependentTaskIds: [], plannedTasks: [],
          contractedTaskPlans: [{ taskId: 'task-1', startDate: '2026-09-15', duration: 3, dependencies: [], responsible: '', durationMode: 'manual', isManual: true, manualDuration: 3 }],
        },
      }],
    } as Project;
    const operational = buildOperationalProjectFromPendingAdditives(raw);
    const recorded = {
      ...operational,
      phases: [{
        ...operational.phases[0],
        tasks: operational.phases[0].tasks.map(task => task.id === 'task-1' ? {
          ...task,
          ...applyDailyProductionLogs(task, upsertDailyProductionLog(task, '2026-09-15', 4)),
        } : task),
      }],
    };

    const persisted = mergeOperationalProjectIntoRaw(raw, recorded);
    const saved = persisted.phases[0].tasks[0];
    expect(saved).toMatchObject({ startDate: '2026-09-10', duration: 3, executedQuantityTotal: 4, physicalProgress: 13.333333333333334, percentComplete: 13 });
    expect(saved.dailyLogs).toMatchObject([{ date: '2026-09-15', actualQuantity: 4 }]);
    expect(buildOperationalProjectFromPendingAdditives(persisted).phases[0].tasks[0]).toMatchObject({ startDate: '2026-09-15', duration: 3, executedQuantityTotal: 4, percentComplete: 13 });
  });
});
