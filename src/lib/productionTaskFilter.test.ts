import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@/types/project';
import { filterProductionTasks } from './productionTaskFilter';

const task = (id: string, name: string, percentComplete: number, team?: Task['team']): Task => ({
  id, name, phase: 'child', startDate: '2026-09-01', duration: 2, dependencies: [],
  responsible: '', percentComplete, materials: [], level: 0, quantity: 10, unit: 'un', team,
});
const project = {
  id: 'p', name: 'Obra', startDate: '2026-09-01', endDate: '2026-12-31', totalBudget: 0,
  phases: [
    { id: 'root', name: 'Incêndio', tasks: [], order: 0 },
    { id: 'child', parentId: 'root', name: 'Hidrantes', tasks: [task('a', 'Instalar bomba', 50, 'A'), task('b', 'Instalar tubo', 100, 'B')], order: 1 },
  ],
} as Project;

describe('filtro local da Produção', () => {
  it('encontra uma tarefa e revela seus capítulos sem modificar a obra', () => {
    const original = JSON.stringify(project);
    const result = filterProductionTasks(project, 'bomba', 'all', '', '2026-09-30');
    expect([...result.taskIds]).toEqual(['a']);
    expect([...result.phaseIds]).toEqual(['root', 'child']);
    expect(JSON.stringify(project)).toBe(original);
  });

  it('combina equipe e situação e não mostra tarefa concluída como atrasada', () => {
    const result = filterProductionTasks(project, '', 'delayed', 'A', '2026-09-30');
    expect([...result.taskIds]).toEqual(['a']);
    expect(filterProductionTasks(project, '', 'delayed', 'B', '2026-09-30').count).toBe(0);
  });
});
