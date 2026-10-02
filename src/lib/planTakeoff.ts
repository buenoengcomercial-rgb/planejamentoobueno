export interface Point { x: number; y: number }
export type MeasureKind = 'count' | 'length' | 'area';
export interface TakeoffMeasure { id: string; name: string; kind: MeasureKind; page: number; points: Point[] }
export interface TakeoffPlan {
  id: string; name: string; floor: string; kind: 'pdf' | 'image' | 'dxf'; file: Blob;
  scales: Record<number, number>; measures: TakeoffMeasure[];
}
export const scopeKey = (org: string, user: string, project: string) => JSON.stringify([org, user, project]);
export function quantity(kind: MeasureKind, points: Point[], scale: number | null): number | null {
  if (kind === 'count') return points.length;
  if (!scale || !Number.isFinite(scale) || scale <= 0) return null;
  if (kind === 'length') return points.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0) * scale;
  return Math.abs(points.reduce((n, p, i) => {
    const next = points[(i + 1) % points.length];
    return n + p.x * next.y - next.x * p.y;
  }, 0)) / 2 * scale * scale;
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
export async function readTakeoffs(key: string): Promise<TakeoffPlan[]> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('scopes').objectStore('scopes').get(key);
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}
export async function saveTakeoffs(key: string, plans: TakeoffPlan[]): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('scopes', 'readwrite');
    transaction.objectStore('scopes').put(plans, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
