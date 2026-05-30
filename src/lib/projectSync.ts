/**
 * Sincronização incremental das coleções de alto volume entre o objeto
 * `Project` (UI) e as tabelas normalizadas no Supabase.
 *
 * A UI continua lendo/gravando `project.warehouse.movements`, `project.dailyReports`,
 * `task.dailyLogs` etc. — esta camada intercepta load/save:
 *
 *  - hydrateProjectFromCloud(project): popula essas coleções a partir das tabelas.
 *  - syncCollectionsToCloud(prev, next, projectId): faz upsert/delete por linha.
 *  - stripNormalizedCollections(project): remove essas coleções antes do PATCH
 *    em `projects.data_json`, mantendo o payload pequeno.
 *
 * Snapshot de "estado salvo" é mantido em memória por projectId para diff.
 */
import { supabase } from '@/integrations/supabase/client';
import type {
  Project,
  WarehouseMovement,
  WarehouseRequisition,
  CustodyTerm,
  DailyReport,
  DailyProductionLog,
  Task,
  Phase,
  SavedMeasurement,
  Additive,
  AuditLog,
  StockMovement,
  PriceHistoryEntry,
  BudgetItem,
  MaterialComparison,
  AdditiveComposition,
} from '@/types/project';

type Json = import('@/integrations/supabase/types').Json;

// ============== SNAPSHOT (para diff entre saves) ==============

interface Snapshot {
  movements: Map<string, WarehouseMovement>;
  requisitions: Map<string, WarehouseRequisition>;
  custody: Map<string, CustodyTerm>;
  dailyReports: Map<string, DailyReport>;
  taskLogs: Map<string, { taskId: string; log: DailyProductionLog }>;
  measurements: Map<string, SavedMeasurement>;
  additives: Map<string, Additive>;
  auditLogs: Map<string, AuditLog>;
  stockMovements: Map<string, StockMovement>;
  priceHistory: Map<string, PriceHistoryEntry>;
  budgetItems: Map<string, BudgetItem>;
  materialComparisons: Map<string, MaterialComparison>;
  analyticCompositions: Map<string, AdditiveComposition>;
}

const snapshots = new Map<string, Snapshot>();

function emptySnapshot(): Snapshot {
  return {
    movements: new Map(),
    requisitions: new Map(),
    custody: new Map(),
    dailyReports: new Map(),
    taskLogs: new Map(),
    measurements: new Map(),
    additives: new Map(),
    auditLogs: new Map(),
    stockMovements: new Map(),
    priceHistory: new Map(),
    budgetItems: new Map(),
    materialComparisons: new Map(),
    analyticCompositions: new Map(),
  };
}

function buildSnapshot(project: Project): Snapshot {
  const snap = emptySnapshot();
  for (const m of project.warehouse?.movements ?? []) snap.movements.set(m.id, m);
  for (const r of project.warehouse?.requisitions ?? []) snap.requisitions.set(r.id, r);
  for (const c of project.warehouse?.custodyTerms ?? []) snap.custody.set(c.id, c);
  for (const d of project.dailyReports ?? []) snap.dailyReports.set(d.id, d);
  for (const m of project.measurements ?? []) snap.measurements.set(m.id, m);
  for (const a of project.additives ?? []) snap.additives.set(a.id, a);
  for (const l of project.auditLogs ?? []) snap.auditLogs.set(l.id, l);
  for (const s of project.stockMovements ?? []) snap.stockMovements.set(s.id, s);
  for (const h of project.materialPriceHistory ?? []) snap.priceHistory.set(h.id, h);
  for (const b of project.budgetItems ?? []) snap.budgetItems.set(b.id, b);
  for (const c of project.materialComparisons ?? []) snap.materialComparisons.set(c.id, c);
  for (const a of project.analyticCompositions ?? []) snap.analyticCompositions.set(a.id, a);
  walkTasks(project.phases ?? [], task => {
    for (const log of task.dailyLogs ?? []) {
      snap.taskLogs.set(log.id, { taskId: task.id, log });
    }
  });
  return snap;
}

function walkTasks(phases: Phase[], visit: (t: Task) => void) {
  const stackTasks = (tasks: Task[]) => {
    for (const t of tasks) {
      visit(t);
      if (t.children?.length) stackTasks(t.children);
    }
  };
  for (const p of phases) stackTasks(p.tasks ?? []);
}

export function setCloudSnapshot(projectId: string, project: Project) {
  snapshots.set(projectId, buildSnapshot(project));
}

export function clearCloudSnapshot(projectId: string) {
  snapshots.delete(projectId);
}

// ============== LOAD: HYDRATE ==============

export async function hydrateProjectFromCloud(project: Project): Promise<Project> {
  const projectId = project.id;
  const [movRes, reqRes, custRes, drRes, logsRes, measRes, addRes, audRes, stkRes, phRes, biRes, mcRes, acRes] = await Promise.all([
    supabase.from('warehouse_movements').select('id, data').eq('project_id', projectId),
    supabase.from('warehouse_requisitions').select('id, data').eq('project_id', projectId),
    supabase.from('warehouse_custody').select('id, data').eq('project_id', projectId),
    supabase.from('daily_reports').select('id, data').eq('project_id', projectId),
    supabase.from('task_daily_logs').select('id, task_id, data').eq('project_id', projectId),
    supabase.from('measurements').select('id, data').eq('project_id', projectId),
    supabase.from('additives').select('id, data').eq('project_id', projectId),
    supabase.from('audit_logs').select('id, data').eq('project_id', projectId),
    supabase.from('stock_movements').select('id, data').eq('project_id', projectId),
    supabase.from('material_price_history').select('id, data').eq('project_id', projectId),
    supabase.from('budget_items').select('id, data').eq('project_id', projectId),
    supabase.from('material_comparisons').select('id, data').eq('project_id', projectId),
    supabase.from('analytic_compositions').select('id, data').eq('project_id', projectId),
  ]);

  // Falha silenciosa: mantém o que veio no data_json (legado / sem permissão).
  const movements = movRes.error ? null : (movRes.data ?? []).map(r => r.data as unknown as WarehouseMovement);
  const requisitions = reqRes.error ? null : (reqRes.data ?? []).map(r => r.data as unknown as WarehouseRequisition);
  const custody = custRes.error ? null : (custRes.data ?? []).map(r => r.data as unknown as CustodyTerm);
  const dailyReports = drRes.error ? null : (drRes.data ?? []).map(r => r.data as unknown as DailyReport);
  const taskLogs = logsRes.error ? null : (logsRes.data ?? []).map(r => ({
    taskId: r.task_id,
    log: r.data as unknown as DailyProductionLog,
  }));
  const measurements = measRes.error ? null : (measRes.data ?? []).map(r => r.data as unknown as SavedMeasurement);
  const additives = addRes.error ? null : (addRes.data ?? []).map(r => r.data as unknown as Additive);
  const auditLogs = audRes.error ? null : (audRes.data ?? []).map(r => r.data as unknown as AuditLog);
  const stockMovements = stkRes.error ? null : (stkRes.data ?? []).map(r => r.data as unknown as StockMovement);
  const priceHistory = phRes.error ? null : (phRes.data ?? []).map(r => r.data as unknown as PriceHistoryEntry);
  const budgetItems = biRes.error ? null : (biRes.data ?? []).map(r => r.data as unknown as BudgetItem);
  const materialComparisons = mcRes.error ? null : (mcRes.data ?? []).map(r => r.data as unknown as MaterialComparison);
  const analyticCompositions = acRes.error ? null : (acRes.data ?? []).map(r => r.data as unknown as AdditiveComposition);

  const next: Project = { ...project };

  if (movements !== null || requisitions !== null || custody !== null) {
    const existing = project.warehouse ?? {
      locations: [], items: [], movements: [], requisitions: [], equipments: [], custodyTerms: [],
    };
    next.warehouse = {
      ...existing,
      movements: movements ?? existing.movements,
      requisitions: requisitions ?? existing.requisitions,
      custodyTerms: custody ?? existing.custodyTerms,
    };
  }
  if (dailyReports !== null) next.dailyReports = dailyReports;
  if (measurements !== null && measurements.length > 0) next.measurements = measurements;
  if (additives !== null && additives.length > 0) next.additives = additives;
  if (auditLogs !== null && auditLogs.length > 0) next.auditLogs = auditLogs;
  if (stockMovements !== null && stockMovements.length > 0) next.stockMovements = stockMovements;
  if (priceHistory !== null && priceHistory.length > 0) next.materialPriceHistory = priceHistory;
  if (budgetItems !== null && budgetItems.length > 0) next.budgetItems = budgetItems;
  if (materialComparisons !== null && materialComparisons.length > 0) next.materialComparisons = materialComparisons;
  if (analyticCompositions !== null && analyticCompositions.length > 0) next.analyticCompositions = analyticCompositions;

  if (taskLogs !== null && taskLogs.length > 0) {
    const byTask = new Map<string, DailyProductionLog[]>();
    for (const { taskId, log } of taskLogs) {
      const arr = byTask.get(taskId) ?? [];
      arr.push(log);
      byTask.set(taskId, arr);
    }
    next.phases = (project.phases ?? []).map(p => mapPhaseTasks(p, byTask));
  }

  setCloudSnapshot(projectId, next);
  return next;
}

function mapPhaseTasks(phase: Phase, byTask: Map<string, DailyProductionLog[]>): Phase {
  return { ...phase, tasks: phase.tasks?.map(t => mapTask(t, byTask)) ?? [] };
}
function mapTask(task: Task, byTask: Map<string, DailyProductionLog[]>): Task {
  const next: Task = { ...task };
  if (byTask.has(task.id)) next.dailyLogs = byTask.get(task.id)!;
  if (task.children?.length) next.children = task.children.map(c => mapTask(c, byTask));
  return next;
}

// ============== SAVE: STRIP + SYNC ==============

/**
 * Retorna uma cópia do projeto SEM as coleções normalizadas, para reduzir o
 * payload de `data_json`. As coleções continuam vivas em memória.
 */
export function stripNormalizedCollections(project: Project): Project {
  const next: Project = { ...project };
  if (project.warehouse) {
    next.warehouse = {
      ...project.warehouse,
      movements: [],
      requisitions: [],
      custodyTerms: [],
    };
  }
  next.dailyReports = [];
  next.measurements = [];
  next.additives = [];
  next.auditLogs = [];
  next.stockMovements = [];
  next.materialPriceHistory = [];
  next.budgetItems = [];
  next.materialComparisons = [];
  next.analyticCompositions = [];
  if (project.phases?.length) {
    next.phases = project.phases.map(stripPhaseLogs);
  }
  return next;
}
function stripPhaseLogs(phase: Phase): Phase {
  return { ...phase, tasks: phase.tasks?.map(stripTaskLogs) ?? [] };
}
function stripTaskLogs(task: Task): Task {
  const next: Task = { ...task, dailyLogs: [] };
  if (task.children?.length) next.children = task.children.map(stripTaskLogs);
  return next;
}

/**
 * Faz diff entre o snapshot salvo e o projeto atual, e aplica
 * upsert/delete por linha nas tabelas normalizadas.
 *
 * Não bloqueia o save do projeto se a sincronização falhar (apenas loga).
 */
export async function syncCollectionsToCloud(project: Project, userId?: string): Promise<void> {
  const projectId = project.id;
  const prev = snapshots.get(projectId) ?? emptySnapshot();
  const next = buildSnapshot(project);

  const ops: Promise<unknown>[] = [];

  ops.push(...diffAndSync('warehouse_movements', prev.movements, next.movements, projectId, userId, m => ({
    occurred_at: (m as WarehouseMovement).date ?? null,
  })));
  ops.push(...diffAndSync('warehouse_requisitions', prev.requisitions, next.requisitions, projectId, userId));
  ops.push(...diffAndSync('warehouse_custody', prev.custody, next.custody, projectId, userId));
  ops.push(...diffAndSync('daily_reports', prev.dailyReports, next.dailyReports, projectId, userId, d => ({
    report_date: (d as DailyReport).date,
  })));
  ops.push(...diffAndSync('measurements', prev.measurements, next.measurements, projectId, userId, m => {
    const meas = m as SavedMeasurement;
    return {
      number: meas.number ?? null,
      status: meas.status ?? null,
      start_date: meas.startDate ?? null,
      end_date: meas.endDate ?? null,
      issue_date: meas.issueDate ?? null,
    };
  }));
  ops.push(...diffAndSync('additives', prev.additives, next.additives, projectId, userId, a => {
    const add = a as Additive;
    return {
      name: add.name ?? null,
      status: add.status ?? null,
      version: add.version ?? null,
      imported_at: add.importedAt ?? null,
    };
  }));
  ops.push(...diffAndSync('audit_logs', prev.auditLogs, next.auditLogs, projectId, userId, l => {
    const log = l as AuditLog;
    return {
      entity_type: log.entityType ?? null,
      entity_id: log.entityId ?? null,
      action: log.action ?? null,
      occurred_at: log.at ?? null,
      user_id: log.userId ?? null,
    };
  }));
  ops.push(...diffAndSync('stock_movements', prev.stockMovements, next.stockMovements, projectId, userId, s => {
    const stk = s as StockMovement;
    return {
      item_key: stk.itemKey ?? null,
      occurred_at: stk.date ? stk.date.slice(0, 10) : null,
      movement_type: stk.type ?? null,
    };
  }));
  ops.push(...diffAndSync('material_price_history', prev.priceHistory, next.priceHistory, projectId, userId, h => ({
    item_key: (h as PriceHistoryEntry).itemCode ?? null,
  })));
  ops.push(...diffAndSync('budget_items', prev.budgetItems, next.budgetItems, projectId, userId, b => {
    const bi = b as BudgetItem;
    return {
      item: bi.item ?? null,
      code: bi.code ?? null,
      source: bi.source ?? null,
      task_id: bi.taskId ?? null,
      additive_id: bi.additiveId ?? null,
    };
  }));
  ops.push(...diffAndSync('material_comparisons', prev.materialComparisons, next.materialComparisons, projectId, userId, c => {
    const mc = c as MaterialComparison;
    return { name: mc.name ?? null, status: mc.status ?? null };
  }));
  ops.push(...diffAndSync('analytic_compositions', prev.analyticCompositions, next.analyticCompositions, projectId, userId, a => ({
    code: (a as AdditiveComposition).code ?? null,
  })));
  ops.push(...diffAndSyncTaskLogs(prev.taskLogs, next.taskLogs, projectId, userId));

  const results = await Promise.allSettled(ops);
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    console.warn(`[projectSync] ${failed.length}/${results.length} ops falharam`, failed.slice(0, 3));
  }

  snapshots.set(projectId, next);
}

function diffAndSync<T extends { id: string }>(
  table: 'warehouse_movements' | 'warehouse_requisitions' | 'warehouse_custody' | 'daily_reports' | 'measurements' | 'additives' | 'audit_logs' | 'stock_movements' | 'material_price_history' | 'budget_items' | 'material_comparisons' | 'analytic_compositions',
  prev: Map<string, T>,
  next: Map<string, T>,
  projectId: string,
  userId?: string,
  extraCols?: (item: T) => Record<string, unknown>,
): Promise<unknown>[] {
  const ops: Promise<unknown>[] = [];

  // upserts (novos ou modificados)
  const upserts: Record<string, unknown>[] = [];
  for (const [id, item] of next) {
    const before = prev.get(id);
    if (!before || !shallowEqualJSON(before, item)) {
      upserts.push({
        id,
        project_id: projectId,
        data: item as unknown as Json,
        ...(extraCols ? extraCols(item) : {}),
        ...(before ? {} : { created_by: userId ?? null }),
      });
    }
  }
  if (upserts.length > 0) {
    ops.push((async () => {
      const r = await supabase.from(table).upsert(upserts as never, { onConflict: 'id' });
      if (r.error) throw new Error(`${table} upsert: ${r.error.message}`);
    })());
  }

  // deletes (presentes antes, ausentes agora)
  const toDelete: string[] = [];
  for (const id of prev.keys()) if (!next.has(id)) toDelete.push(id);
  if (toDelete.length > 0) {
    ops.push((async () => {
      const r = await supabase.from(table).delete().in('id', toDelete).eq('project_id', projectId);
      if (r.error) throw new Error(`${table} delete: ${r.error.message}`);
    })());
  }

  return ops;
}

function diffAndSyncTaskLogs(
  prev: Map<string, { taskId: string; log: DailyProductionLog }>,
  next: Map<string, { taskId: string; log: DailyProductionLog }>,
  projectId: string,
  userId?: string,
): Promise<unknown>[] {
  const ops: Promise<unknown>[] = [];
  const upserts: Record<string, unknown>[] = [];
  for (const [id, { taskId, log }] of next) {
    const before = prev.get(id);
    if (!before || before.taskId !== taskId || !shallowEqualJSON(before.log, log)) {
      upserts.push({
        id,
        project_id: projectId,
        task_id: taskId,
        log_date: log.date,
        data: log as unknown as Json,
        ...(before ? {} : { created_by: userId ?? null }),
      });
    }
  }
  if (upserts.length > 0) {
    ops.push((async () => {
      const r = await supabase.from('task_daily_logs').upsert(upserts as never, { onConflict: 'id' });
      if (r.error) throw new Error(`task_daily_logs upsert: ${r.error.message}`);
    })());
  }
  const toDelete: string[] = [];
  for (const id of prev.keys()) if (!next.has(id)) toDelete.push(id);
  if (toDelete.length > 0) {
    ops.push((async () => {
      const r = await supabase.from('task_daily_logs').delete().in('id', toDelete).eq('project_id', projectId);
      if (r.error) throw new Error(`task_daily_logs delete: ${r.error.message}`);
    })());
  }
  return ops;
}

function shallowEqualJSON(a: unknown, b: unknown): boolean {
  // Comparação por serialização: itens são pequenos (KB) e mudam raramente.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
