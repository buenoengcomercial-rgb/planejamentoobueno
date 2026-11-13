import { expect, it } from 'vitest';
import type { Project, Task } from '@/types/project';
import { includeClosingSchedule, calculateClosingCPM } from './closingSchedule';
import { mergeOperationalProjectIntoRaw } from './operationalProject';
import { applyProjectOperation } from './projectOperations';

it('projects closing work without creating contract rows and calculates deadline float', () => {
  const task: Task = { id: 'docs', phase: 'p', name: 'Documentação', startDate: '2027-05-03', duration: 10,
    dependencies: [], percentComplete: 0, responsible: '', materials: [], level: 0, quantity: 1, unitPrice: 100,
    operationalReschedule: { requestId: 'r', scope: 'remaining_work', startDate: '2027-05-03', duration: 10,
      endDate: '2027-05-14', quantity: 1, reason: 'Entrega', approvedAt: '2026-11-13', closingDeadline: '2027-05-14',
      closingActivities: [
        { id: 'closing:docs:test', name: 'Testes', startDate: '2027-05-03', duration: 3, team: 'c', dependencies: [], reason: 'Teste' },
        { id: 'closing:docs:fix', name: 'Correções', startDate: '2027-05-06', duration: 4, team: 'c', dependencies: [{ taskId: 'closing:docs:test', type: 'TI' }], reason: 'Correções' },
        { id: 'closing:docs:delivery', name: 'Conferência', startDate: '2027-05-12', duration: 3, team: 'c', dependencies: [{ taskId: 'closing:docs:fix', type: 'TI' }], reason: 'Entrega' },
      ] } };
  const p = { id: 'p', name: 'Obra', phases: [{ id: 'p', name: 'Contrato', color: '#000', tasks: [task] }],
    scheduleCalendar: { uf: 'RO', municipio: 'Porto Velho', jornadaDiaria: 8, trabalhaSabado: false } } as Project;
  const frozen = JSON.stringify(p);
  const display = calculateClosingCPM(includeClosingSchedule(p).project);
  expect(display.phases.at(-1)!.tasks).toHaveLength(3);
  expect(display.phases.at(-1)!.tasks.every(t => t.isCritical && t.quantity === undefined && t.unitPrice === undefined)).toBe(true);
  expect(JSON.stringify(p)).toBe(frozen);
  expect(includeClosingSchedule(display).project.phases).toHaveLength(2);
  const raw = mergeOperationalProjectIntoRaw(p, display);
  expect(applyProjectOperation('gantt', p, p, raw).phases[0].tasks[0].quantity).toBe(1);
  expect(raw.phases).toHaveLength(1);
});
