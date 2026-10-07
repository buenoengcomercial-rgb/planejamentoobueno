import type { DailyReportSnapshotData, MeasurementSnapshotItem, Project } from '@/types/project';
import { logToProject, type AuditUserInfo } from '@/lib/audit';

/** Congela quantidades e status da medição na mesma alteração do projeto. */
export function submitMeasurementForReview(
  project: Project,
  measurementId: string,
  items: MeasurementSnapshotItem[],
  dailyReportSnapshot: DailyReportSnapshotData,
  auditUser: AuditUserInfo,
): Project {
  const current = project.measurements?.find(measurement => measurement.id === measurementId);
  if (!current || current.status !== 'generated') return project;

  const nextMeasurement = {
    ...current,
    items,
    dailyReportSnapshot,
    status: 'in_review' as const,
    editUnlocked: false,
    history: [
      ...(current.history || []),
      { at: new Date().toISOString(), field: 'status', previous: current.status, next: 'in_review' },
    ],
  };
  return logToProject({
    ...project,
    measurements: project.measurements!.map(measurement =>
      measurement.id === measurementId ? nextMeasurement : measurement),
  }, {
    ...auditUser,
    entityType: 'measurement',
    entityId: measurementId,
    action: 'submitted_for_review',
    title: 'Medição enviada para análise fiscal',
    metadata: {
      number: current.number,
      previousStatus: current.status,
      nextStatus: 'in_review',
    },
  });
}
