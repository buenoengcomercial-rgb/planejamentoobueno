import { describe, expect, it } from 'vitest';
import { subcontractExecutedQuantity } from '@/lib/subcontracts';
import type { Project } from '@/types/project';

describe('subcontractExecutedQuantity', () => {
  it('soma apenas os apontamentos físicos da composição terceirizada', () => {
    const project = {
      phases: [{ tasks: [{ dailyLogs: [
        { id: 'd1', date: '2026-08-22', plannedQuantity: 0, actualQuantity: 0, subcontractExecutions: [{ allocationId: 'a', compositionId: 'c1', quantity: 12.5 }] },
        { id: 'd2', date: '2026-08-23', plannedQuantity: 0, actualQuantity: 0, subcontractExecutions: [{ allocationId: 'a', compositionId: 'c1', quantity: 7.5 }, { allocationId: 'b', compositionId: 'c2', quantity: 9 }] },
      ] }] }],
    } as Project;

    expect(subcontractExecutedQuantity(project, 'a')).toBe(20);
    expect(subcontractExecutedQuantity(project, 'b')).toBe(9);
  });
});
