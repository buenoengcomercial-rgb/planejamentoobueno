import { catalogValue } from './measurementPlanCatalogPatch';
import type { MeasurementWorkspace } from './measurementWorkspace';

const same = (a: unknown, b: unknown) => a === b || catalogValue(a) === catalogValue(b);

export function measurementAdditiveCatalogPatch(base: MeasurementWorkspace, next: MeasurementWorkspace) {
  const event = next.audit.at(-1);
  if (!event?.action.startsWith('Incorporar aditivo ') || next.revision !== base.revision + 1
    || next.audit.length !== base.audit.length + 1 || event.before.length || event.after.length
    || event.affected.length || !event.beforeServices || !event.afterServices) return null;
  const { beforeServices, afterServices, ...header } = event;
  const { services, importedKeys } = next;
  for (const key of ['schema', 'projectId', 'projectName', 'contract', 'periods', 'entries', 'plans', 'backupId'] as const) {
    if (!same(next[key], base[key])) return null;
  }
  if (!base.audit.every((previous, index) => same(previous, next.audit[index]))
    || !same(beforeServices, base.services) || !same(afterServices, services)
    || same(importedKeys, base.importedKeys)) return null;

  const byId = new Map(base.services.map(service => [service.id, service]));
  const periods = new Set(services.flatMap(service => {
    const prior = byId.get(service.id);
    if (!prior) return [service.availableFromNumber];
    if (same(prior, service)) return [];
    return [service.additiveAdjustments?.at(-1)?.firstNumber];
  }));
  const firstNumber = periods.values().next().value;
  if (periods.size !== 1 || firstNumber === undefined || !Number.isSafeInteger(firstNumber)) return null;
  return { firstNumber, payload: { services, importedKeys, event: header } };
}
