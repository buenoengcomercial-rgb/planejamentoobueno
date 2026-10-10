import type { MeasurementWorkspace } from './measurementWorkspace';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';

/** Only entry changes qualify. Contract, periods, drawings and old audits never
 * travel through this path or get reconstructed from a partial local copy. */
export function measurementEntryPatch(previous: MeasurementWorkspace | null, candidate: MeasurementWorkspace) {
  if (!previous || previous.revision + 1 !== candidate.revision) return null;
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
