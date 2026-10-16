import type { Project } from '@/types/project';

/** Keep the values seen when editing started only for records the form submits.
 * Remote changes in other records/domains must not become part of this operation. */
export function warehouseEditBaseline(original: Project, current: Project, edited: Project): Project {
  if (original.id !== current.id || edited.id !== current.id) throw new Error('A tentativa pertence a outra obra.');
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const prior = original.warehouse as unknown as Record<string, unknown>;
  const live = current.warehouse as unknown as Record<string, unknown>;
  const proposed = edited.warehouse as unknown as Record<string, unknown>;
  if (!prior || !live || !proposed) return current;
  const warehouse = { ...live };
  for (const key of Object.keys(proposed)) {
    if (same(live[key], proposed[key])) continue;
    const before = prior[key], now = live[key], next = proposed[key];
    if (Array.isArray(before) && Array.isArray(now) && Array.isArray(next)) {
      const identity = ['id', 'key'].find(field => [...before, ...now, ...next].every(row => row && typeof row[field] === 'string'));
      if (identity) {
        const old = new Map(before.map(row => [row[identity], row]));
        const a = new Map(now.map(row => [row[identity], row]));
        const b = new Map(next.map(row => [row[identity], row]));
        for (const id of new Set([...a.keys(), ...b.keys()])) {
          if (same(a.get(id), b.get(id))) continue;
          if (old.has(id)) a.set(id, old.get(id)); else a.delete(id);
        }
        warehouse[key] = [...a.values()];
        continue;
      }
    }
    warehouse[key] = before;
  }
  return { ...current, warehouse: warehouse as unknown as Project['warehouse'] };
}
