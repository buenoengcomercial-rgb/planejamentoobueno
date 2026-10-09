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
import { recordSyncDiagnostic } from '@/lib/syncDiagnostics';
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
  projectData: Project | null;
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
    projectData: null,
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
  snap.projectData = stripNormalizedCollections(project);
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

type SnapshotMapKey = Exclude<keyof Snapshot, 'loadedCollections' | 'projectData'>;

const SNAPSHOT_MAP_BY_COLLECTION: Record<ProjectCollectionKey, SnapshotMapKey> = {
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
  current.projectData = incoming.projectData;
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

// O PostgREST limita a quantidade de linhas devolvidas por consulta. Saldo de
// estoque exige o livro inteiro: uma página parcial pode mostrar saldo falso.
const WAREHOUSE_MOVEMENT_PAGE_SIZE = 500;

async function warehouseLedgerVersion(projectId: string): Promise<number> {
  const result = await supabase.from('projects').select('warehouse_version').eq('id', projectId).maybeSingle();
  if (result.error || !Number.isSafeInteger(result.data?.warehouse_version)) {
    throw result.error ?? new Error('A versão do livro de estoque não está disponível.');
  }
  return result.data!.warehouse_version;
}

async function loadWarehouseMovementRows(projectId: string): Promise<QueryResult<DataRow>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const startVersion = await warehouseLedgerVersion(projectId);
      const rows: DataRow[] = [];
      let lastId: string | undefined;
      let expectedCount: number | null = null;
      while (true) {
        let query = supabase.from('warehouse_movements')
          .select('id, data', rows.length ? undefined : { count: 'exact' })
          .eq('project_id', projectId)
          .order('id', { ascending: true })
          .limit(WAREHOUSE_MOVEMENT_PAGE_SIZE);
        if (lastId) query = query.gt('id', lastId);
        const result = await query;
        if (result.error) return { data: null, error: result.error };
        if (expectedCount === null) expectedCount = result.count;
        const page = result.data ?? [];
        rows.push(...page);
        if (page.length < WAREHOUSE_MOVEMENT_PAGE_SIZE) break;
        lastId = page[page.length - 1].id;
      }
      const endVersion = await warehouseLedgerVersion(projectId);
      if (startVersion === endVersion && expectedCount !== null && rows.length === expectedCount) {
        return { data: rows, error: null };
      }
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
  return { data: null, error: new Error('O estoque mudou durante o carregamento. Atualize o Almoxarifado para tentar novamente.') };
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
    optionalQuery<DataRow>(wants.has('warehouseMovements'), () => loadWarehouseMovementRows(projectId)),
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

function mergeRowsById<T>(baseline: Map<string, T>, local: Map<string, T>, remote: Map<string, T>): Map<string, T> | null {
  const merged = new Map<string, T>();
  const ids = new Set([...baseline.keys(), ...remote.keys(), ...local.keys()]);
  for (const id of ids) {
    const before = baseline.get(id);
    const edited = local.get(id);
    const incoming = remote.get(id);
    const localChanged = !shallowEqualJSON(before, edited);
    const remoteChanged = !shallowEqualJSON(before, incoming);
    if (localChanged && remoteChanged && !shallowEqualJSON(edited, incoming)) return null;
    const chosen = localChanged ? edited : incoming;
    if (chosen !== undefined) merged.set(id, chosen);
  }
  return merged;
}

/** Mescla alterações de IDs distintos; duas edições do mesmo registro exigem decisão humana. */
export function mergeProjectRecordsThreeWay(
  baseline: Project,
  local: Project,
  remote: Project,
  collections: readonly ProjectCollectionKey[],
): Project | null {
  const selected = new Set(normalizeProjectCollections(collections));
  const before = buildSnapshot(baseline, [...selected]);
  const edited = buildSnapshot(local, [...selected]);
  const incoming = buildSnapshot(remote, [...selected]);
  const mergedMaps = new Map<ProjectCollectionKey, Map<string, unknown>>();
  for (const collection of selected) {
    const key = SNAPSHOT_MAP_BY_COLLECTION[collection];
    if (collection === 'warehouseMovements' || collection === 'warehouseRequisitions' || collection === 'warehouseCustody') {
      // O Almoxarifado só é incorporado pela versão própria de suas RPCs.
      // Uma edição local nele nunca é conciliada por inferência.
      if (!shallowEqualJSON([...before[key]], [...edited[key]])) return null;
    }
    const rows = mergeRowsById(
      before[key] as Map<string, unknown>,
      edited[key] as Map<string, unknown>,
      incoming[key] as Map<string, unknown>,
    );
    if (!rows) return null;
    mergedMaps.set(collection, rows);
  }
  const rows = <T,>(key: ProjectCollectionKey) => [...(mergedMaps.get(key)?.values() ?? [])] as T[];
  const result = mergeHydratedProjectCollections(local, remote, collections);
  if (selected.has('dailyReports')) result.dailyReports = rows<DailyReport>('dailyReports');
  if (selected.has('measurements')) result.measurements = rows<SavedMeasurement>('measurements');
  if (selected.has('additives')) result.additives = rows<Additive>('additives');
  if (selected.has('auditLogs')) result.auditLogs = rows<AuditLog>('auditLogs');
  if (selected.has('stockMovements')) result.stockMovements = rows<StockMovement>('stockMovements');
  if (selected.has('materialPriceHistory')) result.materialPriceHistory = rows<PriceHistoryEntry>('materialPriceHistory');
  if (selected.has('budgetItems')) result.budgetItems = rows<BudgetItem>('budgetItems');
  if (selected.has('materialComparisons')) result.materialComparisons = rows<MaterialComparison>('materialComparisons');
  if (selected.has('analyticCompositions')) result.analyticCompositions = rows<AdditiveComposition>('analyticCompositions');
  if (selected.has('subcontracts')) result.subcontracts = rows<Subcontract>('subcontracts');

  if (selected.has('eapChapters') || selected.has('tasks')) {
    const chapters = mergedMaps.get('eapChapters') as Map<string, ChapterRow>;
    const tasks = mergedMaps.get('tasks') as Map<string, TaskRow>;
    const logs = selected.has('taskDailyLogs')
      ? mergedMaps.get('taskDailyLogs') as Map<string, { taskId: string; log: DailyProductionLog }>
      : buildSnapshot(local, ['taskDailyLogs']).taskLogs;
    const logsByTask = new Map<string, DailyProductionLog[]>();
    for (const { taskId, log } of logs.values()) {
      const taskLogs = logsByTask.get(taskId) ?? [];
      taskLogs.push(log);
      logsByTask.set(taskId, taskLogs);
    }
    const buildTask = (id: string, active: Set<string>): Task | null => {
      const row = tasks.get(id);
      if (!row || active.has(id)) return null;
      const lineage = new Set(active).add(id);
      const children = [...tasks.entries()]
        .filter(([, candidate]) => candidate.parent_task_id === id)
        .sort((left, right) => left[1].order_index - right[1].order_index)
        .map(([childId]) => buildTask(childId, lineage))
        .filter((child): child is Task => child !== null);
      return {
        ...(row.data as Task), id,
        dailyLogs: logsByTask.get(id) ?? [],
        ...(children.length ? { children } : {}),
      };
    };
    result.phases = [...chapters.entries()]
      .sort((left, right) => left[1].order_index - right[1].order_index)
      .map(([id, row]) => ({
        ...(row.data as Phase), id,
        tasks: [...tasks.entries()]
          .filter(([, candidate]) => candidate.chapter_id === id && !candidate.parent_task_id)
          .sort((left, right) => left[1].order_index - right[1].order_index)
          .map(([taskId]) => buildTask(taskId, new Set()))
          .filter((task): task is Task => task !== null),
      }));
  } else if (selected.has('taskDailyLogs')) {
    const logsByTask = new Map<string, DailyProductionLog[]>();
    for (const { taskId, log } of mergedMaps.get('taskDailyLogs')!.values() as IterableIterator<{ taskId: string; log: DailyProductionLog }>) {
      const taskLogs = logsByTask.get(taskId) ?? [];
      taskLogs.push(log);
      logsByTask.set(taskId, taskLogs);
    }
    result.phases = (local.phases ?? []).map(phase => mapPhaseTasks(phase, logsByTask, true));
  }
  return result;
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

function changedRows<T>(previous: Map<string, T>, current: Map<string, T>) {
  const upserts: Array<{ id: string; row: T }> = [];
  const deletes: string[] = [];
  for (const [id, row] of current) {
    if (!previous.has(id) || !shallowEqualJSON(previous.get(id), row)) upserts.push({ id, row });
  }
  for (const id of previous.keys()) if (!current.has(id)) deletes.push(id);
  return { upserts, deletes };
}

/**
 * Confirma a Produção em uma única transação quando ela é o único domínio
 * normalizado alterado. `null` sinaliza que o save geral deve seguir o caminho
 * de compatibilidade, inclusive se a RPC ainda não tiver sido instalada.
 */
export async function syncProductionAtomically(
  project: Project,
  slim: Project,
  organizationId: string,
  expectedUpdatedAt: string,
): Promise<string | null> {
  const previous = snapshots.get(project.id);
  if (!previous?.loadedCollections.has('eapChapters') || !previous.loadedCollections.has('tasks')) return null;
  const next = buildSnapshot(project, [...previous.loadedCollections]);
  const productionKeys = new Set(['chapters', 'tasks', 'taskLogs', 'auditLogs']);
  for (const key of Object.values(SNAPSHOT_MAP_BY_COLLECTION)) {
    if (productionKeys.has(key)) continue;
    const before = previous[key];
    const after = next[key];
    const changes = changedRows(before as Map<string, unknown>, after as Map<string, unknown>);
    if (changes.upserts.length > 0 || changes.deletes.length > 0) return null;
  }
  const chapters = changedRows(previous.chapters, next.chapters);
  const tasks = changedRows(previous.tasks, next.tasks);
  const logs = changedRows(previous.taskLogs, next.taskLogs);
  const audit = changedRows(previous.auditLogs, next.auditLogs);
  const metadataChanged = !shallowEqualJSON(previous.projectData, slim);
  if (audit.deletes.length > 0 || audit.upserts.some(({ id, row }) => previous.auditLogs.has(id) || row.entityType !== 'task')) return null;
  if (chapters.upserts.length + chapters.deletes.length + tasks.upserts.length + tasks.deletes.length
    + logs.upserts.length + logs.deletes.length + audit.upserts.length === 0) return null;

  const startedAt = Date.now();
  const recordCount = chapters.upserts.length + chapters.deletes.length + tasks.upserts.length
    + tasks.deletes.length + logs.upserts.length + logs.deletes.length + audit.upserts.length;
  if (recordCount > 500) return null;
  const { data, error } = await supabase.rpc('save_production_domain', {
    p_project_id: project.id,
    p_organization_id: organizationId,
    p_expected_updated_at: expectedUpdatedAt,
    p_name: slim.name,
    p_data: metadataChanged ? slim as unknown as Json : null,
    p_chapters_upsert: chapters.upserts.map(({ id, row }) => ({ id, ...row })) as unknown as Json,
    p_chapters_delete: chapters.deletes as unknown as Json,
    p_tasks_upsert: tasks.upserts.map(({ id, row }) => ({ id, ...row })) as unknown as Json,
    p_tasks_delete: tasks.deletes as unknown as Json,
    p_logs_upsert: logs.upserts.map(({ id, row }) => ({ id, task_id: row.taskId, log_date: row.log.measurementPeriod ? null : row.log.date, data: row.log })) as unknown as Json,
    p_logs_delete: logs.deletes as unknown as Json,
    p_audit_insert: audit.upserts.map(({ id, row }) => ({ id, data: row })) as unknown as Json,
  });
  if (error) {
    // Um app atualizado pode abrir antes de o banco receber a migration.
    if (error.code === 'PGRST202' || error.code === '42883') return null;
    recordSyncDiagnostic({ area: 'production', operation: 'save',
      outcome: error.code === 'P0002' ? 'conflict' : 'failed', durationMs: Date.now() - startedAt, recordCount });
    throw error;
  }
  if (typeof data !== 'string' || !data) throw new Error('A transação da Produção não confirmou a versão salva.');
  recordSyncDiagnostic({ area: 'production', operation: 'save', outcome: 'confirmed',
    durationMs: Date.now() - startedAt, recordCount });
  snapshots.set(project.id, next);
  return data;
}

type NormalizedDomain = 'measurement' | 'additive' | 'materials' | 'costs';
type DomainCollection = 'measurements' | 'additives' | 'budgetItems' | 'materialComparisons'
  | 'analyticCompositions' | 'materialPriceHistory' | 'subcontracts';

const DOMAIN_TABLES: Record<DomainCollection, string> = {
  measurements: 'measurements', additives: 'additives', budgetItems: 'budget_items',
  materialComparisons: 'material_comparisons', analyticCompositions: 'analytic_compositions',
  materialPriceHistory: 'material_price_history', subcontracts: 'subcontracts',
};
const DOMAIN_COLLECTIONS: Record<NormalizedDomain, readonly DomainCollection[]> = {
  measurement: ['measurements'],
  additive: ['additives', 'budgetItems', 'analyticCompositions', 'materialPriceHistory'],
  materials: ['budgetItems', 'materialComparisons', 'analyticCompositions', 'materialPriceHistory'],
  costs: ['subcontracts'],
};
const DOMAIN_AUDIT_TYPE: Record<NormalizedDomain, AuditLog['entityType']> = {
  measurement: 'measurement', additive: 'additive', materials: 'project', costs: 'subcontract',
};

function domainRow(collection: DomainCollection, id: string, value: unknown): Record<string, unknown> {
  const data = value as Record<string, unknown>;
  const common = { id, data };
  switch (collection) {
    case 'measurements': return { ...common, number: data.number ?? null, status: data.status ?? null,
      start_date: data.startDate ?? null, end_date: data.endDate ?? null, issue_date: data.issueDate ?? null };
    case 'additives': return { ...common, name: data.name ?? null, status: data.status ?? null,
      version: data.version ?? null, imported_at: data.importedAt ?? null };
    case 'budgetItems': return { ...common, item: data.item ?? null, code: data.code ?? null,
      source: data.source ?? null, task_id: data.taskId ?? null, additive_id: data.additiveId ?? null };
    case 'materialComparisons': return { ...common, name: data.name ?? null, status: data.status ?? null };
    case 'analyticCompositions': return { ...common, code: data.code ?? null };
    case 'materialPriceHistory': return { ...common, item_key: data.itemCode ?? null };
    case 'subcontracts': return { ...common, name: data.name ?? null, contractor_name: data.contractorName ?? null,
      status: data.status ?? 'draft', contract_date: data.contractDate ?? null,
      contracted_value: data.contractedValue ?? null };
  }
}

/** Confirma Medição, Aditivo, Materiais ou Custos sem salvar outras coleções. */
export async function syncNormalizedDomainAtomically(
  project: Project, slim: Project, organizationId: string, expectedUpdatedAt: string,
): Promise<string | null> {
  const previous = snapshots.get(project.id);
  if (!previous) return null;
  const next = buildSnapshot(project, [...previous.loadedCollections]);
  const changes = new Map<ProjectCollectionKey, ReturnType<typeof changedRows<unknown>>>();
  for (const collection of previous.loadedCollections) {
    const key = SNAPSHOT_MAP_BY_COLLECTION[collection];
    const diff = changedRows(previous[key] as Map<string, unknown>, next[key] as Map<string, unknown>);
    if (diff.upserts.length || diff.deletes.length) changes.set(collection, diff);
  }
  const audit = changes.get('auditLogs');
  const changedDomainCollections = [...changes.keys()].filter(key => key !== 'auditLogs');
  const newAuditTypes = new Set((audit?.upserts ?? []).map(({ row }) => (row as AuditLog).entityType));
  const domain: NormalizedDomain | null = changedDomainCollections.includes('measurements') || newAuditTypes.has('measurement')
    ? 'measurement'
    : changedDomainCollections.includes('subcontracts') || newAuditTypes.has('subcontract')
      ? 'costs'
      : changedDomainCollections.includes('additives') || newAuditTypes.has('additive')
        ? 'additive'
        : changedDomainCollections.some(key => ['budgetItems', 'materialComparisons', 'analyticCompositions', 'materialPriceHistory'].includes(key))
          ? 'materials' : null;
  if (!domain || audit?.deletes.length) return null;
  const allowed = new Set<ProjectCollectionKey>(DOMAIN_COLLECTIONS[domain]);
  if (changedDomainCollections.some(collection => !allowed.has(collection))) return null;
  if (audit?.upserts.some(({ id, row }) => previous.auditLogs.has(id)
    || (row as AuditLog).entityType !== DOMAIN_AUDIT_TYPE[domain])) return null;
  const batches = DOMAIN_COLLECTIONS[domain].flatMap(collection => {
    const diff = changes.get(collection);
    return diff ? [{ table: DOMAIN_TABLES[collection],
      upserts: diff.upserts.map(({ id, row }) => domainRow(collection, id, row)), deletes: diff.deletes }] : [];
  });
  const recordCount = batches.reduce((sum, batch) => sum + batch.upserts.length + batch.deletes.length, 0)
    + (audit?.upserts.length ?? 0);
  if (recordCount === 0 || recordCount > 500) return null;

  const startedAt = Date.now();
  const { data, error } = await supabase.rpc('save_normalized_domain', {
    p_project_id: project.id, p_organization_id: organizationId, p_expected_updated_at: expectedUpdatedAt,
    p_domain: domain, p_name: slim.name,
    p_data: shallowEqualJSON(previous.projectData, slim) ? null : slim as unknown as Json,
    p_changes: batches as unknown as Json,
    p_audit_insert: (audit?.upserts ?? []).map(({ id, row }) => ({ id, data: row })) as unknown as Json,
  });
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') return null;
    recordSyncDiagnostic({ area: domain, operation: 'save', outcome: error.code === 'P0002' ? 'conflict' : 'failed',
      durationMs: Date.now() - startedAt, recordCount });
    throw error;
  }
  if (typeof data !== 'string' || !data) throw new Error(`A transação de ${domain} não confirmou a versão salva.`);
  recordSyncDiagnostic({ area: domain, operation: 'save', outcome: 'confirmed',
    durationMs: Date.now() - startedAt, recordCount });
  snapshots.set(project.id, next);
  return data;
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

type CloudOperation = () => Promise<unknown>;

function batches<T>(rows: T[], batchSize = 200): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    result.push(rows.slice(index, index + batchSize));
  }
  return result;
}

async function runCloudOperations(operations: CloudOperation[], concurrency = 4): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = new Array(operations.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, operations.length) }, async () => {
    while (cursor < operations.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await operations[index]() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
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

  const ops: CloudOperation[] = [];

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


  const startedAt = Date.now();
  const results = await runCloudOperations(ops);
  const failed = results.filter(r => r.status === 'rejected');
  if (ops.length > 0) recordSyncDiagnostic({ area: 'collections', operation: 'save',
    outcome: failed.length > 0 ? 'failed' : 'confirmed', durationMs: Date.now() - startedAt,
    operationCount: ops.length });
  if (failed.length > 0) {
    const reasons = failed
      .slice(0, 3)
      .map(result => result.status === 'rejected'
        ? String(result.reason instanceof Error ? result.reason.message : result.reason)
        : '')
      .filter(Boolean)
      .join('; ');
    console.warn(`[projectSync] ${failed.length}/${results.length} operações normalizadas falharam: ${reasons || 'motivo não informado'}`);
    throw Object.assign(new Error(`Falha ao persistir a estrutura normalizada da obra${reasons ? `: ${reasons}` : '.'}`), {
      cause: failed[0].status === 'rejected' ? failed[0].reason : undefined,
    });
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
): CloudOperation[] {
  const ops: CloudOperation[] = [];

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
        ...(before || table === 'audit_logs' ? {} : { created_by: userId ?? null }),
      });
    }
  }
  for (const batch of batches(upserts)) {
    ops.push(async () => {
      const r = await supabase.from(table).upsert(batch as never, { onConflict: 'id' });
      if (r.error) throw Object.assign(new Error(`${table} upsert: ${r.error.message}`), { cause: r.error });
    });
  }

  // deletes (presentes antes, ausentes agora)
  const toDelete: string[] = [];
  for (const [id, item] of prev) {
    if (!next.has(id) && (allowDelete?.(item) ?? true)) toDelete.push(id);
  }
  for (const batch of batches(toDelete)) {
    ops.push(async () => {
      const r = await supabase.from(table).delete().in('id', batch).eq('project_id', projectId);
      if (r.error) throw Object.assign(new Error(`${table} delete: ${r.error.message}`), { cause: r.error });
    });
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
): CloudOperation[] {
  const ops: CloudOperation[] = [];
  const upserts: Record<string, unknown>[] = [];
  for (const [id, { taskId, log }] of next) {
    const before = prev.get(id);
    if (!before || before.taskId !== taskId || !shallowEqualJSON(before.log, log)) {
      upserts.push({
        id,
        project_id: projectId,
        task_id: taskId,
        log_date: log.measurementPeriod ? null : log.date,
        data: log as unknown as Json,
        ...(before ? {} : { created_by: userId ?? null }),
      });
    }
  }
  for (const batch of batches(upserts)) {
    ops.push(async () => {
      const r = await supabase.from('task_daily_logs').upsert(batch as never, { onConflict: 'id' });
      if (r.error) throw Object.assign(new Error(`task_daily_logs upsert: ${r.error.message}`), { cause: r.error });
    });
  }
  const toDelete: string[] = [];
  for (const id of prev.keys()) if (!next.has(id)) toDelete.push(id);
  for (const batch of batches(toDelete)) {
    ops.push(async () => {
      const r = await supabase.from('task_daily_logs').delete().in('id', batch).eq('project_id', projectId);
      if (r.error) throw Object.assign(new Error(`task_daily_logs delete: ${r.error.message}`), { cause: r.error });
    });
  }
  return ops;
}

function shallowEqualJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length
      && a.every((value, index) => shallowEqualJSON(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // Campos undefined não existem no JSON enviado ao Supabase.
  const leftKeys = Object.keys(left).filter(key => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
      && shallowEqualJSON(left[key], right[key]));
}

function diffAndSyncEAP(
  table: 'eap_chapters' | 'tasks',
  prev: Map<string, ChapterRow | TaskRow>,
  next: Map<string, ChapterRow | TaskRow>,
  projectId: string,
  userId?: string,
): CloudOperation[] {
  const ops: CloudOperation[] = [];
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
  for (const batch of batches(upserts)) {
    ops.push(async () => {
      const r = await supabase.from(table).upsert(batch as never, { onConflict: 'project_id,id' });
      if (r.error) throw Object.assign(new Error(`${table} upsert: ${r.error.message}`), { cause: r.error });
    });
  }
  const toDelete: string[] = [];
  for (const id of prev.keys()) if (!next.has(id)) toDelete.push(id);
  for (const batch of batches(toDelete)) {
    ops.push(async () => {
      const r = await supabase.from(table).delete().in('id', batch).eq('project_id', projectId);
      if (r.error) throw Object.assign(new Error(`${table} delete: ${r.error.message}`), { cause: r.error });
    });
  }
  return ops;
}

