import type { TakeoffCatalogPlan } from './planTakeoff';

const comparable = (value: unknown) => JSON.stringify(value, (_key, item) => {
  if (item instanceof Blob) return undefined;
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const object = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
  }
  return item;
});

/** Rebase only a pure new-drawing addition on the latest confirmed catalog. */
export function reconcileDrawingCatalog(current: TakeoffCatalogPlan[], previous: TakeoffCatalogPlan[], next: TakeoffCatalogPlan[]): TakeoffCatalogPlan[] {
  const previousIds = new Set(previous.map(plan => plan.id));
  const added = next.filter(plan => !previousIds.has(plan.id));
  const pureAddition = added.length === 1 && next.length === previous.length + 1
    && previous.every(plan => {
      const proposed = next.find(item => item.id === plan.id);
      return proposed && comparable(proposed) === comparable(plan);
    });
  if (!pureAddition) {
    if (comparable(current) !== comparable(previous)) throw new Error('As plantas mudaram. Reabra o visualizador antes de editar ou apagar uma planta.');
    return next;
  }
  const incoming = added[0];
  const existing = current.find(plan => plan.id === incoming.id);
  if (existing) {
    if (existing.name !== incoming.name || existing.chapterId !== incoming.chapterId || existing.kind !== incoming.kind) {
      throw new Error('O cadastro desta planta mudou. Reabra o visualizador.');
    }
    return current;
  }
  if (current.some(plan => plan.chapterId === incoming.chapterId && plan.name.toLocaleLowerCase() === incoming.name.toLocaleLowerCase())) {
    throw new Error('Esta prancha já está cadastrada neste prédio.');
  }
  return [...current, incoming];
}
