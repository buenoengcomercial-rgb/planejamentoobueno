import type { DailyProductionLog, Project } from '@/types/project';

export interface ProductionMeasurementPeriod {
  key: string; number: number; startDate: string; endDate: string; measurementId?: string; blockedReason?: string;
}
const validDate = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};
export function productionMeasurementPeriods(project: Pick<Project, 'measurements' | 'measurementDraft'>): ProductionMeasurementPeriod[] {
  const periods: ProductionMeasurementPeriod[] = (project.measurements ?? []).map(m => ({
    key: m.id, number: m.number, startDate: m.startDate, endDate: m.endDate, measurementId: m.id,
    ...(['in_review', 'approved'].includes(m.status) || (m.status === 'rejected' && !m.editUnlocked)
      ? { blockedReason: m.status === 'approved' ? 'Medição aprovada: quantitativos somente para consulta.' : 'Medição em fiscalização: quantitativos somente para consulta.' } : {}),
  }));
  const draft = project.measurementDraft;
  if (draft?.startDate && draft.endDate && !periods.some(p => p.number === draft.number)) periods.push({ key: `draft-${draft.number}`, number: draft.number, startDate: draft.startDate, endDate: draft.endDate });
  for (const p of periods) {
    if (!Number.isInteger(p.number) || !(p.number > 0) || !validDate(p.startDate) || !validDate(p.endDate) || p.startDate > p.endDate) p.blockedReason = 'Defina um número e um período válido na aba Medição.';
    else if (periods.some(other => other !== p && (other.number === p.number || (other.startDate <= p.endDate && p.startDate <= other.endDate)))) p.blockedReason ??= 'Este período se sobrepõe a outra medição. Corrija as datas na aba Medição.';
  }
  return periods.sort((a, b) => a.number - b.number);
}
export function newMeasurementProductionRecord(period: ProductionMeasurementPeriod): DailyProductionLog {
  return { id: crypto.randomUUID(), date: '', plannedQuantity: 0, actualQuantity: 0, quantityDetails: [], quantityDetailsAppliedTotal: 0,
    measurementPeriod: { number: period.number, startDate: period.startDate, endDate: period.endDate, ...(period.measurementId ? { measurementId: period.measurementId } : {}) } };
}
export function recordInMeasurement(log: DailyProductionLog, period: ProductionMeasurementPeriod): boolean {
  return log.measurementPeriod?.measurementId ? log.measurementPeriod.measurementId === period.measurementId : log.measurementPeriod?.number === period.number;
}
export function productionRecordBlock(project: Pick<Project, 'measurements' | 'measurementDraft'>, log: DailyProductionLog): string | undefined {
  const periods = productionMeasurementPeriods(project);
  if (!log.measurementPeriod) return periods.find(p => log.date && log.date >= p.startDate && log.date <= p.endDate && p.blockedReason)?.blockedReason;
  const period = periods.find(p => recordInMeasurement(log, p));
  return period ? period.blockedReason : 'O período deste quantitativo não está cadastrado na aba Medição. O registro foi preservado.';
}
/** Period ownership takes precedence over dates; legacy daily records keep their original date. */
export function quantityForMeasurement(logs: DailyProductionLog[], start: string, end: string, number: number, measurementId?: string) {
  let prior = 0; let period = 0; let hasLogsInPeriod = false;
  for (const log of logs) {
    const qty = log.actualQuantity || 0;
    if (log.measurementPeriod) {
      const belongs = log.measurementPeriod.measurementId ? log.measurementPeriod.measurementId === measurementId : log.measurementPeriod.number === number;
      if (belongs) { period += qty; hasLogsInPeriod ||= qty > 0; }
      else if (log.measurementPeriod.number < number) prior += qty;
    } else if (log.date && log.date < start) prior += qty;
    else if (log.date && log.date >= start && log.date <= end) { period += qty; hasLogsInPeriod ||= qty > 0; }
  }
  return { prior, period, hasLogsInPeriod };
}
