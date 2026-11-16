import { expect, it } from 'vitest';
import type { Project, Task } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { rescheduleMonthlyGraph } from './splitOperationalSchedule';

const task = (id: string, options: Partial<Task> = {}): Task => ({
  id, name: id, phase: 'p', startDate: '2026-11-16', duration: 2, dependencies: [],
  percentComplete: 0, quantity: 10, materials: [], level: 0, responsible: '', ...options,
});
function project(tasks: Task[]): Project {
  return { id: 'obra', name: 'Obra', phases: [{ id: 'p', name: 'P', tasks, color: '#fff' }], startDate: '2026-09-01',
    endDate: '2027-05-14', totalBudget: 0, scheduleCalendar: { uf: 'RO', municipio: 'Porto Velho', jornadaDiaria: 8, trabalhaSabado: false } };
}

it('usa o início da primeira parcela e o término da última nos quatro tipos de vínculo', () => {
  const original = project([
    task('historical', { startDate: '2026-09-15', duration: 1, scheduleDisplayKind: 'history', percentComplete: 100 }),
    task('s'), ...(['TI', 'II', 'TT', 'IT'] as const).map(type =>
      task(type, { dependencies: ['s'], dependencyDetails: [{ taskId: 's', type, lag: 1 }] })),
  ]);
  const input = new Map([['s', { balance: 5, allocations: { '2027-01': 2.5, '2027-03': 2.5 } }]]);
  const next = rescheduleMonthlyGraph(original, input, 's', '2026-11-16');
  const byId = new Map(getAllTasks(next.project).map(item => [item.id, item]));
  expect(byId.get('historical')).toEqual(original.phases[0].tasks[0]);
  expect(byId.get('s')?.operationalReschedule?.monthlySegments).toEqual([
    { startDate: '2027-01-05', endDate: '2027-01-05', quantity: 2.5, duration: 1 },
    { startDate: '2027-03-01', endDate: '2027-03-01', quantity: 2.5, duration: 1 },
  ]);
  expect(byId.get('TI')?.startDate).toBe('2027-03-03');
  expect(byId.get('II')?.startDate).toBe('2027-01-06');
  expect(byId.get('TT')?.operationalReschedule?.endDate).toBe('2027-03-02');
  expect(byId.get('IT')?.operationalReschedule?.endDate).toBe('2027-01-05');
  expect(next.allocations.get('s')).toEqual(input.get('s')?.allocations);
});

it('empurra uma parcela manual afetada para o próximo mês viável e preserva o trabalho total', () => {
  const source = project([
    task('s', { duration: 19 }),
    task('affected', { duration: 7, dependencies: ['s'] }),
  ]);
  const plans = new Map([
    ['s', { balance: 5, allocations: { '2027-01': 5 } }],
    ['affected', { balance: 10, allocations: { '2027-01': 10 } }],
  ]);
  const next = rescheduleMonthlyGraph(source, plans, 's', '2026-11-16');
  const row = getAllTasks(next.project).find(item => item.id === 'affected');
  expect(row?.startDate).toBe('2027-02-01');
  expect(row?.duration).toBe(7);
  expect(next.allocations.get('affected')).toEqual({ '2027-02': 10 });
});
