import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@/types/project';
import { applyDailyLogsToProject, captureBaseline, syncBaselineWithRup } from './calculations';

function projectWithTask(task: Task): Project {
  return {
    id: 'project-1',
    name: 'Obra de teste',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    totalBudget: 0,
    phases: [{ id: 'phase-1', name: 'Fase', color: '', tasks: [task] }],
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Atividade',
    phase: 'Fase',
    startDate: '2026-10-01',
    duration: 3,
    dependencies: [],
    responsible: '',
    percentComplete: 0,
    materials: [],
    level: 0,
    ...overrides,
  };
}

describe('baseline date safety', () => {
  it('captures a valid baseline using a local calendar date', () => {
    const result = captureBaseline(projectWithTask(task()));

    expect(result.phases[0].tasks[0].baseline).toMatchObject({
      startDate: '2026-10-01',
      duration: 3,
      endDate: '2026-10-03',
    });
  });

  it.each(['', 'data-invalida', '2026-02-31'])(
    'keeps a task without baseline when its start date is invalid: %s',
    startDate => {
      const original = task({ startDate });
      const result = captureBaseline(projectWithTask(original));

      expect(result.phases[0].tasks[0]).toEqual(original);
      expect(() => applyDailyLogsToProject(projectWithTask(original))).not.toThrow();
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0])(
    'keeps a task without baseline when its duration is invalid: %s',
    duration => {
      const original = task({ duration });
      const result = captureBaseline(projectWithTask(original));

      expect(result.phases[0].tasks[0]).toEqual(original);
    },
  );

  it('does not rewrite a RUP baseline whose captured start date is invalid', () => {
    const original = task({
      durationMode: 'rup',
      quantity: 8,
      laborCompositions: [{ id: 'labor-1', role: 'Equipe', rup: 1, workerCount: 1 }],
      baseline: {
        startDate: '',
        duration: 2,
        endDate: '',
        capturedAt: '2026-10-01T00:00:00.000Z',
      },
    });

    expect(syncBaselineWithRup(projectWithTask(original)).phases[0].tasks[0]).toEqual(original);
  });
});