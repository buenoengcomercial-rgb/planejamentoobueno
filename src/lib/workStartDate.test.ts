import { describe, expect, it } from 'vitest';
import type { Project, SavedMeasurement } from '@/types/project';
import { getWorkStartDate, synchronizeProjectScheduleToWorkStart } from './workStartDate';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Obra',
    startDate: '2026-07-01',
    endDate: '2026-12-31',
    phases: [],
    totalBudget: 0,
    ...overrides,
  };
}

function measurement(number: number, startDate: string): SavedMeasurement {
  return {
    id: `measurement-${number}`,
    number,
    startDate,
    endDate: startDate,
    issueDate: startDate,
    status: 'draft',
    bdiPercent: 0,
    items: [],
  };
}

describe('getWorkStartDate', () => {
  it('prioriza a data inicial da medição salva de menor número', () => {
    const value = getWorkStartDate(project({
      measurements: [measurement(2, '2026-09-01'), measurement(1, '2026-08-24')],
      measurementDraft: { number: 3, startDate: '2026-10-01' },
    }), '2026-07-15');

    expect(value).toBe('2026-08-24');
  });

  it('usa o rascunho da primeira medição enquanto não há medição salva', () => {
    expect(getWorkStartDate(project({
      measurementDraft: { number: 1, startDate: '2026-08-24' },
    }), '2026-07-15')).toBe('2026-08-24');
    expect(getWorkStartDate(project({
      measurementDraft: { number: 2, startDate: '2026-09-23' },
    }), '2026-07-15')).toBe('2026-07-15');
  });

  it('usa o início atual do Gantt como fallback sem alterar o projeto', () => {
    const input = project();
    expect(getWorkStartDate(input, '2026-07-15')).toBe('2026-07-15');
    expect(input).toEqual(project());
  });

  it('desloca todo o cronograma quando a primeira medição define o início da obra', () => {
    const input = project({
      startDate: '2026-07-31',
      measurementDraft: { number: 1, startDate: '2026-08-24', endDate: '2026-09-22' },
      phases: [{
        id: 'phase-1', name: 'Capítulo', color: '#000', tasks: [{
          id: 'a', name: 'A', phase: 'phase-1', startDate: '2026-07-31', duration: 2,
          dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0,
          baseline: { startDate: '2026-07-31', endDate: '2026-08-01', duration: 2, capturedAt: '2026-07-01' },
          current: { startDate: '2026-07-31', endDate: '2026-08-01', duration: 2 },
        }, {
          id: 'b', name: 'B', phase: 'phase-1', startDate: '2026-08-14', duration: 1,
          dependencies: ['a'], dependencyDetails: [{ taskId: 'a', type: 'TI' }],
          responsible: '', percentComplete: 0, materials: [], level: 0,
        }],
      }],
      additives: [{
        id: 'add-1', name: 'Aditivo', importedAt: '2026-08-01', compositions: [],
        scheduleDraft: {
          version: 1, createdAt: '2026-08-01', updatedAt: '2026-08-01', dependentTaskIds: [],
          plannedTasks: [{
            compositionId: 'new-1', taskId: 'new-task', phaseId: 'phase-1', name: 'Novo',
            startDate: '2026-07-31', duration: 1, dependencies: [], responsible: '',
          }],
          contractedTaskPlans: [{
            taskId: 'a', startDate: '2026-08-05', duration: 2, dependencies: [], responsible: '',
          }],
        },
      }],
    });

    const shifted = synchronizeProjectScheduleToWorkStart(input);
    expect(shifted.phases[0].tasks.map(task => task.startDate)).toEqual(['2026-08-24', '2026-09-07']);
    expect(shifted.phases[0].tasks[0]).toMatchObject({
      duration: 2,
      baseline: { startDate: '2026-08-24', endDate: '2026-08-25' },
      current: { startDate: '2026-08-24', endDate: '2026-08-25' },
    });
    expect(shifted.phases[0].tasks[1].dependencyDetails).toEqual([{ taskId: 'a', type: 'TI' }]);
    expect(shifted.additives?.[0].scheduleDraft?.plannedTasks[0].startDate).toBe('2026-08-24');
    expect(shifted.additives?.[0].scheduleDraft?.contractedTaskPlans?.[0].startDate).toBe('2026-08-29');
    expect(shifted.uiState?.ganttWorkStartDateApplied).toBe('2026-08-24');
    expect(synchronizeProjectScheduleToWorkStart(shifted)).toBe(shifted);

    const movedAgain = synchronizeProjectScheduleToWorkStart({
      ...shifted,
      measurementDraft: { ...shifted.measurementDraft!, startDate: '2026-08-25' },
    });
    expect(movedAgain.phases[0].tasks[0].startDate).toBe('2026-08-25');
    expect(movedAgain.phases[0].tasks[1].startDate).toBe('2026-09-08');
  });
});
