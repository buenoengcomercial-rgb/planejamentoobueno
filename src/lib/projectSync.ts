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
import {
  PROJECT_COLLECTION_KEYS,
  normalizeProjectCollections,
  type ProjectCollectionKey,
} from '@/lib/projectDataScope';
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
  Subcontract,
} from '@/types/project';

type Json = import('@/integrations/supabase/types').Json;

// ============== SNAPSHOT (para diff entre saves) ==============

interface ChapterRow {
  parent_id: string | null;
  order_index: number;
  name: string | null;
  data: unknown;
}
interface TaskRow {
  chapter_id: string;
  parent_task_id: string | null;
  order_index: number;
  name: string | null;
  start_date: string | null;
  duration_days: number | null;
  percent_complete: number | null;
  data: unknown;
}

export interface ContractImportPayload {
  budgetItems: Array<Record<string, unknown>>;
  analyticCompositions: Array<Record<string, unknown>>;
  chapters: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
}

interface Snapshot {
  loadedCollections: Set<ProjectCollectionKey>;
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
  subcontracts: Map<string, Subcontract>;
  chapters: Map<string, ChapterRow>;
  tasks: Map<string, TaskRow>;
}

const snapshots = new Map<string, Snapshot>();

interface PendingProjectHydration {
  projectId: string;
  collections: ProjectCollectionKey[];
}

// Uma resposta de rede ainda não é a fotografia aceita pela UI. O WeakMap
// vincula os metadados ao objeto exato devolvido pela hidratação sem inserir
// campos transitórios no Project nem avançar o snapshot prematuramente.
const pendingProjectHydrations = new WeakMap<Project, PendingProjectHydration>();

function emptySnapshot(): Snapshot {
  return {
    loadedCollections: new Set(),
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
    subcontracts: new Map(),
    chapters: new Map(),
    tasks: new Map(),
  };
}

function phaseToChapterRow(phase: Phase, orderIndex: number): ChapterRow {
  const { tasks: _tasks, ...rest } = phase;
  return {
    parent_id: phase.parentId ?? null,
    order_index: phase.order ?? orderIndex,
    name: phase.name ?? null,
    data: rest,
  };
}

function taskToTaskRow(task: Task, chapterId: string, parentTaskId: string | null, orderIndex: number): TaskRow {
  const { children: _c, dailyLogs: _dl, ...rest } = task;
  return {
    chapter_id: chapterId,
    parent_task_id: parentTaskId,
    order_index: orderIndex,
    name: task.name ?? null,
    start_date: task.startDate || null,
    duration_days: typeof task.duration === 'number' ? task.duration : null,
    percent_complete: typeof task.percentComplete === 'number' ? task.percentComplete : null,
    data: rest,
  };
}

function buildSnapshot(
  project: Project,
  collections: readonly ProjectCollectionKey[] = PROJECT_COLLECTION_KEYS,
): Snapshot {
  const loadedCollections = new Set(collections);
  const snap = emptySnapshot();
  snap.loadedCollections = loadedCollections;
  if (loadedCollections.has('warehouseMovements')) {
    for (const m of project.warehouse?.movements ?? []) snap.movements.set(m.id, m);
  }
  if (loadedCollections.has('warehouseRequisitions')) {
    for (const r of project.warehouse?.requisitions ?? []) snap.requisitions.set(r.id, r);
  }
  if (loadedCollections.has('warehouseCustody')) {
    for (const c of project.warehouse?.custodyTerms ?? []) snap.custody.set(c.id, c);
  }
  if (loadedCollections.has('dailyReports')) {
    for (const d of project.dailyReports ?? []) snap.dailyReports.set(d.id, d);
  }
  if (loadedCollections.has('measurements')) {
    for (const m of project.measurements ?? []) snap.measurements.set(m.id, m);
  }
  if (loadedCollections.has('additives')) {
    for (const a of project.additives ?? []) snap.additives.set(a.id, a);
  }
  if (loadedCollections.has('auditLogs')) {
    for (const l of project.auditLogs ?? []) snap.auditLogs.set(l.id, l);
  }
  if (loadedCollections.has('stockMovements')) {
    for (const s of project.stockMovements ?? []) snap.stockMovements.set(s.id, s);
  }
  if (loadedCollections.has('materialPriceHistory')) {
    for (const h of project.materialPriceHistory ?? []) snap.priceHistory.set(h.id, h);
  }
  if (loadedCollections.has('budgetItems')) {
    for (const b of project.budgetItems ?? []) snap.budgetItems.set(b.id, b);
  }
  if (loadedCollections.has('materialComparisons')) {
    for (const c of project.materialComparisons ?? []) snap.materialComparisons.set(c.id, c);
  }
  if (loadedCollections.has('analyticCompositions')) {
    for (const a of project.analyticCompositions ?? []) snap.analyticCompositions.set(a.id, a);
  }
  if (loadedCollections.has('subcontracts')) {
    for (const subcontract of project.subcontracts ?? []) snap.subcontracts.set(subcontract.id, subcontract);
  }

  const phases = project.phases ?? [];
  phases.forEach((phase, idx) => {
    if (loadedCollections.has('eapChapters')) snap.chapters.set(phase.id, phaseToChapterRow(phase, idx));
    const walkTasksWithOrder = (tasks: Task[], parentTaskId: string | null) => {
      tasks.forEach((t, tIdx) => {
        if (loadedCollections.has('tasks')) snap.tasks.set(t.id, taskToTaskRow(t, phase.id, parentTaskId, tIdx));
        if (loadedCollections.has('taskDailyLogs')) {
          for (const log of t.dailyLogs ?? []) {
            snap.taskLogs.set(log.id, { taskId: t.id, log });
          }
        }
        if (t.children?.length) walkTasksWithOrder(t.children, t.id);
      });
    };
    walkTasksWithOrder(phase.tasks ?? [], null);
  });

  return snap;
}

export function setCloudSnapshot(projectId: string, project: Project) {
  snapshots.set(projectId, buildSnapshot(project));
}

const SNAPSHOT_MAP_BY_COLLECTION: Record<ProjectCollectionKey, keyof Omit<Snapshot, 'loadedCollections'>> = {
  warehouseMovements: 'movements',
  warehouseRequisitions: 'requisitions',
  warehouseCustody: 'custody',
  dailyReports: 'dailyReports',
  taskDailyLogs: 'taskLogs',
  measurements: 'measurements',
  additives: 'additives',
  auditLogs: 'auditLogs',
  stockMovements: 'stockMovements',
  materialPriceHistory: 'priceHistory',
  budgetItems: 'budgetItems',
  materialComparisons: 'materialComparisons',
  analyticCompositions: 'analyticCompositions',
  subcontracts: 'subcontracts',
  eapChapters: 'chapters',
  tasks: 'tasks',
};

function snapshotCollectionEqual(
  left: Snapshot,
  right: Snapshot,
  collection: ProjectCollectionKey,
): boolean {
  const mapKey = SNAPSHOT_MAP_BY_COLLECTION[collection];
  const leftMap = left[mapKey] as Map<string, unknown>;
  const rightMap = right[mapKey] as Map<string, unknown>;
  if (leftMap.size !== rightMap.size) return false;
  for (const [id, value] of leftMap) {
    if (!rightMap.has(id) || !shallowEqualJSON(value, rightMap.get(id))) return false;
  }
  return true;
}

/** Retorna somente as coleções efetivamente alteradas entre duas fotografias. */
export function getChangedProjectCollections(
  before: Project,
  after: Project,
  collections: readonly ProjectCollectionKey[] = PROJECT_COLLECTION_KEYS,
): ProjectCollectionKey[] {
  const requested = normalizeProjectCollections(collections);
  const beforeSnapshot = buildSnapshot(before, requested);
  const afterSnapshot = buildSnapshot(after, requested);
  return requested.filter(collection => !snapshotCollectionEqual(beforeSnapshot, afterSnapshot, collection));
}

/** Campos da linha principal que não pertencem às coleções normalizadas. */
export function hasProjectMetadataChanges(before: Project, after: Project): boolean {
  return !shallowEqualJSON(stripNormalizedCollections(before), stripNormalizedCollections(after));
}

/**
 * Aplica somente os campos guardados em `projects.data_json`, preservando as
 * coleções normalizadas que a tela atual já mantém em memória. Eventos da
 * tabela principal são metadados e não autorizam uma hidratação integral.
 */
export function mergeProjectMetadata(current: Project, incoming: Project): Project {
  const metadata = stripNormalizedCollections(incoming);
  const next: Project = {
    ...current,
    ...metadata,
    phases: current.phases,
    dailyReports: current.dailyReports,
    measurements: current.measurements,
    additives: current.additives,
    auditLogs: current.auditLogs,
    stockMovements: current.stockMovements,
    materialPriceHistory: current.materialPriceHistory,
    budgetItems: current.budgetItems,
    materialComparisons: current.materialComparisons,
    analyticCompositions: current.analyticCompositions,
    subcontracts: current.subcontracts,
  };
  if (current.warehouse || metadata.warehouse) {
    next.warehouse = {
      ...(current.warehouse ?? metadata.warehouse!),
      ...(metadata.warehouse ?? {}),
      movements: current.warehouse?.movements ?? [],
      requisitions: current.warehouse?.requisitions ?? [],
      custodyTerms: current.warehouse?.custodyTerms ?? [],
    };
  }
  return next;
}

function mergeCloudSnapshot(
  projectId: string,
  project: Project,
  collections: readonly ProjectCollectionKey[],
) {
  const current = snapshots.get(projectId) ?? emptySnapshot();
  const incoming = buildSnapshot(project, collections);
  for (const collection of collections) {
    const mapKey = SNAPSHOT_MAP_BY_COLLECTION[collection];
    // Os mapas possuem tipos específicos, mas a atribuição é sempre feita pelo
    // vínculo estático acima entre coleção e mapa.
    (current[mapKey] as Map<string, unknown>) = incoming[mapKey] as Map<string, unknown>;
    current.loadedCollections.add(collection);
  }
  snapshots.set(projectId, current);
}

export interface ConfirmProjectHydrationOptions {
  /**
   * Substitui a fotografia anterior somente no instante da confirmação.
   * Use na abertura/troca de obra para não limpar um snapshot válido enquanto
   * uma resposta de rede que ainda pode ser descartada está em andamento.
   */
  replaceExisting?: boolean;
}

/** Coleções efetivamente recebidas por esta resposta, independentemente do snapshot atual. */
export function getHydratedProjectCollections(project: Project): ProjectCollectionKey[] {
  const pending = pendingProjectHydrations.get(project);
  if (!pending || pending.projectId !== project.id) return [];
  return [...pending.collections];
}

/**
 * Confirma uma resposta de hidratação depois que o chamador validar obra, rota
 * e sequência. Respostas descartadas nunca devem chamar esta função.
 */
export function confirmHydratedProjectCollections(
  project: Project,
  options: ConfirmProjectHydrationOptions = {},
): ProjectCollectionKey[] {
  const pending = pendingProjectHydrations.get(project);
  if (!pending || pending.projectId !== project.id) return [];
  const collections = [...pending.collections];
  confirmProjectCollectionsSnapshot(project, collections, options);
  pendingProjectHydrations.delete(project);
  return collections;
}

/** Libera explicitamente os metadados de uma resposta que a UI descartou. */
export function discardHydratedProjectCollections(project: Project): void {
  pendingProjectHydrations.delete(project);
}

/**
 * Atualiza no snapshot somente coleções já aceitas pela UI, por exemplo um
 * Diário recebido por realtime. Nenhum outro domínio do projeto é tocado.
 */
export function confirmProjectCollectionsSnapshot(
  project: Project,
  collections: readonly ProjectCollectionKey[],
  options: ConfirmProjectHydrationOptions = {},
): ProjectCollectionKey[] {
  const confirmed = normalizeProjectCollections(collections);
  if (options.replaceExisting) snapshots.set(project.id, buildSnapshot(project, confirmed));
  else mergeCloudSnapshot(project.id, project, confirmed);
  return confirmed;
}

export function getLoadedProjectCollections(projectId: string): ProjectCollectionKey[] {
  const loaded = snapshots.get(projectId)?.loadedCollections ?? new Set<ProjectCollectionKey>();
  return PROJECT_COLLECTION_KEYS.filter(collection => loaded.has(collection));
}

export function getMissingProjectCollections(
  projectId: string,
  required: readonly ProjectCollectionKey[],
): ProjectCollectionKey[] {
  const loaded = new Set(getLoadedProjectCollections(projectId));
  return normalizeProjectCollections(required).filter(collection => !loaded.has(collection));
}

/**
 * Registros antigos podem ter o identificador somente na coluna relacional,
 * sem a cópia redundante dentro de `data`. A coluna é a fonte de verdade.
 */
export function hydrateAuditLogRow(row: { id: string; data: unknown }): AuditLog {
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {};
  return { ...data, id: row.id } as unknown as AuditLog;
}

/**
 * Contratos terceirizados possuem uma cópia de segurança no projeto principal.
 * A tabela normalizada é usada para consulta e RLS, mas nunca pode apagar um
 * contrato recém-criado caso a sincronização dela falhe depois do PATCH pai.
 */
export function reconcileSubcontracts(
  backup: Subcontract[] | undefined,
  normalized: Subcontract[] | null,
): Subcontract[] | undefined {
  if (normalized === null) return backup;
  if (!backup?.length) return normalized;
  if (normalized.length === 0) return backup;

  const merged = new Map(normalized.map(contract => [contract.id, contract]));
  // O data_json é gravado no mesmo PATCH que alterou a obra e, por isso,
  // prevalece quando a tabela normalizada estiver atrasada.
  backup.forEach(contract => merged.set(contract.id, contract));
  return [...merged.values()];
}

/**
 * Serializa a estrutura contratual V2 no mesmo formato das tabelas normalizadas.
 * O payload é consumido pela RPC transacional de criação de obra.
 */
export function buildContractImportPayload(project: Project): ContractImportPayload {
  const snapshot = buildSnapshot(project);
  return {
    budgetItems: Array.from(snapshot.budgetItems, ([id, item]) => ({
      id,
      item: item.item ?? null,
      code: item.code ?? null,
      source: item.source ?? null,
      task_id: item.taskId ?? null,
      additive_id: item.additiveId ?? null,
      data: item,
    })),
    analyticCompositions: Array.from(snapshot.analyticCompositions, ([id, composition]) => ({
      id,
      code: composition.code ?? null,
      data: composition,
    })),
    chapters: Array.from(snapshot.chapters, ([id, chapter]) => ({
      id,
      ...chapter,
    })),
    tasks: Array.from(snapshot.tasks, ([id, task]) => ({
      id,
      ...task,
    })),
  };
}

export function clearCloudSnapshot(projectId: string) {
  snapshots.delete(projectId);
}

export class ProjectSnapshotUnavailableError extends Error {
  constructor() {
    super('Os dados desta obra precisam ser recarregados antes de salvar. Nenhuma coleção foi alterada.');
    this.name = 'ProjectSnapshotUnavailableError';
  }
}

export function assertProjectSnapshotAvailable(projectId: string) {
  if (!snapshots.get(projectId)?.loadedCollections.size) {
    throw new ProjectSnapshotUnavailableError();
  }
}

export interface WarehouseOperationAcknowledgement {
  requisitionId: string;
  movementIds: string[];
  auditLogIds: string[];
}

/**
 * Avança somente as linhas confirmadas pela RPC transacional do Almoxarifado.
 * Não marca o restante do projeto como salvo e, portanto, não esconde outras
 * alterações locais ainda pendentes do autosave geral.
 */
export function acknowledgeWarehouseOperation(
  project: Project,
  acknowledgement: WarehouseOperationAcknowledgement,
) {
  const snapshot = snapshots.get(project.id);
  if (!snapshot) return;
  const requisition = project.warehouse?.requisitions.find(row => row.id === acknowledgement.requisitionId);
  if (requisition) snapshot.requisitions.set(requisition.id, requisition);
  else snapshot.requisitions.delete(acknowledgement.requisitionId);

  const movementById = new Map((project.warehouse?.movements ?? []).map(row => [row.id, row]));
  for (const id of acknowledgement.movementIds) {
    const movement = movementById.get(id);
    if (movement) snapshot.movements.set(id, movement);
    else snapshot.movements.delete(id);
  }

  const auditById = new Map((project.auditLogs ?? []).map(row => [row.id, row]));
  for (const id of acknowledgement.auditLogIds) {
    const auditLog = auditById.get(id);
    if (auditLog) snapshot.auditLogs.set(id, auditLog);
  }
}

export interface WarehouseScopedAcknowledgement {
  movementIds: string[];
  custodyIds: string[];
  auditLogIds: string[];
}

/** Avança somente as linhas devolvidas por uma RPC específica do Almoxarifado. */
export function acknowledgeWarehouseScopedOperation(
  project: Project,
  acknowledgement: WarehouseScopedAcknowledgement,
) {
  const snapshot = snapshots.get(project.id);
  if (!snapshot) return;

  const movementById = new Map((project.warehouse?.movements ?? []).map(row => [row.id, row]));
  acknowledgement.movementIds.forEach(id => {
    const row = movementById.get(id);
    if (row) snapshot.movements.set(id, row);
    else snapshot.movements.delete(id);
  });

  const custodyById = new Map((project.warehouse?.custodyTerms ?? []).map(row => [row.id, row]));
  acknowledgement.custodyIds.forEach(id => {
    const row = custodyById.get(id);
    if (row) snapshot.custody.set(id, row);
    else snapshot.custody.delete(id);
  });

  const auditById = new Map((project.auditLogs ?? []).map(row => [row.id, row]));
  acknowledgement.auditLogIds.forEach(id => {
    const row = auditById.get(id);
    if (row) snapshot.auditLogs.set(id, row);
  });
}

// ============== LOAD: HYDRATE ==============

type DataRow = { id: string; data: unknown };
type TaskLogDataRow = DataRow & { task_id: string };
type ChapterDataRow = DataRow & { parent_id: string | null; order_index: number };
type TaskDataRow = DataRow & {
  chapter_id: string;
  parent_task_id: string | null;
  order_index: number;
};
type QueryError = { message?: string } | null;
type QueryResult<T> = { data: T[] | null; error: QueryError };

async function optionalQuery<T>(
  enabled: boolean,
  query: () => PromiseLike<{ data: T[] | null; error: QueryError }>,
): Promise<QueryResult<T>> {
  if (!enabled) return { data: null, error: null };
  const result = await query();
  return { data: result.data, error: result.error };
}

export interface ProjectHydrationOptions {
  collections?: readonly ProjectCollectionKey[];
  /** Em telas operacionais, coleção ausente deve bloquear em vez de parecer vazia. */
  strict?: boolean;
}

export class ProjectHydrationError extends Error {
  constructor(public readonly collections: ProjectCollectionKey[]) {
    super('Não foi possível carregar todos os dados necessários desta área.');
    this.name = 'ProjectHydrationError';
  }
}

export async function hydrateProjectFromCloud(
  project: Project,
  options: ProjectHydrationOptions = {},
): Promise<Project> {
  const projectId = project.id;
  const requested = normalizeProjectCollections(options.collections ?? PROJECT_COLLECTION_KEYS);
  const wants = new Set(requested);
  const [movRes, reqRes, custRes, drRes, logsRes, measRes, addRes, audRes, stkRes, phRes, biRes, mcRes, acRes, subRes, chRes, tkRes] = await Promise.all([
    optionalQuery<DataRow>(wants.has('warehouseMovements'), () => supabase.from('warehouse_movements').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('warehouseRequisitions'), () => supabase.from('warehouse_requisitions').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('warehouseCustody'), () => supabase.from('warehouse_custody').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('dailyReports'), () => supabase.from('daily_reports').select('id, data').eq('project_id', projectId)),
    optionalQuery<TaskLogDataRow>(wants.has('taskDailyLogs'), () => supabase.from('task_daily_logs').select('id, task_id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('measurements'), () => supabase.from('measurements').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('additives'), () => supabase.from('additives').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('auditLogs'), () => supabase.from('audit_logs').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('stockMovements'), () => supabase.from('stock_movements').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('materialPriceHistory'), () => supabase.from('material_price_history').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('budgetItems'), () => supabase.from('budget_items').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('materialComparisons'), () => supabase.from('material_comparisons').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('analyticCompositions'), () => supabase.from('analytic_compositions').select('id, data').eq('project_id', projectId)),
    optionalQuery<DataRow>(wants.has('subcontracts'), () => supabase.from('subcontracts').select('id, data').eq('project_id', projectId)),
    optionalQuery<ChapterDataRow>(wants.has('eapChapters'), () => supabase.from('eap_chapters').select('id, parent_id, order_index, data').eq('project_id', projectId).order('order_index')),
    optionalQuery<TaskDataRow>(wants.has('tasks'), () => supabase.from('tasks').select('id, chapter_id, parent_task_id, order_index, data').eq('project_id', projectId).order('order_index')),
  ]);

  const resultByCollection: Record<ProjectCollectionKey, QueryResult<unknown>> = {
    warehouseMovements: movRes,
    warehouseRequisitions: reqRes,
    warehouseCustody: custRes,
    dailyReports: drRes,
    taskDailyLogs: logsRes,
    measurements: measRes,
    additives: addRes,
    auditLogs: audRes,
    stockMovements: stkRes,
    materialPriceHistory: phRes,
    budgetItems: biRes,
    materialComparisons: mcRes,
    analyticCompositions: acRes,
    subcontracts: subRes,
    eapChapters: chRes,
    tasks: tkRes,
  };
  const failed = requested.filter(collection => resultByCollection[collection].error);
  if (options.strict && failed.length > 0) throw new ProjectHydrationError(failed);
  let loaded = requested.filter(collection => !resultByCollection[collection].error);
  // Capítulos e tarefas formam uma única fotografia hierárquica. Em uma
  // hidratação não estrita, o sucesso isolado de uma dessas consultas não pode
  // promover a outra (que falhou) a coleção carregada durante a confirmação.
  // Descarte o par inteiro para que uma próxima hidratação tente ambos de novo.
  if (failed.includes('eapChapters') || failed.includes('tasks')) {
    loaded = loaded.filter(collection => collection !== 'eapChapters' && collection !== 'tasks');
  }
  const loadedSet = new Set(loaded);

  const movements = loadedSet.has('warehouseMovements') ? (movRes.data ?? []).map(r => r.data as WarehouseMovement) : null;
  const requisitions = loadedSet.has('warehouseRequisitions') ? (reqRes.data ?? []).map(r => r.data as WarehouseRequisition) : null;
  const custody = loadedSet.has('warehouseCustody') ? (custRes.data ?? []).map(r => r.data as CustodyTerm) : null;
  const dailyReports = loadedSet.has('dailyReports') ? (drRes.data ?? []).map(r => r.data as DailyReport) : null;
  const taskLogs = loadedSet.has('taskDailyLogs') ? (logsRes.data ?? []).map(r => ({
    taskId: r.task_id,
    log: r.data as DailyProductionLog,
  })) : null;
  const measurements = loadedSet.has('measurements') ? (measRes.data ?? []).map(r => r.data as SavedMeasurement) : null;
  const additives = loadedSet.has('additives') ? (addRes.data ?? []).map(r => r.data as Additive) : null;
  const auditLogs = loadedSet.has('auditLogs') ? (audRes.data ?? []).map(hydrateAuditLogRow) : null;
  const stockMovements = loadedSet.has('stockMovements') ? (stkRes.data ?? []).map(r => r.data as StockMovement) : null;
  const priceHistory = loadedSet.has('materialPriceHistory') ? (phRes.data ?? []).map(r => r.data as PriceHistoryEntry) : null;
  const budgetItems = loadedSet.has('budgetItems') ? (biRes.data ?? []).map(r => r.data as BudgetItem) : null;
  const materialComparisons = loadedSet.has('materialComparisons') ? (mcRes.data ?? []).map(r => r.data as MaterialComparison) : null;
  const analyticCompositions = loadedSet.has('analyticCompositions') ? (acRes.data ?? []).map(r => r.data as AdditiveComposition) : null;
  const subcontracts = loadedSet.has('subcontracts') ? (subRes.data ?? []).map(r => r.data as Subcontract) : null;

  const next: Project = { ...project };
  if (movements !== null || requisitions !== null || custody !== null) {
    const existing = project.warehouse ?? {
      locations: [], items: [], movements: [], requisitions: [], equipments: [], equipmentGroups: [], custodyTerms: [],
    };
    next.warehouse = {
      ...existing,
      movements: movements ?? existing.movements,
      requisitions: requisitions ?? existing.requisitions,
      custodyTerms: custody ?? existing.custodyTerms,
    };
  }
  if (dailyReports !== null) next.dailyReports = dailyReports;
  // As tabelas normalizadas são a fonte de verdade, inclusive quando vazias.
  if (measurements !== null) next.measurements = measurements;
  if (additives !== null) next.additives = additives;
  if (auditLogs !== null) next.auditLogs = auditLogs;
  if (stockMovements !== null) next.stockMovements = stockMovements;
  if (priceHistory !== null) next.materialPriceHistory = priceHistory;
  if (budgetItems !== null) next.budgetItems = budgetItems;
  if (materialComparisons !== null) next.materialComparisons = materialComparisons;
  if (analyticCompositions !== null) next.analyticCompositions = analyticCompositions;
  if (loadedSet.has('subcontracts')) next.subcontracts = reconcileSubcontracts(project.subcontracts, subcontracts);

  const chapterRows = loadedSet.has('eapChapters') ? (chRes.data ?? []) : null;
  const taskRows = loadedSet.has('tasks') ? (tkRes.data ?? []) : null;
  const logsByTask = new Map<string, DailyProductionLog[]>();
  if (taskLogs !== null) {
    for (const { taskId, log } of taskLogs) {
      const rows = logsByTask.get(taskId) ?? [];
      rows.push(log);
      logsByTask.set(taskId, rows);
    }
  }

  if (chapterRows !== null && taskRows !== null) {
    type TR = NonNullable<typeof taskRows>[number];
    const childrenByParent = new Map<string, TR[]>();
    const rootTasksByChapter = new Map<string, TR[]>();
    for (const row of taskRows) {
      if (row.parent_task_id) {
        const children = childrenByParent.get(row.parent_task_id) ?? [];
        children.push(row);
        childrenByParent.set(row.parent_task_id, children);
      } else {
        const roots = rootTasksByChapter.get(row.chapter_id) ?? [];
        roots.push(row);
        rootTasksByChapter.set(row.chapter_id, roots);
      }
    }

    const buildTask = (row: TR): Task => {
      const task = { ...(row.data as object) } as Task;
      task.id = row.id;
      const children = (childrenByParent.get(row.id) ?? [])
        .slice()
        .sort((left, right) => (left.order_index ?? 0) - (right.order_index ?? 0))
        .map(buildTask);
      if (children.length > 0) task.children = children;
      else delete task.children;
      if (taskLogs !== null) task.dailyLogs = logsByTask.get(row.id) ?? [];
      return task;
    };

    next.phases = chapterRows
      .slice()
      .sort((left, right) => (left.order_index ?? 0) - (right.order_index ?? 0))
      .map(chapter => {
        const phase = { ...(chapter.data as object) } as Phase;
        phase.id = chapter.id;
        if (chapter.parent_id) phase.parentId = chapter.parent_id;
        else delete (phase as Partial<Phase>).parentId;
        phase.order = chapter.order_index;
        phase.tasks = (rootTasksByChapter.get(chapter.id) ?? [])
          .slice()
          .sort((left, right) => (left.order_index ?? 0) - (right.order_index ?? 0))
          .map(buildTask);
        return phase;
      });
  } else if (taskLogs !== null) {
    next.phases = (project.phases ?? []).map(phase => mapPhaseTasks(phase, logsByTask, true));
  }

  pendingProjectHydrations.set(next, { projectId, collections: loaded });
  return next;
}

function mapPhaseTasks(phase: Phase, byTask: Map<string, DailyProductionLog[]>, replaceAll = false): Phase {
  return { ...phase, tasks: phase.tasks?.map(t => mapTask(t, byTask, replaceAll)) ?? [] };
}
function mapTask(task: Task, byTask: Map<string, DailyProductionLog[]>, replaceAll = false): Task {
  const next: Task = { ...task };
  if (replaceAll || byTask.has(task.id)) next.dailyLogs = byTask.get(task.id) ?? [];
  if (task.children?.length) next.children = task.children.map(c => mapTask(c, byTask, replaceAll));
  return next;
}

export function mergeHydratedProjectCollections(
  current: Project,
  hydrated: Project,
  collections: readonly ProjectCollectionKey[],
): Project {
  const loaded = new Set(normalizeProjectCollections(collections));
  const next: Project = { ...current };
  if (loaded.has('warehouseMovements') || loaded.has('warehouseRequisitions') || loaded.has('warehouseCustody')) {
    const currentWarehouse = current.warehouse;
    const hydratedWarehouse = hydrated.warehouse;
    if (hydratedWarehouse) {
      next.warehouse = {
        ...(currentWarehouse ?? hydratedWarehouse),
        ...(loaded.has('warehouseMovements') ? { movements: hydratedWarehouse.movements } : {}),
        ...(loaded.has('warehouseRequisitions') ? { requisitions: hydratedWarehouse.requisitions } : {}),
        ...(loaded.has('warehouseCustody') ? { custodyTerms: hydratedWarehouse.custodyTerms } : {}),
      };
    }
  }
  if (loaded.has('dailyReports')) next.dailyReports = hydrated.dailyReports;
  if (loaded.has('measurements')) next.measurements = hydrated.measurements;
  if (loaded.has('additives')) next.additives = hydrated.additives;
  if (loaded.has('auditLogs')) next.auditLogs = hydrated.auditLogs;
  if (loaded.has('stockMovements')) next.stockMovements = hydrated.stockMovements;
  if (loaded.has('materialPriceHistory')) next.materialPriceHistory = hydrated.materialPriceHistory;
  if (loaded.has('budgetItems')) next.budgetItems = hydrated.budgetItems;
  if (loaded.has('materialComparisons')) next.materialComparisons = hydrated.materialComparisons;
  if (loaded.has('analyticCompositions')) next.analyticCompositions = hydrated.analyticCompositions;
  if (loaded.has('subcontracts')) next.subcontracts = hydrated.subcontracts;
  if (loaded.has('eapChapters') || loaded.has('tasks')) next.phases = hydrated.phases;
  else if (loaded.has('taskDailyLogs')) {
    const logsByTask = new Map<string, DailyProductionLog[]>();
    for (const phase of hydrated.phases ?? []) collectTaskLogs(phase.tasks ?? [], logsByTask);
    next.phases = (current.phases ?? []).map(phase => mapPhaseTasks(phase, logsByTask, true));
  }
  return next;
}

function collectTaskLogs(tasks: Task[], target: Map<string, DailyProductionLog[]>) {
  for (const task of tasks) {
    target.set(task.id, task.dailyLogs ?? []);
    if (task.children?.length) collectTaskLogs(task.children, target);
  }
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
  // Contratos terceirizados também ficam no data_json como cópia de segurança.
  // O volume é pequeno e evita perder um pacote se a tabela normalizada falhar.
  next.subcontracts = project.subcontracts ?? [];
  // EAP normalizada em eap_chapters/tasks — não persistir mais em data_json.
  next.phases = [];
  return next;
}

/**
 * Faz diff entre o snapshot salvo e o projeto atual, e aplica
 * upsert/delete por linha nas tabelas normalizadas.
 *
 * A sincronização é estrita: qualquer falha impede o snapshot de avançar.
 */
export interface ProjectCollectionSyncOptions {
  /** Exclusivo para a criação inicial, quando o objeto em memória é a fonte completa. */
  allowCompleteWithoutSnapshot?: boolean;
}

export async function syncCollectionsToCloud(
  project: Project,
  userId?: string,
  options: ProjectCollectionSyncOptions = {},
): Promise<void> {
  const projectId = project.id;
  const existingSnapshot = snapshots.get(projectId);
  if (!options.allowCompleteWithoutSnapshot) assertProjectSnapshotAvailable(projectId);
  const trackedCollections = existingSnapshot?.loadedCollections.size
    ? [...existingSnapshot.loadedCollections]
    : [...PROJECT_COLLECTION_KEYS];
  const prev = existingSnapshot ?? emptySnapshot();
  const next = buildSnapshot(project, trackedCollections);
  const tracks = (collection: ProjectCollectionKey) => next.loadedCollections.has(collection);

  const ops: Promise<unknown>[] = [];

  if (tracks('warehouseMovements')) {
    ops.push(...diffAndSync('warehouse_movements', prev.movements, next.movements, projectId, userId, m => ({
      occurred_at: (m as WarehouseMovement).date ?? null,
    }), movement => normalizedDeletePolicy('warehouse_movements', movement)));
  }
  // Retiradas nunca são excluídas porque desapareceram de um snapshot local.
  // A exclusão administrativa usa uma RPC explícita, autenticada e auditada.
  if (tracks('warehouseRequisitions')) ops.push(...diffAndSync('warehouse_requisitions', prev.requisitions, next.requisitions, projectId, userId, undefined, () => false));
  if (tracks('warehouseCustody')) ops.push(...diffAndSync('warehouse_custody', prev.custody, next.custody, projectId, userId));
  if (tracks('dailyReports')) {
    ops.push(...diffAndSync('daily_reports', prev.dailyReports, next.dailyReports, projectId, userId, d => ({
      report_date: (d as DailyReport).date,
    }), () => false));
  }
  if (tracks('measurements')) {
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
  }
  if (tracks('additives')) {
    ops.push(...diffAndSync('additives', prev.additives, next.additives, projectId, userId, a => {
      const add = a as Additive;
      return {
        name: add.name ?? null,
        status: add.status ?? null,
        version: add.version ?? null,
        imported_at: add.importedAt ?? null,
      };
    }));
  }
  if (tracks('auditLogs')) {
    ops.push(...diffAndSync('audit_logs', prev.auditLogs, next.auditLogs, projectId, userId, l => {
      const log = l as AuditLog;
      return {
        entity_type: log.entityType ?? null,
        entity_id: log.entityId ?? null,
        action: log.action ?? null,
        occurred_at: log.at ?? null,
        user_id: log.userId ?? null,
      };
    }, () => false));
  }
  if (tracks('stockMovements')) {
    ops.push(...diffAndSync('stock_movements', prev.stockMovements, next.stockMovements, projectId, userId, s => {
      const stk = s as StockMovement;
      return {
        item_key: stk.itemKey ?? null,
        occurred_at: stk.date ? stk.date.slice(0, 10) : null,
        movement_type: stk.type ?? null,
      };
    }));
  }
  if (tracks('materialPriceHistory')) {
    ops.push(...diffAndSync('material_price_history', prev.priceHistory, next.priceHistory, projectId, userId, h => ({
      item_key: (h as PriceHistoryEntry).itemCode ?? null,
    })));
  }
  if (tracks('budgetItems')) {
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
  }
  if (tracks('materialComparisons')) {
    ops.push(...diffAndSync('material_comparisons', prev.materialComparisons, next.materialComparisons, projectId, userId, c => {
      const mc = c as MaterialComparison;
      return { name: mc.name ?? null, status: mc.status ?? null };
    }));
  }
  if (tracks('analyticCompositions')) {
    ops.push(...diffAndSync('analytic_compositions', prev.analyticCompositions, next.analyticCompositions, projectId, userId, a => ({
      code: (a as AdditiveComposition).code ?? null,
    })));
  }
  if (tracks('subcontracts')) {
    ops.push(...diffAndSync('subcontracts', prev.subcontracts, next.subcontracts, projectId, userId, s => {
      const subcontract = s as Subcontract;
      return { name: subcontract.name, contractor_name: subcontract.contractorName, status: subcontract.status, contract_date: subcontract.contractDate, contracted_value: subcontract.contractedValue };
    }));
  }
  if (tracks('taskDailyLogs')) ops.push(...diffAndSyncTaskLogs(prev.taskLogs, next.taskLogs, projectId, userId));
  if (tracks('eapChapters')) ops.push(...diffAndSyncEAP('eap_chapters', prev.chapters, next.chapters, projectId, userId));
  if (tracks('tasks')) ops.push(...diffAndSyncEAP('tasks', prev.tasks, next.tasks, projectId, userId));


  const results = await Promise.allSettled(ops);
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    const reasons = failed
      .slice(0, 3)
      .map(result => result.status === 'rejected'
        ? String(result.reason instanceof Error ? result.reason.message : result.reason)
        : '')
      .filter(Boolean)
      .join('; ');
    console.warn(`[projectSync] ${failed.length}/${results.length} operações normalizadas falharam: ${reasons || 'motivo não informado'}`);
    throw new Error(`Falha ao persistir a estrutura normalizada da obra${reasons ? `: ${reasons}` : '.'}`);
  }

  snapshots.set(projectId, next);
}

function diffAndSync<T extends { id: string }>(
  table: 'warehouse_movements' | 'warehouse_requisitions' | 'warehouse_custody' | 'daily_reports' | 'measurements' | 'additives' | 'audit_logs' | 'stock_movements' | 'material_price_history' | 'budget_items' | 'material_comparisons' | 'analytic_compositions' | 'subcontracts',
  prev: Map<string, T>,
  next: Map<string, T>,
  projectId: string,
  userId?: string,
  extraCols?: (item: T) => Record<string, unknown>,
  allowDelete?: (item: T) => boolean,
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
  for (const [id, item] of prev) {
    if (!next.has(id) && (allowDelete?.(item) ?? true)) toDelete.push(id);
  }
  if (toDelete.length > 0) {
    ops.push((async () => {
      const r = await supabase.from(table).delete().in('id', toDelete).eq('project_id', projectId);
      if (r.error) throw new Error(`${table} delete: ${r.error.message}`);
    })());
  }

  return ops;
}

/**
 * Exclusões inferidas continuam válidas para ajustes administrativos que não
 * pertencem a uma retirada. Movimentos vinculados a retirada/devolução só
 * saem pela RPC explícita, evitando que outra tela apague estoque confirmado.
 */
export function normalizedDeletePolicy(
  table: 'warehouse_movements' | 'warehouse_requisitions' | 'daily_reports' | 'audit_logs',
  item: { originType?: WarehouseMovement['originType'] },
): boolean {
  if (table === 'warehouse_requisitions' || table === 'daily_reports' || table === 'audit_logs') return false;
  return item.originType !== 'withdrawal' && item.originType !== 'return';
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

function diffAndSyncEAP(
  table: 'eap_chapters' | 'tasks',
  prev: Map<string, ChapterRow | TaskRow>,
  next: Map<string, ChapterRow | TaskRow>,
  projectId: string,
  userId?: string,
): Promise<unknown>[] {
  const ops: Promise<unknown>[] = [];
  const upserts: Record<string, unknown>[] = [];
  for (const [id, row] of next) {
    const before = prev.get(id);
    if (!before || !shallowEqualJSON(before, row)) {
      const r = row as unknown as Record<string, unknown>;
      upserts.push({
        id,
        project_id: projectId,
        ...r,
        ...(before ? {} : { created_by: userId ?? null }),
      });
    }
  }
  if (upserts.length > 0) {
    ops.push((async () => {
      const r = await supabase.from(table).upsert(upserts as never, { onConflict: 'project_id,id' });
      if (r.error) throw new Error(`${table} upsert: ${r.error.message}`);
    })());
  }
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

