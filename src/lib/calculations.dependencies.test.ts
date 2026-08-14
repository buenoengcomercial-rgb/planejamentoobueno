import { describe, expect, it } from 'vitest';
import type { DependencyType, Task } from '@/types/project';
import {
  dependencyRequiredStart,
  recalculateTaskAndSuccessors,
  wouldCreateDependencyCycle,
} from './calculations';
import { toISODateLocal } from '@/components/gantt/utils';

const weekdayCalendar = {
  uf: 'RO',
  municipio: 'Porto Velho',
  trabalhaSabado: false,
  jornadaDiaria: 8,
};

function task(id: string, startDate: string, duration = 1): Task {
  return {
    id,
    name: id,
    phase: 'phase-1',
    startDate,
    duration,
    dependencies: [],
    responsible: '',
    percentComplete: 0,
    materials: [],
    level: 0,
  };
}

function withDependency(successor: Task, predecessor: Task, type: DependencyType): Task {
  return {
    ...successor,
    dependencies: [predecessor.id],
    dependencyDetails: [{ taskId: predecessor.id, type }],
  };
}

describe('dependency date engine', () => {
  it('aplica TI no sábado quando habilitado e na segunda quando desabilitado', () => {
    const predecessor = task('a', '2026-08-14');
    const successor = withDependency(task('b', '2026-07-10'), predecessor, 'TI');

    const saturdayResult = recalculateTaskAndSuccessors(
      [predecessor, successor],
      successor.id,
      { ...weekdayCalendar, trabalhaSabado: true },
    );
    const weekdayResult = recalculateTaskAndSuccessors(
      [predecessor, successor],
      successor.id,
      weekdayCalendar,
    );

    expect(saturdayResult.tasks.find(item => item.id === 'b')?.startDate).toBe('2026-08-15');
    expect(weekdayResult.tasks.find(item => item.id === 'b')?.startDate).toBe('2026-08-17');
  });

  it.each([
    ['II', '2026-08-14'],
    ['TT', '2026-08-17'],
    ['IT', '2026-08-13'],
  ] as const)('alinha %s sem defasagem', (type, expectedStart) => {
    const predecessor = task('a', '2026-08-14', 3);
    const successor = task('b', '2026-07-10', 2);

    expect(toISODateLocal(dependencyRequiredStart(predecessor, successor, type, weekdayCalendar)))
      .toBe(expectedStart);
  });

  it('recalcula a tarefa editada antes de percorrer uma cadeia de três tarefas', () => {
    const a = task('a', '2026-08-14');
    const b = withDependency(task('b', '2026-07-10'), a, 'TI');
    const c = withDependency(task('c', '2026-07-11'), b, 'TI');

    const first = recalculateTaskAndSuccessors([a, b, c], 'b', weekdayCalendar);
    expect(first.tasks.map(item => item.startDate)).toEqual([
      '2026-08-14',
      '2026-08-17',
      '2026-08-18',
    ]);

    const changedType = first.tasks.map(item => item.id === 'b'
      ? withDependency(item, a, 'II')
      : item);
    const second = recalculateTaskAndSuccessors(changedType, 'b', weekdayCalendar);
    expect(second.tasks.map(item => item.startDate)).toEqual([
      '2026-08-14',
      '2026-08-14',
      '2026-08-17',
    ]);
  });

  it('usa a restrição mais tardia entre múltiplas predecessoras', () => {
    const a = task('a', '2026-08-14');
    const b = task('b', '2026-08-18');
    const c = {
      ...task('c', '2026-07-10'),
      dependencies: ['a', 'b'],
      dependencyDetails: [
        { taskId: 'a', type: 'TI' as const },
        { taskId: 'b', type: 'II' as const },
        { taskId: 'a', type: 'TT' as const },
        { taskId: 'c', type: 'TI' as const },
        { taskId: 'missing', type: 'TI' as const },
      ],
    };

    const result = recalculateTaskAndSuccessors([a, b, c], 'c', weekdayCalendar);
    expect(result.tasks.find(item => item.id === 'c')?.startDate).toBe('2026-08-18');
  });

  it('detecta ciclos e mantém a propagação finita quando recebe um grafo cíclico legado', () => {
    const a = withDependency(task('a', '2026-08-10'), task('c', '2026-08-12'), 'TI');
    const b = withDependency(task('b', '2026-08-11'), a, 'TI');
    const c = withDependency(task('c', '2026-08-12'), b, 'TI');
    const tasks = [a, b, c];

    expect(wouldCreateDependencyCycle(tasks, 'c', 'b')).toBe(true);
    const result = recalculateTaskAndSuccessors(tasks, 'a', weekdayCalendar);
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.every(item => /^2026-\d{2}-\d{2}$/.test(item.startDate))).toBe(true);
  });
});
