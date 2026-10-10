import { isPeriodLocked, transactMeasurement, type MeasurementActor, type MeasurementAudit, type MeasurementWorkspace, type MeasuredPeriod } from './measurementWorkspace';
import { nextMeasurementPeriod } from './measurementPeriodSequence';

function authorize(actor: MeasurementActor, reason: string) {
  if (!actor.canEdit || !actor.id) throw new Error('Seu perfil não permite editar a Medição.');
  if (reason.trim().length < 3) throw new Error('Informe o motivo da operação.');
}
export function periodDeletionBlock(w: MeasurementWorkspace, p: MeasuredPeriod): string | null {
  if (p.number === Math.min(...w.periods.map(p => p.number))) return 'A primeira medição deve ser preservada. Corrija os detalhes enquanto estiver em análise.';
  if (w.periods.some(other => other.number > p.number)) return 'Exclua primeiro a última medição para manter a sequência.';
  if (isPeriodLocked(p)) return 'Medição aprovada ou bloqueada: exclusão indisponível.';
  if (p.originalSnapshot) return 'Medição incorporada do histórico: preserve o período e corrija os detalhes antes da aprovação.';
  return null;
}
function finish(before: MeasurementWorkspace, next: MeasurementWorkspace, actor: MeasurementActor, lifecycle: NonNullable<MeasurementAudit['lifecycle']>, action: string) {
  const oldEntries = before.entries.filter(e => e.measurementId === lifecycle.measurementId);
  const newEntries = next.entries.filter(e => e.measurementId === lifecycle.measurementId);
  next.revision = before.revision + 1;
  next.audit.push({ id: crypto.randomUUID(), at: new Date().toISOString(), actor: { id: actor.id, name: actor.name }, action,
    lifecycle, affected: [...oldEntries, ...newEntries].filter((e, i, all) => all.findIndex(x => x.serviceId === e.serviceId) === i).map(e => ({ measurementId: e.measurementId, serviceId: e.serviceId })),
    before: structuredClone(oldEntries), after: structuredClone(newEntries),
    beforePeriods: structuredClone(before.periods), afterPeriods: structuredClone(next.periods) });
  return next;
}
export function deleteMeasuredPeriod(w: MeasurementWorkspace, actor: MeasurementActor, id: string, reason: string) {
  authorize(actor, reason);
  const period = w.periods.find(p => p.id === id); if (!period) throw new Error('Medição não encontrada.');
  const blocked = periodDeletionBlock(w, period); if (blocked) throw new Error(blocked);
  const next = structuredClone(w);
  next.periods = next.periods.filter(p => p.id !== id); next.entries = next.entries.filter(e => e.measurementId !== id);
  // Plans/files and their points remain untouched; archived entries retain their links.
  return finish(w, next, actor, { kind: 'delete', measurementId: id, reason: reason.trim() }, 'Excluir medição (recuperável)');
}
export function restoreMeasuredPeriod(w: MeasurementWorkspace, actor: MeasurementActor, auditId: string, reason: string) {
  authorize(actor, reason);
  const source = w.audit.find(a => a.id === auditId);
  if (source?.lifecycle?.kind !== 'delete') throw new Error('Exclusão não encontrada no histórico.');
  const id = source.lifecycle.measurementId, period = source.beforePeriods?.find(p => p.id === id);
  const latest = [...w.audit].reverse().find(a => a.lifecycle?.measurementId === id);
  const dates = nextMeasurementPeriod(w.periods);
  if (!period || latest?.id !== auditId || w.periods.some(p => p.id === id) || !dates || dates.number !== period.number || dates.startDate !== period.startDate || dates.endDate !== period.endDate) throw new Error('Restauração conflita com a sequência atual. Exclua primeiro a medição que ocupa esse período.');
  const next = structuredClone(w); next.periods.push(structuredClone(period)); next.entries.push(...structuredClone(source.before));
  // Validate restored quantities against the current contract and locked occurrences.
  // This candidate is only a validation probe; the lifecycle event is the sole write.
  transactMeasurement({ ...w, periods: next.periods }, actor, 'Validar restauração', draft => { draft.entries = next.entries; });
  return finish(w, next, actor, { kind: 'restore', measurementId: id, reason: reason.trim(), sourceAuditId: auditId }, 'Restaurar medição excluída');
}
