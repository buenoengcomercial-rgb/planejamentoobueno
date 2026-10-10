import type { MeasurementWorkspace } from './measurementWorkspace';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';

/** Only entry changes qualify. Contract, periods, drawings and old audits never
 * travel through this path or get reconstructed from a partial local copy. */
export function measurementEntryPatch(previous: MeasurementWorkspace | null, candidate: MeasurementWorkspace) {
  if (!previous || previous.revision + 1 !== candidate.revision) return null;
  // Point edits keep the immutable catalog, plans, periods and older audit
  // events by reference. In this common path encode only the changed entries
  // and one event; serializing the whole 5 MB workspace on every cell blur is
  // unnecessary and blocks the next task in the browser main thread.
  if (candidate.schema === previous.schema && candidate.projectId === previous.projectId
    && candidate.projectName === previous.projectName && candidate.backupId === previous.backupId
    && candidate.contract === previous.contract && candidate.services === previous.services
    && candidate.periods === previous.periods && candidate.plans === previous.plans
    && candidate.importedKeys === previous.importedKeys
    && candidate.audit.length === previous.audit.length + 1
    && previous.audit.every((event, index) => candidate.audit[index] === event)) {
    const key = (entry: typeof previous.entries[number]) => `${entry.measurementId}:${entry.serviceId}`;
    const prior = new Map(previous.entries.map(entry => [key(entry), entry]));
    if (previous.entries.some(entry => !candidate.entries.some(next => next.measurementId === entry.measurementId && next.serviceId === entry.serviceId))) return null;
    const changed = candidate.entries.filter(entry => entry !== prior.get(key(entry)));
    if (changed.length && candidate.entries.length === previous.entries.length + changed.filter(entry => !prior.has(`${entry.measurementId}:${entry.serviceId}`)).length
      && new Set(candidate.entries.map(key)).size === candidate.entries.length
      && previous.entries.every((entry, index) => key(candidate.entries[index]) === key(entry))
      && candidate.entries.slice(previous.entries.length).every(entry => !prior.has(key(entry)))) {
      return { entries: JSON.parse(JSON.stringify(changed)), event: JSON.parse(JSON.stringify(candidate.audit.at(-1)!)) };
    }
  }
  const before = encodeMeasurementWorkspace(previous) as Record<string, unknown>;
  const after = encodeMeasurementWorkspace(candidate) as Record<string, unknown>;
  // JSONB sorts object keys on reload. Ordering of arrays is meaningful; ordering
  // of object keys is not. A JSON round trip also omits optional undefined fields.
  const canonical = (value: unknown) => JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  if (Object.keys({ ...before, ...after }).some(k => !['revision', 'entries', 'audit'].includes(k) && !equal(before[k], after[k]))) return null;
  if (candidate.audit.length !== previous.audit.length + 1 || !equal(previous.audit, candidate.audit.slice(0, -1))) return null;
  if (previous.entries.some(e => !candidate.entries.some(n => n.measurementId === e.measurementId && n.serviceId === e.serviceId))) return null;
  const entries = candidate.entries.filter(e => !equal(e, previous.entries.find(n => n.measurementId === e.measurementId && n.serviceId === e.serviceId)));
  if (!entries.length) return null;
  const rebuilt = previous.entries.map(e => entries.find(n => n.measurementId === e.measurementId && n.serviceId === e.serviceId) ?? e);
  rebuilt.push(...entries.filter(e => !previous.entries.some(n => n.measurementId === e.measurementId && n.serviceId === e.serviceId)));
  if (!equal(rebuilt, candidate.entries)) return null;
  return { entries, event: candidate.audit.at(-1)! };
}
