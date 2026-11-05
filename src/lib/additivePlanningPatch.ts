/** Only planning fields may be sent as a partial additive row. */
export function additivePlanningPatch(before: unknown, after: unknown): {
  expected: Record<string, unknown>;
  row: Record<string, unknown>;
} | null {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object'
    || Array.isArray(before) || Array.isArray(after)) return null;
  const oldRow = before as Record<string, unknown>;
  const newRow = after as Record<string, unknown>;
  const planning = new Set(['scheduleDraft', 'scheduleSnapshots']);
  const keys = new Set([...Object.keys(oldRow), ...Object.keys(newRow)]);
  if ([...keys].some(key => !planning.has(key) && JSON.stringify(oldRow[key]) !== JSON.stringify(newRow[key]))) return null;
  const changed = [...planning].filter(key => JSON.stringify(oldRow[key]) !== JSON.stringify(newRow[key]));
  if (!changed.length) return null;
  return {
    expected: Object.fromEntries(changed.filter(key => key in oldRow).map(key => [key, oldRow[key]])),
    row: Object.fromEntries(changed.filter(key => key in newRow).map(key => [key, newRow[key]])),
  };
}
