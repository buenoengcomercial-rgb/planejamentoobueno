import type { ProductionQuantityDetail, MeasurementStatus, SavedMeasurement, ContractInfo } from '@/types/project';
import type { TakeoffPlan, TakeoffMeasure } from './planTakeoff';
import { measureUnit, quantity } from './planTakeoff';
import { detailTotal, withDetailValue, type DetailField } from './productionQuantityDetails';
import { calculateMeasurementLine } from './measurementCalculations';
import { calculateLineTotal, money2, sumMoney } from './financialEngine';

/** This aggregate is deliberately outside Project and its global autosave/undo. */
export interface MeasuredService {
  id: string; item: string; description: string; unit: string; contracted: number;
  code?: string; bank?: string;
  priceNoBDI: number; priceWithBDI: number; bdi: number; importedPrice: boolean;
  chapterId: string; chapter: string; path: string; sourceTaskId?: string; sourceBudgetId?: string;
  additiveId?: string; additiveVersion?: number; availableFromNumber: number;
}
export interface MeasuredRow extends ProductionQuantityDetail {
  origin?: { logId?: string; date?: string; kind: 'daily' | 'period' | 'snapshot' | 'manual'; originalRowId?: string };
}
export interface MeasuredEntry { projectId: string; measurementId: string; serviceId: string; rows: MeasuredRow[] }
export interface MeasuredPeriod {
  id: string; number: number; startDate: string; endDate: string; status: MeasurementStatus; editUnlocked?: boolean;
  originalSnapshot?: SavedMeasurement; frozen?: MonthlyLine[];
}
export interface MonthlyLine {
  service: MeasuredService; qty: number; prior: number; accumulated: number; balance: number;
  financial: ReturnType<typeof calculateMeasurementLine>;
}
export interface MeasurementAudit {
  id: string; at: string; actor: { id: string; name: string }; action: string;
  affected: { measurementId: string; serviceId: string }[];
  before: MeasuredEntry[]; after: MeasuredEntry[];
  beforePlans?: TakeoffPlan[]; afterPlans?: TakeoffPlan[];
  beforePeriods?: MeasuredPeriod[]; afterPeriods?: MeasuredPeriod[];
  beforeServices?: MeasuredService[]; afterServices?: MeasuredService[];
}
export interface MeasurementWorkspace {
  schema: 1; projectId: string; projectName: string; revision: number;
  contract?: ContractInfo; services: MeasuredService[]; periods: MeasuredPeriod[];
  entries: MeasuredEntry[]; plans: TakeoffPlan[]; audit: MeasurementAudit[];
  importedKeys: string[]; backupId: string;
}
export interface MeasurementActor { id: string; name: string; canEdit: boolean; canReview?: boolean }
export const measurementStatusLabels: Record<MeasurementStatus, string> = { draft: 'Rascunho', generated: 'Em preenchimento', in_review: 'Em análise fiscal', approved: 'Aprovada', rejected: 'Em revisão' };
export interface Destination { measurementId: string; serviceId: string; rowId: string; field: DetailField }
export interface MeasurementClipboard {
  mode: 'copy' | 'cut' | 'reference'; projectId: string; unit: string;
  source: { measurementId: string; serviceId: string; rowId: string }; snapshot: MeasuredRow;
}
export const sourceFields = ['multiplierSource', 'source', 'dimensionCSource', 'dimensionDSource'] as const;
export const sourceField = (field: DetailField) => sourceFields[['multiplier', 'measuredQuantity', 'dimensionC', 'dimensionD'].indexOf(field)];
const json = (value: unknown) => JSON.stringify(value);
export const isPeriodLocked = (p: MeasuredPeriod) => p.status === 'in_review' || p.status === 'approved' || p.status === 'rejected' && !p.editUnlocked;
export const entryFor = (w: MeasurementWorkspace, measurementId: string, serviceId: string): MeasuredEntry =>
  w.entries.find(e => e.measurementId === measurementId && e.serviceId === serviceId) ?? { projectId: w.projectId, measurementId, serviceId, rows: [] };
export const newMeasuredRow = (id: string = crypto.randomUUID()): MeasuredRow => ({ id, comment: '', location: '', formula: 'STANDARD', multiplier: 0, measuredQuantity: 0, dimensionC: 0, dimensionD: 0 });
export const entryQuantity = (w: MeasurementWorkspace, measurementId: string, serviceId: string) => detailTotal(entryFor(w, measurementId, serviceId).rows);

export function monthlyLines(w: MeasurementWorkspace, measurementId: string): MonthlyLine[] {
  const period = w.periods.find(p => p.id === measurementId);
  if (!period) throw new Error('Medição não encontrada.');
  if (period.frozen) return structuredClone(period.frozen);
  return w.services.filter(s => s.availableFromNumber <= period.number).map(service => {
    const qty = entryQuantity(w, measurementId, service.id);
    const prior = w.periods.filter(p => p.number < period.number).reduce((sum, p) => sum + (p.frozen?.find(l => l.service.id === service.id)?.qty ?? entryQuantity(w, p.id, service.id)), 0);
    const financial = calculateMeasurementLine({ quantityContracted: service.contracted, quantityPeriod: qty, quantityPriorAccum: prior, unitPriceNoBDI: service.priceNoBDI, bdiPercent: service.bdi });
    // Imported contractual prices/totals follow the existing synthetic-budget branch.
    if (service.importedPrice) {
      financial.totalContracted = calculateLineTotal(service.priceWithBDI, service.contracted);
      financial.totalContractedNoBDI = calculateLineTotal(service.priceNoBDI, service.contracted);
      financial.totalBalance = Math.max(0, money2(financial.totalContracted - financial.totalAccumulated));
      financial.totalBalanceNoBDI = Math.max(0, money2(financial.totalContractedNoBDI - financial.totalAccumulatedNoBDI));
    }
    return { service, qty, prior, accumulated: financial.quantityCurrentAccum, balance: financial.quantityBalance, financial };
  });
}
export const monthlyTotal = (w: MeasurementWorkspace, id: string) => sumMoney(monthlyLines(w, id).map(l => l.financial.totalPeriod));

function assertDestination(w: MeasurementWorkspace, mid: string, sid: string, actor: MeasurementActor) {
  if (!actor.canEdit || !actor.id) throw new Error('Seu perfil não permite editar a Medição.');
  const p = w.periods.find(p => p.id === mid); const s = w.services.find(s => s.id === sid);
  if (!p || !s || s.availableFromNumber > p.number) throw new Error('Serviço indisponível nesta medição.');
  if (isPeriodLocked(p)) throw new Error(`${p.number}ª medição · ${s.description}: período bloqueado pela fiscalização.`);
}
function putEntry(w: MeasurementWorkspace, entry: MeasuredEntry) {
  const index = w.entries.findIndex(e => e.measurementId === entry.measurementId && e.serviceId === entry.serviceId);
  if (index < 0) w.entries.push(entry); else w.entries[index] = entry;
}

/** Every mutation is validated on a detached candidate before any persistence. */
export function transactMeasurement(before: MeasurementWorkspace, actor: MeasurementActor, action: string, edit: (draft: MeasurementWorkspace) => void): MeasurementWorkspace {
  if (!actor.canEdit || !actor.id) throw new Error('Seu perfil não permite editar a Medição.');
  const next = structuredClone(before); edit(next);
  if (next.projectId !== before.projectId) throw new Error('Vínculo da obra não pode ser alterado.');
  const affected = next.entries.filter(e => json(e) !== json(entryFor(before, e.measurementId, e.serviceId)));
  if (before.entries.some(e => !next.entries.some(n => e.measurementId === n.measurementId && e.serviceId === n.serviceId))) throw new Error('Exclusão implícita de lançamento bloqueada.');
  for (const e of affected) {
    assertDestination(next, e.measurementId, e.serviceId, actor);
    if (e.projectId !== next.projectId) throw new Error('Lançamento pertence a outra obra.');
    for (const r of e.rows) for (const f of ['multiplier', 'measuredQuantity', 'dimensionC', 'dimensionD'] as const) {
      if (!Number.isFinite(r[f] ?? 0) || (r[f] ?? 0) < 0) throw new Error('Quantidade inválida.');
    }
    const s = next.services.find(s => s.id === e.serviceId)!;
    const total = next.periods.reduce((sum, p) => sum + entryQuantity(next, p.id, s.id), 0);
    if (total > s.contracted + 1e-8) throw new Error(`${s.description}: total ${total} excede o contratado de ${s.contracted} ${s.unit}. Operação inteira bloqueada.`);
  }
  for (const p of before.periods.filter(isPeriodLocked)) {
    if (json(p) !== json(next.periods.find(n => n.id === p.id))) throw new Error(`${p.number}ª medição bloqueada: snapshot imutável.`);
  }
  // Prevent indirect changes to points referenced by any locked occurrence.
  for (const e of before.entries.filter(e => isPeriodLocked(before.periods.find(p => p.id === e.measurementId)!))) {
    for (const r of e.rows) for (const f of sourceFields) if (r[f]) {
      const src = r[f]!;
      const oldPlan = before.plans.find(p => p.id === src.planId), newPlan = next.plans.find(p => p.id === src.planId);
      if (json(oldPlan?.measures.find(m => m.id === src.measureId)) !== json(newPlan?.measures.find(m => m.id === src.measureId)) || json(oldPlan?.scales) !== json(newPlan?.scales)) throw new Error('A planta contém referência em uma medição bloqueada.');
    }
  }
  if (json(before) === json(next)) return before;
  next.revision = before.revision + 1;
  next.audit.push({ id: crypto.randomUUID(), at: new Date().toISOString(), actor: { id: actor.id, name: actor.name }, action,
    affected: affected.map(e => ({ measurementId: e.measurementId, serviceId: e.serviceId })),
    before: affected.map(e => structuredClone(entryFor(before, e.measurementId, e.serviceId))), after: structuredClone(affected),
    ...(json(before.plans) !== json(next.plans) ? { beforePlans: before.plans, afterPlans: next.plans } : {}),
    ...(json(before.periods) !== json(next.periods) ? { beforePeriods: before.periods, afterPeriods: structuredClone(next.periods) } : {}),
    ...(json(before.services) !== json(next.services) ? { beforeServices: before.services, afterServices: structuredClone(next.services) } : {}),
  });
  return next;
}
function propagate(w: MeasurementWorkspace, entry: MeasuredEntry, row: MeasuredRow) {
  putEntry(w, { ...entry, rows: entry.rows.some(r => r.id === row.id) ? entry.rows.map(r => r.id === row.id ? row : r) : [...entry.rows, row] });
  if (row.sharedRecordId) {
    const unit = w.services.find(s => s.id === entry.serviceId)!.unit.toLowerCase();
    for (const e of w.entries) e.rows = e.rows.map(r => {
      if (r.sharedRecordId !== row.sharedRecordId) return r;
      if (w.services.find(s => s.id === e.serviceId)!.unit.toLowerCase() !== unit) throw new Error('Referências com unidades incompatíveis.');
      return { ...structuredClone(row), id: r.id, origin: r.origin };
    });
  }
}
export function editMeasuredRow(w: MeasurementWorkspace, actor: MeasurementActor, mid: string, sid: string, row: MeasuredRow) {
  return transactMeasurement(w, actor, 'Editar detalhe', next => propagate(next, entryFor(next, mid, sid), row));
}
export function deleteMeasuredRow(w: MeasurementWorkspace, actor: MeasurementActor, mid: string, sid: string, rid: string) {
  return transactMeasurement(w, actor, 'Excluir linha / desvincular referência', next => {
    const e = entryFor(next, mid, sid); putEntry(next, { ...e, rows: e.rows.filter(r => r.id !== rid) });
    // Markings used elsewhere remain intact. Unreferenced marks are recoverable in the audit.
    const used = new Set(next.entries.flatMap(e => e.rows.flatMap(r => sourceFields.flatMap(f => r[f] ? [r[f]!.measureId] : []))));
    const deleted = e.rows.find(r => r.id === rid);
    const ids = new Set(deleted ? sourceFields.flatMap(f => deleted[f] ? [deleted[f]!.measureId] : []) : []);
    next.plans = next.plans.map(p => ({ ...p, measures: p.measures.filter(m => !ids.has(m.id) || used.has(m.id)) }));
  });
}
export function pasteMeasuredRow(w: MeasurementWorkspace, actor: MeasurementActor, mid: string, sid: string, clip: MeasurementClipboard) {
  return transactMeasurement(w, actor, `Colar ${clip.mode}`, next => {
    if (clip.projectId !== w.projectId) throw new Error('A referência pertence a outra obra.');
    if (next.services.find(s => s.id === sid)?.unit.toLowerCase() !== clip.unit.toLowerCase()) throw new Error('Unidades incompatíveis.');
    const original = entryFor(next, clip.source.measurementId, clip.source.serviceId);
    const current = original.rows.find(r => r.id === clip.source.rowId);
    if (clip.mode !== 'copy' && !current) throw new Error('A origem foi excluída.');
    const row: MeasuredRow = { ...structuredClone(clip.mode === 'copy' ? clip.snapshot : current!), id: crypto.randomUUID() };
    if (clip.mode === 'reference') {
      const sharedRecordId = current!.sharedRecordId ?? crypto.randomUUID();
      propagate(next, original, { ...current!, sharedRecordId }); row.sharedRecordId = sharedRecordId;
    } else if (clip.mode === 'cut') {
      putEntry(next, { ...original, rows: original.rows.filter(r => r.id !== current!.id) });
    } else {
      row.sharedRecordId = undefined;
      // Copy geometry too: an independent copy must never mutate the original marks.
      for (const f of sourceFields) if (row[f]) {
        const source = row[f]!; const plan = next.plans.find(p => p.id === source.planId);
        const mark = plan?.measures.find(m => m.id === source.measureId);
        if (!plan || !mark) throw new Error('Marcação de origem não encontrada.');
        const id = crypto.randomUUID();
        plan.measures.push({ ...structuredClone(mark), id, projectId: next.projectId, measurementId: mid, serviceId: sid, taskId: undefined, logId: undefined });
        row[f] = { ...source, measureId: id };
      }
    }
    const destination = entryFor(next, mid, sid); putEntry(next, { ...destination, rows: [...destination.rows, row] });
  });
}
export function captureMeasurement(w: MeasurementWorkspace, actor: MeasurementActor, destination: Destination, nextPlan: TakeoffPlan, mark: TakeoffMeasure, remove = false) {
  return transactMeasurement(w, actor, remove ? 'Apagar captura' : 'Capturar / editar planta', next => {
    const { measurementId, serviceId, rowId, field } = destination;
    assertDestination(next, measurementId, serviceId, actor);
    const plan = next.plans.find(p => p.id === nextPlan.id);
    if (!plan) throw new Error('Planta não cadastrada.');
    next.plans = next.plans.map(p => p.id === nextPlan.id ? structuredClone(nextPlan) : p);
    const references = next.entries.flatMap(e => e.rows.flatMap(r => sourceFields.flatMap(f => r[f]?.measureId === mark.id ? [{ e, r, f }] : [])));
    const value = remove ? 0 : quantity(mark.kind, mark.points, nextPlan.scales[mark.page] ?? null, mark.heightMeters);
    if (value === null) throw new Error('Geometria insuficiente.');
    if (!references.length && !remove) {
      if (mark.projectId !== next.projectId || mark.measurementId !== measurementId || mark.serviceId !== serviceId) throw new Error('Captura pertence a outro serviço ou medição.');
      const e = entryFor(next, measurementId, serviceId), r = e.rows.find(r => r.id === rowId);
      if (!r) throw new Error('Célula de destino não encontrada.');
      references.push({ e, r, f: sourceField(field) });
    }
    for (const ref of references) {
      const field = (['multiplier', 'measuredQuantity', 'dimensionC', 'dimensionD'] as const)[sourceFields.indexOf(ref.f)];
      const r = withDetailValue(ref.r, field, value);
      r[ref.f] = remove ? undefined : { planId: nextPlan.id, planName: nextPlan.name, floor: nextPlan.floor, page: mark.page, measureId: mark.id, measureName: mark.name, kind: mark.kind, resultUnit: measureUnit(mark.kind, nextPlan.scales[mark.page] ?? null), heightMeters: mark.heightMeters, points: structuredClone(mark.points) };
      propagate(next, entryFor(next, ref.e.measurementId, ref.e.serviceId), { ...ref.r, ...r });
    }
  });
}
export function addMeasuredPeriod(w: MeasurementWorkspace, actor: MeasurementActor, startDate: string, endDate: string) {
  return transactMeasurement(w, actor, 'Criar medição', next => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) throw new Error('Período inválido.');
    if (next.periods.some(p => startDate <= p.endDate && endDate >= p.startDate)) throw new Error('O período sobrepõe outra medição.');
    next.periods.push({ id: crypto.randomUUID(), number: Math.max(0, ...next.periods.map(p => p.number)) + 1, startDate, endDate, status: 'draft' });
  });
}
export function freezeMeasuredPeriod(w: MeasurementWorkspace, actor: MeasurementActor, id: string) {
  if (!actor.canReview) throw new Error('Sem permissão para envio fiscal.');
  return transactMeasurement(w, actor, 'Enviar para fiscalização', next => {
    const p = next.periods.find(p => p.id === id); if (!p || isPeriodLocked(p)) throw new Error('Medição indisponível.');
    p.frozen = monthlyLines(next, id); p.status = 'in_review';
  });
}
export function undoMeasuredOperation(w: MeasurementWorkspace, actor: MeasurementActor, auditId: string) {
  const audit = w.audit.find(a => a.id === auditId); if (!audit) throw new Error('Operação não encontrada.');
  return transactMeasurement(w, actor, `Restaurar ${audit.id}`, next => {
    if (audit.beforePeriods || audit.beforeServices) throw new Error('Mudanças de período, contratuais ou fiscais exigem revisão específica.');
    for (const after of audit.after) if (json(entryFor(next, after.measurementId, after.serviceId)) !== json(after)) throw new Error('Há edição posterior. A restauração foi bloqueada.');
    if (audit.afterPlans && json(next.plans) !== json(audit.afterPlans)) throw new Error('Há alteração posterior na planta.');
    audit.before.forEach(e => putEntry(next, structuredClone(e)));
    if (audit.beforePlans) next.plans = structuredClone(audit.beforePlans);
  });
}
