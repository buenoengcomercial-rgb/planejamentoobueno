import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@/types/project';
import { calculateCPM, checkDependencyViolation, recalculateTaskAndSuccessors } from './calculations';
import { formatDependencyNumber, parseDependencyNumbers } from './dependencyLag';

const task = (id: string, duration: number): Task => ({ id, name: id, phase: 'p',
  startDate: '2026-12-24', duration, dependencies: [], responsible: '', materials: [], percentComplete: 0, level: 0 });
const cal = { uf: 'RO', municipio: 'Porto Velho', trabalhaSabado: false, jornadaDiaria: 8 };

describe('defasagens em dias úteis', () => {
  it('mantém sinais na edição das predecessoras e rejeita tokens malformados', () => {
    expect(parseDependencyNumbers('12, 15+3, 20-2, 3abc')).toEqual([{ number: 12 }, { number: 15, lag: 3 }, { number: 20, lag: -2 }]);
    expect(formatDependencyNumber(15, { lag: 3 })).toBe('15+3');
  });
  it('propaga II com espera, descontando Natal e fim de semana, e bloqueia antecipação', () => {
    const a = task('a', 10), b = { ...task('b', 3), dependencies: ['a'], dependencyDetails: [{ taskId: 'a', type: 'II' as const, lag: 2 }] };
    const next = recalculateTaskAndSuccessors([a, b], 'b', cal).tasks;
    expect(next[1].startDate).toBe('2026-12-29');
    expect(checkDependencyViolation(b, '2026-12-28', [a, b], cal)?.predId).toBe('a');
    expect(checkDependencyViolation(b, '2026-12-29', [a, b], cal)).toBeNull();
    expect(b.startDate).toBe('2026-12-24');
  });
  it('aceita antecipação TI sem contar dias não úteis', () => {
    const a = task('a', 2), b = { ...task('b', 1), dependencies: ['a'], dependencyDetails: [{ taskId: 'a', type: 'TI' as const, lag: -1 }] };
    expect(recalculateTaskAndSuccessors([a, b], 'b', cal).tasks[1].startDate).toBe('2026-12-28');
  });
  it.each([['TI', 12], ['II', 2], ['TT', 8], ['IT', 0]] as const)('calcula CPM de %s com defasagem', (type, expected) => {
    const a = task('a', 10), b = { ...task('b', 4), dependencies: ['a'], dependencyDetails: [{ taskId: 'a', type, lag: 2 }] };
    const project = { id: 'work', name: 'work', phases: [{ id: 'p', name: 'p', color: '#000', tasks: [a, b] }] } as Project;
    const next = calculateCPM(project);
    expect(next.phases[0].tasks[1].es).toBe(expected);
    expect(next.phases[0].tasks.every(t => t.float! >= 0)).toBe(true);
    expect(project.phases[0].tasks[0].es).toBeUndefined();
  });
  it('calcula folga do ramo II sem convertê-lo em TI', () => {
    const a = task('a', 10), b = { ...task('b', 4), dependencies: ['a'], dependencyDetails: [{ taskId: 'a', type: 'II' as const, lag: 2 }] };
    const next = calculateCPM({ id: 'work', phases: [{ id: 'p', tasks: [a, b] }] } as Project).phases[0].tasks;
    expect(next.map(t => [t.es, t.ef, t.ls, t.lf, t.float, t.isCritical])).toEqual([[0, 10, 0, 10, 0, true], [2, 6, 6, 10, 4, false]]);
  });
});


it('preserves the approved remaining-work release while still delaying for predecessors', async () => {
  const { settleAllDependencies } = await import('./calculations');
  const pred = { id: 'p', name: 'P', startDate: '2026-11-13', duration: 1, dependencies: [] };
  const successor = { id: 's', name: 'S', startDate: '2026-12-01', duration: 1, dependencies: ['p'],
    operationalReschedule: { startDate: '2026-12-01' } };
  const project = { id: 'release', phases: [{ id: 'c', tasks: [pred, successor] }] } as unknown as import('@/types/project').Project;
  expect(settleAllDependencies(project).phases[0].tasks[1].startDate).toBe('2026-12-01');
  pred.startDate = '2026-12-10';
  expect(settleAllDependencies(project).phases[0].tasks[1].startDate).toBe('2026-12-11');
});
