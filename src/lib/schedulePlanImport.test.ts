import { expect, it } from 'vitest';
import type { Additive, Project, Task } from '@/types/project';
import { applySchedulePlanImport, parseSchedulePlanImport, type SchedulePlanImport } from './schedulePlanImport';

function fixture() {
  const task: Task = { id: 'a', name: 'Tubulação', phase: 'p', startDate: '2026-08-24', duration: 10,
    quantity: 100, unitPrice: 20, percentComplete: 30, dependencies: [], responsible: '', materials: [], level: 0,
    dailyLogs: [{ id: 'l', date: '2026-09-01', actualQuantity: 30, plannedQuantity: 10 }],
    baseline: { startDate: '2026-08-24', duration: 10, endDate: '2026-09-04', capturedAt: '2026-08-24' } };
  const project = { id: 'p', name: 'Obra', phases: [{ id: 'p', name: 'p', color: '#000', tasks: [task] }],
    measurements: [{ id: 'fiscal' }], additives: [{ id: 'archive', scheduleSnapshots: [{ id: 'immutable' }] }] } as Project;
  const plan: SchedulePlanImport = { version: 1, projectId: 'p', name: 'Saldo',
    calendar: { uf: 'RO', municipio: 'Porto Velho', jornadaDiaria: 8, trabalhaSabado: false },
    teams: [{ code: 'proposta-1', label: 'Hidráulica 1', composition: 'Encanador e ajudante' }],
    tasks: [{ id: 'a', expected: { startDate: '2026-08-24', duration: 10, quantity: 100, percentComplete: 30 },
      startDate: '2026-11-13', duration: 5, team: 'proposta-1', remainingQuantity: 70, dependencies: [], reason: 'Saldo após conciliação' }] };
  return { project, plan, task };
}

it('aplica só planejamento, registra auditoria e conserva histórico, contrato e linha de base', () => {
  const { project, plan, task } = fixture(); const original = JSON.stringify(project);
  const next = applySchedulePlanImport(project, plan, { userName: 'Responsável' });
  expect(next.phases[0].tasks[0]).toMatchObject({ startDate: '2026-11-13', duration: 5, quantity: 100,
    unitPrice: 20, percentComplete: 30, baseline: task.baseline, dailyLogs: task.dailyLogs,
    operationalReschedule: { quantity: 70, scope: 'remaining_work', endDate: '2026-11-19' } });
  expect(next.additives).toEqual(project.additives); expect(next.measurements).toEqual(project.measurements);
  expect(next.auditLogs?.at(-1)?.title).toBe('Programação operacional importada');
  expect(JSON.stringify(project)).toBe(original);
});

it('recusa contrato inserido no arquivo, outra obra, dados alterados e atividade bloqueada', () => {
  const { project, plan } = fixture();
  expect(() => parseSchedulePlanImport({ ...plan, measurements: [] })).toThrow();
  expect(() => applySchedulePlanImport(project, { ...plan, projectId: 'other' }, {})).toThrow(/outra obra/);
  project.phases[0].tasks[0].duration = 11;
  expect(() => applySchedulePlanImport(project, plan, {})).toThrow(/mudou/);
  expect(() => applySchedulePlanImport(project, plan, {}, new Set(['a']))).toThrow(/bloqueada/);
});

it('recusa início em feriado e dependências circulares', () => {
  const { project, plan, task } = fixture();
  plan.tasks[0].startDate = '2026-11-20';
  expect(() => applySchedulePlanImport(project, plan, {})).toThrow(/calendário/);
  plan.tasks[0].startDate = '2026-11-13';
  project.phases[0].tasks.push({ ...task, id: 'b', dependencies: ['a'] });
  plan.tasks[0].dependencies = [{ taskId: 'b', type: 'II', lag: 1 }];
  expect(() => applySchedulePlanImport(project, plan, {})).toThrow(/circular/);
});

it('recusa sobreposição da mesma equipe e início anterior à defasagem', () => {
  const { project, plan, task } = fixture();
  project.phases[0].tasks.push({ ...task, id: 'b' });
  plan.tasks.push({ ...plan.tasks[0], id: 'b' });
  expect(() => applySchedulePlanImport(project, plan, {})).toThrow(/simultaneamente/);
  plan.tasks[1].dependencies = [{ taskId: 'a', type: 'II', lag: 2 }];
  expect(() => applySchedulePlanImport(project, plan, {})).toThrow(/defasagem/);
});

it('só reprograma item originalmente concluído quando há acréscimo contratado comprovado', () => {
  const { project, plan } = fixture();
  project.phases[0].tasks[0].percentComplete = 100;
  plan.tasks[0].expected.percentComplete = 100;
  plan.tasks[0].remainingQuantity = 20;
  expect(() => applySchedulePlanImport(project, plan, {})).toThrow(/sem saldo aditivado/);
  const additive = { id: 'ad', isContracted: true, compositions: [{ id: 'comp', baseTaskId: 'a',
    quantity: 100, originalQuantity: 100, addedQuantity: 20, suppressedQuantity: 0,
    unitPriceNoBDI: 10, unitPriceWithBDI: 10, inputs: [] }] } as Additive;
  const next = applySchedulePlanImport(project, plan, {}, new Set(), [additive]);
  expect(next.phases[0].tasks[0]).toMatchObject({ quantity: 100, percentComplete: 100, operationalReschedule: { quantity: 20 } });
});


it('imports operational closing stages without changing contract rows, and rejects cycles or price fields', () => {
  const { project, plan } = fixture();
  plan.tasks[0].closingDeadline = '2026-11-26';
  plan.tasks[0].closingActivities = [
    { id: 'closing:a:test', name: 'Teste integrado', startDate: '2026-11-23', duration: 2,
      team: 'proposta-1', dependencies: [{ taskId: 'a', type: 'TI' }], reason: 'Verificação operacional' },
    { id: 'closing:a:fix', name: 'Correções', startDate: '2026-11-25', duration: 2,
      team: 'proposta-1', dependencies: [{ taskId: 'closing:a:test', type: 'TI' }], reason: 'Reserva estimada' },
  ];
  const next = applySchedulePlanImport(project, plan, {});
  expect(next.phases[0].tasks).toHaveLength(1);
  expect(next.phases[0].tasks[0].operationalReschedule?.closingActivities).toHaveLength(2);
  expect(next.phases[0].tasks[0].quantity).toBe(100);
  expect(next.measurements).toEqual(project.measurements);
  expect(() => parseSchedulePlanImport({ ...plan, tasks: [{ ...plan.tasks[0], closingActivities: [{ ...plan.tasks[0].closingActivities![0], unitPrice: 50 }] }] })).toThrow();
  plan.tasks[0].closingActivities[0].dependencies = [{ taskId: 'closing:a:fix', type: 'TI' }];
  expect(() => applySchedulePlanImport(project, plan, {})).toThrow(/circular/);
});
