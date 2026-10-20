import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@/types/project';
import { useCalculatedProject } from './useCalculatedProject';

const task = {
  id: 'task-1',
  name: 'Serviço',
  startDate: '2026-10-20',
  duration: 2,
  percentComplete: 0,
  dependencies: [],
} as Task;

const project = {
  id: 'project-1',
  name: 'Obra',
  startDate: '2026-10-20',
  endDate: '2026-12-20',
  totalBudget: 0,
  phases: [{ id: 'phase-1', name: 'Etapa', tasks: [task] }],
} as Project;

describe('cálculo delimitado ao Cronograma', () => {
  it('preserva as tarefas calculadas quando só o Almoxarifado muda', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useCalculatedProject(value, true),
      { initialProps: { value: project } },
    );
    const calculatedPhases = result.current?.phases;

    rerender({ value: { ...project, warehouse: { movements: [] } } as Project });

    expect(result.current?.phases).toBe(calculatedPhases);
    expect(result.current?.warehouse).toEqual({ movements: [] });
  });

  it('recalcula quando o quantitativo da tarefa muda', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useCalculatedProject(value, false),
      { initialProps: { value: project } },
    );
    const calculatedPhases = result.current?.phases;
    rerender({ value: {
      ...project,
      phases: [{ ...project.phases[0], tasks: [{ ...task, quantity: 10 }] }],
    } });
    expect(result.current?.phases).not.toBe(calculatedPhases);
  });
});
