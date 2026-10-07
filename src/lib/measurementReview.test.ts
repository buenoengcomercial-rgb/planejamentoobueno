import { describe, expect, it } from 'vitest';
import type { DailyReportSnapshotData, MeasurementSnapshotItem, Project } from '@/types/project';
import { submitMeasurementForReview } from './measurementReview';

describe('submitMeasurementForReview', () => {
  it('congela a quantidade atual e o status em uma única versão do projeto', () => {
    const originalItem = { taskId: 'task-1', qtyProposed: 2 };
    const currentItem = { taskId: 'task-1', qtyProposed: 5 };
    const report = { startDate: '2026-09-01', endDate: '2026-09-30', totalDays: 30 };
    const project = {
      id: 'project-1',
      phases: [{ id: 'phase-1', tasks: [{ id: 'task-1', dailyLogs: [{ date: '2026-09-20', actualQuantity: 5 }] }] }],
      measurements: [
        { id: 'meas-1', number: 1, status: 'generated', items: [originalItem] },
        { id: 'meas-0', number: 0, status: 'approved', items: [] },
      ],
    } as unknown as Project;

    const result = submitMeasurementForReview(
      project,
      'meas-1',
      [currentItem] as MeasurementSnapshotItem[],
      report as DailyReportSnapshotData,
      { userId: 'user-1' },
    );

    expect(result.measurements?.[0]).toMatchObject({
      status: 'in_review', items: [currentItem], dailyReportSnapshot: report,
      history: [{ field: 'status', previous: 'generated', next: 'in_review' }],
    });
    expect(result.measurements?.[1]).toBe(project.measurements?.[1]);
    expect(result.phases).toBe(project.phases);
    expect(result.auditLogs).toHaveLength(1);
    expect(result.auditLogs?.[0]).toMatchObject({ action: 'submitted_for_review', entityId: 'meas-1' });
  });

  it('não altera uma medição já enviada', () => {
    const project = { measurements: [{ id: 'meas-1', status: 'in_review', items: [] }] } as unknown as Project;
    expect(submitMeasurementForReview(project, 'meas-1', [], {} as never, {})).toBe(project);
  });
});
