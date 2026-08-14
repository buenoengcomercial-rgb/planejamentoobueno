import { describe, expect, it } from 'vitest';
import type { Project, SavedMeasurement } from '@/types/project';
import { getWorkStartDate } from './workStartDate';

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
  });

  it('usa o início atual do Gantt como fallback sem alterar o projeto', () => {
    const input = project();
    expect(getWorkStartDate(input, '2026-07-15')).toBe('2026-07-15');
    expect(input).toEqual(project());
  });
});
