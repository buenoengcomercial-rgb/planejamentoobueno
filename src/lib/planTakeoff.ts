import { archiveCloudPlan, cloudRowToPlan, cloudTakeoffScope, insertCloudPlan, readCloudPlanRows, updateCloudPlan } from './planTakeoffCloud';

export interface Point { x: number; y: number }
export type MeasureKind = 'count' | 'length' | 'linearLength' | 'circlePerimeter' | 'area' | 'rectangleArea' | 'circleArea' | 'verticalArea' | 'polygonVolume';
export interface TakeoffMeasure { id: string; name: string; kind: MeasureKind; page: number; points: Point[]; heightMeters?: number; taskId?: string; logId?: string }
export interface TakeoffPlan {
  id: string; name: string; floor: string; kind: 'pdf' | 'image' | 'dxf' | 'dwf'; file: Blob;
  scales: Record<number, number>; measures: TakeoffMeasure[];
  /** Capítulo principal que representa o prédio. Ausente em plantas locais antigas. */
  chapterId?: string;
  building?: string;
  /** Somente cache: caminho imutavel e versao confirmada pelo servidor. */
  storagePath?: string;
  cloudRevision?: number;
}
export interface TakeoffContext { taskId: string; logId: string }
export const TAKEOFF_CATALOG_UPDATED = 'obraplanner:takeoff-catalog-updated';
export function measuresForContext(measures: TakeoffMeasure[], context?: TakeoffContext, linkedMeasureIds: string[] = []): TakeoffMeasure[] {
  if (!context) return measures;
  const linked = new Set(linkedMeasureIds);
  return measures.filter(measure => linked.has(measure.id) || !measure.taskId && !measure.logId || measure.taskId === context.taskId && measure.logId === context.logId);
}
export const scopeKey = (org: string, user: string, project: string) => JSON.stringify([org, user, project]);
export const MEASURE_KINDS: MeasureKind[] = ['count', 'linearLength', 'length', 'circlePerimeter', 'rectangleArea', 'area', 'circleArea', 'verticalArea', 'polygonVolume'];
export const measureCategory = (kind: MeasureKind): 'count' | 'length' | 'area' | 'volume' =>
  kind === 'count' ? 'count' : kind === 'polygonVolume' ? 'volume' :
    ['linearLength', 'length', 'circlePerimeter'].includes(kind) ? 'length' : 'area';
export const minimumPoints = (kind: MeasureKind) => ['area', 'polygonVolume'].includes(kind) ? 3 : kind === 'count' ? 1 : 2;
export const fixedPointCount = (kind: MeasureKind) => ['linearLength', 'circlePerimeter', 'rectangleArea', 'circleArea', 'verticalArea'].includes(kind) ? 2 : null;
export const requiresHeight = (kind: MeasureKind) => kind === 'verticalArea' || kind === 'polygonVolume';
export function measureUnit(kind: MeasureKind, scale: number | null): string {
  if (kind === 'count') return 'un';
  if (scale === null && kind === 'verticalArea') return 'u.d.·m';
  if (scale === null && kind === 'polygonVolume') return 'u.d.²·m';
  const suffix = measureCategory(kind) === 'area' ? '²' : measureCategory(kind) === 'volume' ? '³' : '';
  return scale === null ? `u.d.${suffix}` : `m${suffix}`;
}

export function quantity(kind: MeasureKind, points: Point[], scale: number | null, heightMeters?: number): number | null {
  if (kind === 'count') return points.length;
  const factor = scale ?? 1;
  if (!Number.isFinite(factor) || factor <= 0) return null;
  if (points.length < minimumPoints(kind)) return null;
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  if (kind === 'linearLength') return distance(points[0], points[1]) * factor;
  if (kind === 'circlePerimeter') return 2 * Math.PI * distance(points[0], points[1]) * factor;
  if (kind === 'length') return points.slice(1).reduce((n, p, i) => n + distance(p, points[i]), 0) * factor;
  if (kind === 'rectangleArea') return Math.abs((points[1].x - points[0].x) * (points[1].y - points[0].y)) * factor * factor;
  if (kind === 'circleArea') return Math.PI * distance(points[0], points[1]) ** 2 * factor * factor;
  if (requiresHeight(kind) && (!heightMeters || !Number.isFinite(heightMeters) || heightMeters <= 0)) return null;
  if (kind === 'verticalArea') return distance(points[0], points[1]) * factor * heightMeters!;
  const area = Math.abs(points.reduce((n, p, i) => {
    const next = points[(i + 1) % points.length];
    return n + p.x * next.y - next.x * p.y;
  }, 0)) / 2 * factor * factor;
  return kind === 'polygonVolume' ? area * heightMeters! : area;
}
export function calibration(points: Point[], meters: number): number {
  const distance = points.length === 2 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0;
  if (!Number.isFinite(meters) || meters <= 0 || distance <= 0) throw new Error('Indique dois pontos distintos e uma distância positiva.');
  return meters / distance;
}
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('obraplanner-plan-takeoff', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('scopes');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
async function readLocalTakeoffs(key: string): Promise<TakeoffPlan[]> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('scopes').objectStore('scopes').get(key);
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}
async function saveLocalTakeoffs(key: string, plans: TakeoffPlan[]): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('scopes', 'readwrite');
    transaction.objectStore('scopes').put(plans, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const lastCloudRead = new Map<string, TakeoffPlan[]>();
function planContent(plan: TakeoffPlan): string {
  return JSON.stringify({ name: plan.name, floor: plan.floor, kind: plan.kind,
    chapterId: plan.chapterId, building: plan.building, scales: plan.scales, measures: plan.measures });
}

/** A nuvem e a fonte principal; o IndexedDB continua como cache e copia da migracao. */
export async function readTakeoffs(key: string, options: { migrateLocal?: boolean } = {}): Promise<TakeoffPlan[]> {
  const scope = cloudTakeoffScope(key);
  if (!scope) return readLocalTakeoffs(key);
  const rows = await readCloudPlanRows(scope);
  const local = await readLocalTakeoffs(key).catch(() => [] as TakeoffPlan[]);
  const knownIds = new Set(rows.map(row => row.id));
  if (options.migrateLocal) {
    for (const plan of local) {
      if (knownIds.has(plan.id) || plan.cloudRevision) continue;
      await insertCloudPlan(scope, plan);
      knownIds.add(plan.id);
    }
  }
  const currentRows = options.migrateLocal ? await readCloudPlanRows(scope) : rows;
  const cache = new Map(local.map(plan => [plan.id, plan]));
  const plans = await Promise.all(currentRows.filter(row => !row.deleted_at)
    .map(row => cloudRowToPlan(row, cache.get(row.id))));
  lastCloudRead.set(key, plans);
  // Falta de espaco local nao invalida a gravacao ja confirmada no servidor.
  if (options.migrateLocal || local.every(plan => knownIds.has(plan.id) || !!plan.cloudRevision)) {
    void saveLocalTakeoffs(key, plans).catch(() => undefined);
  }
  return plans;
}

/** Grava so a planta alterada; nunca substitui o catalogo de outro usuario. */
export async function saveTakeoffs(key: string, plans: TakeoffPlan[], previous = lastCloudRead.get(key) ?? []): Promise<void> {
  const scope = cloudTakeoffScope(key);
  if (!scope) return saveLocalTakeoffs(key, plans);
  const before = new Map(previous.map(plan => [plan.id, plan]));
  const after = new Map(plans.map(plan => [plan.id, plan]));
  const changes = [
    ...plans.filter(plan => !before.has(plan.id) || planContent(plan) !== planContent(before.get(plan.id)!)),
    ...previous.filter(plan => !after.has(plan.id)),
  ];
  if (changes.length > 1) throw new Error('Uma operação alterou várias plantas. Reabra o catálogo e altere uma planta por vez.');
  const changed = changes[0];
  if (!changed) return;
  const old = before.get(changed.id);
  if (!after.has(changed.id)) await archiveCloudPlan(scope, changed);
  else if (old) await updateCloudPlan(scope, changed, old);
  else await insertCloudPlan(scope, changed);
  lastCloudRead.set(key, plans);
  await saveLocalTakeoffs(key, plans).catch(() => undefined);
}

/** Atualiza o catalogo a partir da versao mais recente. */
export async function updateTakeoffs(key: string, edit: (plans: TakeoffPlan[]) => TakeoffPlan[]): Promise<TakeoffPlan[]> {
  if (cloudTakeoffScope(key)) {
    const current = await readTakeoffs(key, { migrateLocal: true });
    const next = edit(current);
    await saveTakeoffs(key, next, current);
    return next;
  }
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('scopes', 'readwrite');
    const store = transaction.objectStore('scopes');
    let next: TakeoffPlan[] = [];
    const request = store.get(key);
    request.onsuccess = () => {
      try { next = edit(request.result ?? []); store.put(next, key); }
      catch (error) { transaction.abort(); reject(error); }
    };
    transaction.oncomplete = () => resolve(next);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
