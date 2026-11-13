import { expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { applyProjectedProjectOperation } from './projectOperations';

const raw = { id: 'p', phases: [{ id: 'c', tasks: [
  { id: 'a', startDate: '2026-11-13', duration: 2, percentComplete: 25, quantity: 10 },
  { id: 'b', startDate: '2026-11-13', duration: 1, percentComplete: 0, quantity: 5 },
] }], measurements: [{ id: 'm' }] } as unknown as Project;
const projection = () => {
  const result = structuredClone(raw);
  result.phases[0].tasks[0].startDate = '2026-11-16';
  result.phases[0].tasks[1].startDate = '2026-11-19';
  return result;
};
it('edita data calculada sem persistir recálculos de tarefas não editadas ou execução', () => {
  const before = projection(), after = structuredClone(before);
  after.phases[0].tasks[0].startDate = '2026-12-01';
  after.phases[0].tasks[0].percentComplete = 99;
  const saved = applyProjectedProjectOperation('gantt', raw, before, before, after);
  expect(saved.phases[0].tasks[0].startDate).toBe('2026-12-01');
  expect(saved.phases[0].tasks[0].percentComplete).toBe(25);
  expect(saved.phases[0].tasks[1]).toEqual(raw.phases[0].tasks[1]);
  expect(saved.measurements).toEqual(raw.measurements);
});
it('rejeita mudança concorrente real observada na projeção atual', () => {
  const before = projection(), after = structuredClone(before), current = projection();
  after.phases[0].tasks[0].startDate = '2026-12-01';
  current.phases[0].tasks[0].startDate = '2026-11-23';
  expect(() => applyProjectedProjectOperation('gantt', raw, current, before, after)).toThrow('Conflito');
});
