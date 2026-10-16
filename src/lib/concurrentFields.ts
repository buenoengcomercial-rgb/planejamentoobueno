/** Three-way field merge. A real collision keeps the server value and reports its path.
 * Callers must preserve the original local attempt whenever conflicts is nonempty. */
export function mergeConcurrentFields<T>(base: T, local: T, remote: T): { value: T; conflicts: string[] } {
  const conflicts: string[] = [];
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_key, v) => record(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
  function merge(before: unknown, proposed: unknown, confirmed: unknown, path: string): unknown {
    if (same(proposed, before)) return confirmed;
    if (same(confirmed, before) || same(proposed, confirmed)) return proposed;
    if (record(before) && record(proposed) && record(confirmed)) {
      return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(proposed), ...Object.keys(confirmed)])]
        .flatMap(key => {
          const value = merge(before[key], proposed[key], confirmed[key], `${path}/${key}`);
          return value === undefined ? [] : [[key, value]];
        }));
    }
    if (Array.isArray(before) && Array.isArray(proposed) && Array.isArray(confirmed)) {
      const identity = ['id', 'key'].find(key => [before, proposed, confirmed].every(rows =>
        rows.every(row => record(row) && typeof row[key] === 'string' && row[key] !== '')
        && new Set(rows.map(row => row[key])).size === rows.length));
      if (identity) {
        const b = new Map(before.map(row => [row[identity], row]));
        const p = new Map(proposed.map(row => [row[identity], row]));
        const c = new Map(confirmed.map(row => [row[identity], row]));
        const common = new Set([...b.keys()].filter(id => p.has(id) && c.has(id)));
        const order = (rows: Map<unknown, unknown>) => [...rows.keys()].filter(id => common.has(id));
        const localReordered = !same(order(b), order(p));
        const remoteReordered = !same(order(b), order(c));
        if (localReordered && remoteReordered && !same(order(p), order(c))) conflicts.push(`${path}/$order`);
        const first = localReordered && !remoteReordered ? p : c;
        const second = first === p ? c : p;
        return [...new Set([...first.keys(), ...second.keys(), ...b.keys()])].flatMap(id => {
          const value = merge(b.get(id), p.get(id), c.get(id), `${path}/${id}`);
          return value === undefined ? [] : [value];
        });
      }
    }
    conflicts.push(path || '/');
    return confirmed;
  }
  return { value: merge(base, local, remote, '') as T, conflicts };
}
