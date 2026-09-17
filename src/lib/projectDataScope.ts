import type { AppView } from '@/types/project';

export const PROJECT_COLLECTION_KEYS = [
  'warehouseMovements',
  'warehouseRequisitions',
  'warehouseCustody',
  'dailyReports',
  'taskDailyLogs',
  'measurements',
  'additives',
  'auditLogs',
  'stockMovements',
  'materialPriceHistory',
  'budgetItems',
  'materialComparisons',
  'analyticCompositions',
  'subcontracts',
  'eapChapters',
  'tasks',
] as const;

export type ProjectCollectionKey = typeof PROJECT_COLLECTION_KEYS[number];

/**
 * Fronteira única entre eventos do banco e a fotografia parcial da UI.
 * A EAP é indivisível: qualquer evento de capítulo ou tarefa sempre atualiza
 * as duas coleções, evitando uma árvore com pai e filhos de versões diferentes.
 */
const REALTIME_TABLE_COLLECTIONS: Record<string, readonly ProjectCollectionKey[]> = {
  warehouse_movements: ['warehouseMovements'],
  warehouse_requisitions: ['warehouseRequisitions'],
  warehouse_custody: ['warehouseCustody'],
  daily_reports: ['dailyReports'],
  task_daily_logs: ['taskDailyLogs'],
  measurements: ['measurements'],
  additives: ['additives'],
  audit_logs: ['auditLogs'],
  stock_movements: ['stockMovements'],
  material_price_history: ['materialPriceHistory'],
  budget_items: ['budgetItems'],
  material_comparisons: ['materialComparisons'],
  analytic_compositions: ['analyticCompositions'],
  subcontracts: ['subcontracts'],
  eap_chapters: ['eapChapters', 'tasks'],
  tasks: ['eapChapters', 'tasks'],
};

export const PROJECT_REALTIME_TABLES = Object.keys(REALTIME_TABLE_COLLECTIONS) as Array<keyof typeof REALTIME_TABLE_COLLECTIONS>;

const PROJECT_AREA_COLLECTIONS: ReadonlyArray<{
  label: string;
  collections: readonly ProjectCollectionKey[];
}> = [
  { label: 'Almoxarifado', collections: ['warehouseMovements', 'warehouseRequisitions', 'warehouseCustody', 'stockMovements'] },
  { label: 'Diário de Obra', collections: ['dailyReports'] },
  { label: 'Planejamento e campo', collections: ['taskDailyLogs', 'eapChapters', 'tasks'] },
  { label: 'Medição', collections: ['measurements'] },
  { label: 'Aditivo', collections: ['additives'] },
  { label: 'Custos', collections: ['subcontracts'] },
  { label: 'Materiais e orçamento', collections: ['budgetItems', 'materialComparisons', 'analyticCompositions', 'materialPriceHistory'] },
  { label: 'Histórico', collections: ['auditLogs'] },
];

export function projectCollectionsForRealtimeTable(table?: string): ProjectCollectionKey[] {
  if (!table) return [];
  return normalizeProjectCollections(REALTIME_TABLE_COLLECTIONS[table] ?? []);
}

export function projectAreasForCollections(collections: readonly ProjectCollectionKey[]): string[] {
  const selected = new Set(normalizeProjectCollections(collections));
  return PROJECT_AREA_COLLECTIONS
    .filter(area => area.collections.some(collection => selected.has(collection)))
    .map(area => area.label);
}

export const WAREHOUSE_TAB_VALUES = [
  'painel',
  'notas',
  'requisicoes',
  'materiais-retirados',
  'materiais-orcamento',
  'estoque',
  'equipamentos',
  'movimentos',
  'inventario',
  'manutencao',
] as const;

export type WarehouseTab = typeof WAREHOUSE_TAB_VALUES[number];

const unique = (keys: readonly ProjectCollectionKey[]) => [...new Set(keys)];

const EAP: ProjectCollectionKey[] = ['eapChapters', 'tasks'];
const PRODUCTION: ProjectCollectionKey[] = [...EAP, 'taskDailyLogs'];
export const WORK_START_COLLECTIONS: readonly ProjectCollectionKey[] = [
  ...EAP,
  'measurements',
  'additives',
];
const SCHEDULE: ProjectCollectionKey[] = unique([
  ...PRODUCTION,
  ...WORK_START_COLLECTIONS,
]);
// `ensureWarehouse` ainda consulta esta coleção durante a compatibilidade com
// dados legados. Mantê-la em todas as subabas evita interpretar "não carregado"
// como ausência real até a migração ser definitivamente aposentada.
const WAREHOUSE_LEGACY_GUARD: ProjectCollectionKey[] = [
  'warehouseMovements',
  'stockMovements',
];
const WAREHOUSE_PLANNING: ProjectCollectionKey[] = [
  ...EAP,
  'budgetItems',
  'analyticCompositions',
  'additives',
];

const VIEW_COLLECTIONS: Record<Exclude<AppView, 'warehouse'>, ProjectCollectionKey[]> = {
  dashboard: unique([
    ...EAP,
    ...WORK_START_COLLECTIONS,
    'budgetItems',
    'materialComparisons',
    'analyticCompositions',
  ]),
  management: unique([...SCHEDULE, 'dailyReports', 'auditLogs']),
  gantt: unique([...SCHEDULE, 'budgetItems', 'auditLogs']),
  tasks: unique([...SCHEDULE]),
  dailyReport: unique([
    ...SCHEDULE,
    'warehouseMovements',
    'warehouseRequisitions',
    'dailyReports',
  ]),
  measurement: unique([
    ...SCHEDULE,
    'dailyReports',
    'measurements',
    'budgetItems',
    'analyticCompositions',
    'auditLogs',
  ]),
  additive: unique([
    ...EAP,
    ...WORK_START_COLLECTIONS,
    'budgetItems',
    'analyticCompositions',
    'additives',
    'auditLogs',
  ]),
  additiveSchedule: unique([...SCHEDULE, 'auditLogs']),
  realCost: unique([
    ...SCHEDULE,
    'warehouseMovements',
    'budgetItems',
    'analyticCompositions',
    'materialComparisons',
    'subcontracts',
    'auditLogs',
  ]),
  materials: unique([
    ...EAP,
    ...WORK_START_COLLECTIONS,
    'warehouseMovements',
    'stockMovements',
    'materialPriceHistory',
    'budgetItems',
    'analyticCompositions',
    'materialComparisons',
  ]),
};

const WAREHOUSE_TAB_COLLECTIONS: Record<WarehouseTab, ProjectCollectionKey[]> = {
  painel: unique([
    ...WAREHOUSE_LEGACY_GUARD,
    'warehouseMovements',
    'warehouseCustody',
    ...WAREHOUSE_PLANNING,
  ]),
  notas: unique([
    ...WAREHOUSE_LEGACY_GUARD,
    'warehouseMovements',
    'warehouseRequisitions',
    ...WAREHOUSE_PLANNING,
    'materialComparisons',
    'dailyReports',
    'auditLogs',
  ]),
  requisicoes: unique([
    ...WAREHOUSE_LEGACY_GUARD,
    'warehouseMovements',
    'warehouseRequisitions',
    'warehouseCustody',
    ...EAP,
    'dailyReports',
    'auditLogs',
  ]),
  'materiais-retirados': unique([
    ...WAREHOUSE_LEGACY_GUARD,
    'warehouseMovements',
    'warehouseRequisitions',
    ...EAP,
  ]),
  'materiais-orcamento': unique([
    ...WAREHOUSE_LEGACY_GUARD,
    'warehouseMovements',
    'warehouseRequisitions',
    ...WAREHOUSE_PLANNING,
  ]),
  estoque: unique([
    ...WAREHOUSE_LEGACY_GUARD,
    'warehouseMovements',
    ...WAREHOUSE_PLANNING,
    'materialComparisons',
  ]),
  equipamentos: unique([...WAREHOUSE_LEGACY_GUARD, 'warehouseCustody']),
  movimentos: unique([
    ...WAREHOUSE_LEGACY_GUARD,
    'warehouseMovements',
    'warehouseRequisitions',
    ...EAP,
  ]),
  inventario: unique([
    ...WAREHOUSE_LEGACY_GUARD,
    'warehouseMovements',
    ...WAREHOUSE_PLANNING,
  ]),
  // Exclusiva do Proprietário. Carrega as coleções que podem conter anexos
  // legados, mas somente quando a manutenção é aberta.
  manutencao: unique([
    ...WAREHOUSE_LEGACY_GUARD,
    'warehouseMovements',
    'warehouseRequisitions',
    'warehouseCustody',
    'dailyReports',
    'auditLogs',
  ]),
};

export function projectCollectionsForView(
  view: AppView,
  warehouseTab: WarehouseTab = 'painel',
): ProjectCollectionKey[] {
  if (view === 'warehouse') return WAREHOUSE_TAB_COLLECTIONS[warehouseTab];
  return VIEW_COLLECTIONS[view];
}

export function normalizeProjectCollections(
  keys: readonly ProjectCollectionKey[],
): ProjectCollectionKey[] {
  const normalized = new Set(keys);
  // A hierarquia somente é segura quando capítulos e tarefas representam a
  // mesma fotografia do banco.
  if (normalized.has('eapChapters') || normalized.has('tasks')) {
    normalized.add('eapChapters');
    normalized.add('tasks');
  }
  return PROJECT_COLLECTION_KEYS.filter(key => normalized.has(key));
}

export function warehouseTabStorageKey(projectId: string) {
  return `obraplanner:warehouse-tab:${projectId}`;
}

export function isWarehouseTab(value: unknown): value is WarehouseTab {
  return typeof value === 'string' && WAREHOUSE_TAB_VALUES.includes(value as WarehouseTab);
}

export function readWarehouseTab(projectId: string, canViewPanel: boolean, canMaintainAttachments = false): WarehouseTab {
  const fallback: WarehouseTab = canViewPanel ? 'painel' : 'notas';
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.sessionStorage.getItem(warehouseTabStorageKey(projectId));
    if (!isWarehouseTab(stored) || (!canViewPanel && stored === 'painel') || (!canMaintainAttachments && stored === 'manutencao')) return fallback;
    return stored;
  } catch {
    return fallback;
  }
}
