import type { Additive, Project } from '@/types/project';
import type { TakeoffPlan } from './planTakeoff';
import { calculateMeasurementLine } from './measurementCalculations';
import { calculateLineTotal, money2, sumMoney } from './financialEngine';
import { computeAdditiveRow, resolveAdditivePricingRule } from './additiveImport';
import { detailTotal, editableQuantityRows } from './productionQuantityDetails';
import { entryFor, isPeriodLocked, monthlyLines, newMeasuredRow, sourceFields, transactMeasurement, type MeasuredService, type MeasurementActor, type MeasurementWorkspace } from './measurementWorkspace';

export interface IncorporationIssue { code: string; sourceId: string; message: string }
export interface Inventory {
  services: number; dailyLogs: number; periodLogs: number; detailRows: number; references: number;
  plans: number; marks: number; filesBytes: number; periods: number; fiscalPeriods: number; audits: number; drafts: number;
}
export interface Incorporation {
  candidate: MeasurementWorkspace; issues: IncorporationIssue[]; inventory: Inventory;
  reconciliation: { measurementId: string; number: number; serviceId: string; before: number; after: number; difference: number }[];
}
export interface IncorporationBackup { id: string; createdAt: string; project: Project; plans: TakeoffPlan[]; drafts: unknown[]; manifest: { dataHash: string; files: { id: string; bytes: number; sha256: string }[] } }
const digest = async (bytes: BufferSource) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
export async function createIncorporationBackup(project: Project, plans: TakeoffPlan[], drafts: unknown[]): Promise<IncorporationBackup> {
  const snapshot = structuredClone({ project, plans, drafts });
  const dataHash = await digest(new TextEncoder().encode(JSON.stringify(snapshot)));
  const files = await Promise.all(snapshot.plans.map(async p => ({ id: p.id, bytes: p.file.size, sha256: await digest(await p.file.arrayBuffer()) })));
  return { id: `measurement-${dataHash}`, createdAt: new Date().toISOString(), ...snapshot, manifest: { dataHash, files } };
}
export async function verifyIncorporationBackup(backup: IncorporationBackup) {
  const check = await createIncorporationBackup(backup.project, backup.plans, backup.drafts);
  if (JSON.stringify(check.manifest) !== JSON.stringify(backup.manifest) || check.id !== backup.id) throw new Error('Backup incompleto ou alterado. Incorporação bloqueada.');
}

/** Read-only, deterministic planning. No heuristic date assignment when intervals overlap. */
export function prepareIncorporation(backup: IncorporationBackup): Incorporation {
  const { project, plans, drafts } = backup;
  const issues: IncorporationIssue[] = [];
  const issue = (code: string, sourceId: string, message: string) => issues.push({ code, sourceId, message });
  const tasks = project.phases.flatMap(p => p.tasks.map(t => ({ task: t, phase: p })));
  const periods = (project.measurements ?? []).map(m => ({ id: m.id, number: m.number, startDate: m.startDate, endDate: m.endDate, status: m.status, editUnlocked: m.editUnlocked, originalSnapshot: structuredClone(m) }));
  const candidate: MeasurementWorkspace = { schema: 1, projectId: project.id, projectName: project.name, revision: 0, contract: structuredClone(project.contractInfo), services: [], periods, entries: [], plans: plans.map(p => ({ ...structuredClone(p), measures: [] })), audit: [], importedKeys: [], backupId: backup.id };
  const logs = tasks.flatMap(t => t.task.dailyLogs ?? []);
  const inventory: Inventory = { services: tasks.length, dailyLogs: logs.filter(l => !l.measurementPeriod).length, periodLogs: logs.filter(l => l.measurementPeriod).length, detailRows: logs.reduce((n, l) => n + (l.quantityDetails?.length ?? 0), 0), references: new Set(logs.flatMap(l => l.quantityDetails?.flatMap(r => r.sharedRecordId ? [r.sharedRecordId] : []) ?? [])).size, plans: plans.length, marks: plans.reduce((n, p) => n + p.measures.length, 0), filesBytes: plans.reduce((n, p) => n + p.file.size, 0), periods: periods.length, fiscalPeriods: periods.filter(isPeriodLocked).length, audits: project.auditLogs?.length ?? 0, drafts: drafts.length + (project.measurementDraft ? 1 : 0) };
  if (drafts.length) issue('pending-drafts', project.id, 'Existem rascunhos não confirmados. Conferir antes da incorporação.');
  for (const p of periods) if (periods.some(other => other.id !== p.id && (other.number === p.number || other.startDate <= p.endDate && other.endDate >= p.startDate))) issue('period-overlap', p.id, `${p.number}ª medição: número repetido ou período sobreposto.`);
  const phasePath = (id: string, visited: string[] = []): string[] => {
    const p = project.phases.find(p => p.id === id); if (!p || visited.includes(id)) return [];
    return [...(p.parentId ? phasePath(p.parentId, [...visited, id]) : []), id];
  };
  const usedBudgets = new Set<string>();
  const consumedMarks = new Set<string>();
  for (const { task, phase } of tasks) {
    const budgets = (project.budgetItems ?? []).filter(b => b.taskId === task.id);
    if (budgets.length > 1) issue('ambiguous-service', task.id, `${task.name}: vários itens contratuais vinculados.`);
    const b = budgets[0]; if (b) usedBudgets.add(b.id);
    const snapshots = periods.flatMap(p => p.originalSnapshot?.items.filter(i => i.taskId === task.id) ?? []);
    const original = snapshots[0];
    if (!b && !original) issue('missing-price-source', task.id, `${task.name}: confirmar preço, quantidade e ordem contratual; sem vínculo contratual inequívoco.`);
    const path = phasePath(phase.id); const root = project.phases.find(p => p.id === path[0]) ?? phase;
    const noBDI = money2(b?.unitPriceNoBDI ?? original?.unitPriceNoBDI ?? task.unitPriceNoBDI ?? 0);
    const withBDI = money2(b?.unitPriceWithBDI ?? original?.unitPriceWithBDI ?? task.unitPrice ?? 0);
    const service: MeasuredService = { id: task.id, sourceTaskId: task.id, sourceBudgetId: b?.id, item: b?.item ?? original?.item ?? '', description: b?.description ?? original?.description ?? task.name, unit: b?.unit ?? original?.unit ?? task.unit ?? '', contracted: b?.quantity ?? original?.qtyContracted ?? task.quantity ?? 0, priceNoBDI: noBDI, priceWithBDI: withBDI, bdi: noBDI > 0 ? (withBDI / noBDI - 1) * 100 : (project.syntheticBdiPercent ?? 0), importedPrice: !!b, chapterId: root.id, chapter: root.name, path: path.map(id => project.phases.find(p => p.id === id)!.name).join(' › '), availableFromNumber: 1, additiveId: b?.additiveId };
    candidate.services.push(service);
    for (const log of task.dailyLogs ?? []) {
      const key = `log:${task.id}:${log.id}`;
      if (candidate.importedKeys.includes(key)) { issue('duplicate-log', log.id, 'Identificador de lançamento duplicado.'); continue; }
      const matches = log.measurementPeriod
        ? periods.filter(p => log.measurementPeriod!.measurementId ? p.id === log.measurementPeriod!.measurementId : p.number === log.measurementPeriod!.number && p.startDate === log.measurementPeriod!.startDate && p.endDate === log.measurementPeriod!.endDate)
        : periods.filter(p => log.date >= p.startDate && log.date <= p.endDate);
      if (matches.length !== 1) { issue('ambiguous-period', log.id, `${task.name} · ${log.date || 'por período'}: destino não identificado sem ambiguidade.`); continue; }
      const period = matches[0];
      if (log.measurementPeriod && (period.number !== log.measurementPeriod.number || period.startDate !== log.measurementPeriod.startDate || period.endDate !== log.measurementPeriod.endDate)) { issue('conflicting-period', log.id, 'ID do período e datas/número discordam.'); continue; }
      let rows = editableQuantityRows(log);
      if (!rows.length && log.actualQuantity > 0) rows = [{ ...newMeasuredRow(`preserved-${log.id}`), comment: `Dado preservado · ${log.measurementPeriod ? `${period.number}ª medição` : log.date.split('-').reverse().join('/')}`, multiplier: log.actualQuantity }];
      if (Math.abs(detailTotal(rows) - log.actualQuantity) > 1e-8) issue('detail-difference', log.id, `Detalhe ${detailTotal(rows)} difere do registrado ${log.actualQuantity}.`);
      const entry = entryFor(candidate, period.id, service.id);
      const migrated = rows.map(r => {
        const next = { ...structuredClone(r), id: `${log.id}:${r.id}`, origin: { kind: log.measurementPeriod ? 'period' as const : 'daily' as const, logId: log.id, originalRowId: r.id, ...(!log.measurementPeriod ? { date: log.date } : {}) } };
        for (const f of sourceFields) if (next[f]) {
          const src = next[f]!; const sourcePlan = plans.find(p => p.id === src.planId); const mark = sourcePlan?.measures.find(m => m.id === src.measureId);
          if (!mark || JSON.stringify(mark.points) !== JSON.stringify(src.points)) { issue('mark-conflict', r.id, 'Planta/marcação ausente ou coordenadas divergentes.'); continue; }
          consumedMarks.add(`${src.planId}:${mark.id}`);
          const id = `measurement:${r.sharedRecordId ?? `${period.id}:${service.id}`}:${mark.id}`;
          const target = candidate.plans.find(p => p.id === src.planId)!;
          if (!target.measures.some(m => m.id === id)) target.measures.push({ ...structuredClone(mark), id, taskId: undefined, logId: undefined, projectId: project.id, measurementId: period.id, serviceId: service.id });
          next[f] = { ...src, measureId: id };
        }
        return next;
      });
      if (!candidate.entries.includes(entry)) candidate.entries.push(entry);
      entry.rows.push(...migrated); candidate.importedKeys.push(key);
    }
  }
  for (const b of project.budgetItems ?? []) if (!usedBudgets.has(b.id)) issue('unmapped-budget', b.id, `${b.item} ${b.description}: serviço contratual sem mapeamento confirmado.`);
  for (const period of periods) for (const item of period.originalSnapshot?.items ?? []) {
    if (!candidate.services.some(s => s.sourceTaskId === item.taskId)) issue('unmapped-snapshot', `${period.id}:${item.taskId}`, `${period.number}ª medição · ${item.description}: serviço histórico ausente no catálogo atual. Conferir antes de incorporar.`);
  }
  for (const p of plans) for (const m of p.measures) if (!consumedMarks.has(`${p.id}:${m.id}`)) issue('unmapped-mark', m.id, `${p.name} · ${m.name}: marcação sem lançamento mapeado; preservada no backup.`);
  candidate.services.sort((a, b) => a.item.localeCompare(b.item, 'pt-BR', { numeric: true }));
  const reconciliation: Incorporation['reconciliation'] = [];
  for (const period of periods) {
    for (const service of candidate.services) {
      const entry = entryFor(candidate, period.id, service.id); const snapshot = period.originalSnapshot?.items.find(i => i.taskId === service.sourceTaskId);
      const expected = snapshot ? snapshot.qtyApproved ?? snapshot.qtyProposed : detailTotal(entry.rows);
      if (snapshot && !entry.rows.length && expected > 0) {
        entry.rows = [{ ...newMeasuredRow(`snapshot:${period.id}:${service.id}`), multiplier: expected, comment: `Dado preservado · ${period.number}ª medição`, origin: { kind: 'snapshot' } }]; candidate.entries.push(entry);
      }
      const after = detailTotal(entry.rows); const difference = after - expected;
      reconciliation.push({ measurementId: period.id, number: period.number, serviceId: service.id, before: expected, after, difference });
      if (Math.abs(difference) > 1e-8) issue('snapshot-difference', `${period.id}:${service.id}`, `${period.number}ª medição · ${service.description}: snapshot ${expected} e lançamentos ${after}; conferir a origem válida.`);
    }
    if (isPeriodLocked(period)) {
      const frozen = monthlyLines(candidate, period.id);
      for (const line of frozen) {
        const snap = period.originalSnapshot!.items.find(i => i.taskId === line.service.sourceTaskId);
        if (!snap) { if (line.qty > 0) issue('fiscal-missing-item', period.id, 'Item lançado ausente no snapshot fiscal.'); continue; }
        line.service = { ...line.service, contracted: snap.qtyContracted, description: snap.description, unit: snap.unit, priceNoBDI: snap.unitPriceNoBDI, priceWithBDI: snap.unitPriceWithBDI, bdi: snap.unitPriceNoBDI > 0 ? (snap.unitPriceWithBDI / snap.unitPriceNoBDI - 1) * 100 : period.originalSnapshot!.bdiPercent };
        line.qty = snap.qtyApproved ?? snap.qtyProposed; line.prior = snap.qtyPriorAccum;
        line.financial = calculateMeasurementLine({ quantityContracted: snap.qtyContracted, quantityPeriod: line.qty, quantityPriorAccum: snap.qtyPriorAccum, unitPriceNoBDI: snap.unitPriceNoBDI, bdiPercent: period.originalSnapshot!.bdiPercent });
        line.accumulated = line.financial.quantityCurrentAccum; line.balance = line.financial.quantityBalance;
      }
      Object.assign(period, { frozen });
    }
  }
  for (const s of candidate.services) {
    const total = candidate.entries.filter(e => e.serviceId === s.id).reduce((n, e) => n + detailTotal(e.rows), 0);
    if (total > s.contracted + 1e-8) issue('contract-limit', s.id, `${s.description}: ${total} supera ${s.contracted} contratados.`);
  }
  const records = new Map<string, string>();
  for (const e of candidate.entries) for (const r of e.rows) if (r.sharedRecordId) {
    const content = JSON.stringify({ ...r, id: '', origin: undefined });
    if (records.has(r.sharedRecordId) && records.get(r.sharedRecordId) !== content) issue('reference-conflict', r.id, 'Referências do mesmo registro possuem conteúdos divergentes.');
    records.set(r.sharedRecordId, content);
  }
  return { candidate, issues, inventory, reconciliation };
}

/** Only NEW services from the approved immutable snapshot; never replace existing terms. */
export function incorporateApprovedAdditive(w: MeasurementWorkspace, actor: MeasurementActor, additive: Additive, firstNumber: number) {
  if (!['aprovado', 'contratado', 'aditivo_contratado'].includes(additive.status ?? '') || additive.editUnlocked) throw new Error('Aditivo ainda não aprovado ou em revisão.');
  const snapshot = additive.approvalSnapshots?.find(s => s.version === additive.version);
  if (!snapshot) throw new Error('Snapshot aprovado do aditivo não encontrado.');
  const warnings = snapshot.compositions.filter(c => !c.isNewService).map(c => `${c.description}: alteração de serviço existente não incorporada; exige decisão contratual separada.`);
  const next = transactMeasurement(w, actor, `Incorporar novos serviços do aditivo ${additive.id} v${snapshot.version}`, draft => {
    if (draft.periods.some(p => isPeriodLocked(p) && p.number >= firstNumber)) throw new Error('Novos serviços não podem entrar retroativamente em uma medição fechada.');
    for (const c of snapshot.compositions.filter(c => c.isNewService)) {
      const key = `additive:${additive.id}:${c.id}`; if (draft.importedKeys.includes(key)) continue;
      if (draft.services.some(s => s.id === c.linkedTaskId || s.id === c.taskId)) throw new Error(`${c.description}: já é um serviço existente. Nenhum preço ou quantidade foi substituído.`);
      const pricing = computeAdditiveRow(c, snapshot.bdiPercent, snapshot.globalDiscountPercent, snapshot.pricingRuleVersion ?? resolveAdditivePricingRule(additive));
      const noBDI = pricing.unitPriceNoBDI, withBDI = pricing.unitPriceWithBDI;
      draft.services.push({ id: key, item: c.itemNumber ?? c.item, description: c.description, unit: c.unit, contracted: pricing.qtdFinal, priceNoBDI: noBDI, priceWithBDI: withBDI, bdi: noBDI > 0 ? (withBDI / noBDI - 1) * 100 : snapshot.bdiPercent, importedPrice: true, chapterId: c.phaseId ?? additive.id, chapter: additive.name, path: c.phaseChain ?? additive.name, additiveId: additive.id, additiveVersion: snapshot.version, availableFromNumber: firstNumber });
      draft.importedKeys.push(key);
    }
    draft.services.sort((a, b) => a.item.localeCompare(b.item, 'pt-BR', { numeric: true }));
  });
  return { workspace: next, warnings, contractedValue: sumMoney(next.services.map(s => calculateLineTotal(s.priceWithBDI, s.contracted))) };
}
