import type { AdditiveComposition, BudgetItem, Project } from '@/types/project';

export const ANALYTIC_LINK_SCHEMA_VERSION = 2 as const;

export type AnalyticResolutionSource = 'own' | 'base_id' | 'task' | 'item_code' | 'none';

export interface AnalyticResolution {
  composition?: AdditiveComposition;
  source: AnalyticResolutionSource;
  inherited: boolean;
}

type AnalyticReference = Partial<Pick<
  AdditiveComposition,
  | 'id'
  | 'item'
  | 'itemNumber'
  | 'code'
  | 'bank'
  | 'description'
  | 'inputs'
  | 'taskId'
  | 'linkedTaskId'
  | 'baseBudgetItemId'
  | 'baseAnalyticCompositionId'
  | 'baseTaskId'
  | 'isNewService'
>>;

export function normalizeAnalyticCode(value?: string | null): string {
  const compact = (value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return compact.replace(/^([A-Z]+)0+(\d+)$/, '$1$2');
}

export function normalizeAnalyticItem(value?: string | null): string {
  return (value ?? '')
    .trim()
    .replace(',', '.')
    .split('.')
    .filter(Boolean)
    .map(part => /^\d+$/.test(part) ? String(Number(part)) : part.toUpperCase())
    .join('.');
}

function hasInputs(composition: AdditiveComposition | undefined): composition is AdditiveComposition {
  return !!composition?.inputs?.length;
}

function itemOf(reference: AnalyticReference): string {
  return reference.itemNumber || reference.item || '';
}

function uniqueMatch(
  pool: AdditiveComposition[],
  predicate: (composition: AdditiveComposition) => boolean,
): AdditiveComposition | undefined {
  const matches = pool.filter(composition => hasInputs(composition) && predicate(composition));
  return matches.length === 1 ? matches[0] : undefined;
}

function budgetForReference(project: Project, reference: AnalyticReference): BudgetItem | undefined {
  const budgets = project.budgetItems ?? [];
  if (reference.baseBudgetItemId) {
    const direct = budgets.find(item => item.id === reference.baseBudgetItemId);
    if (direct) return direct;
  }
  const taskId = reference.baseTaskId || reference.linkedTaskId || reference.taskId;
  if (taskId) {
    const byTask = budgets.filter(item => item.taskId === taskId);
    if (byTask.length === 1) return byTask[0];
  }
  const item = normalizeAnalyticItem(itemOf(reference));
  const code = normalizeAnalyticCode(reference.code);
  const byKey = budgets.filter(candidate =>
    normalizeAnalyticItem(candidate.item) === item
    && normalizeAnalyticCode(candidate.code) === code,
  );
  return byKey.length === 1 ? byKey[0] : undefined;
}

/**
 * Resolve exclusivamente os insumos Analiticos. Os valores financeiros continuam
 * pertencendo a linha contratual/aditiva recebida pelo modulo consumidor.
 */
export function resolveAnalyticComposition(
  project: Project,
  reference: AnalyticReference | undefined,
): AnalyticResolution {
  if (!reference) return { source: 'none', inherited: false };
  if (reference.inputs?.length) {
    return { composition: reference as AdditiveComposition, source: 'own', inherited: false };
  }

  const base = (project.analyticCompositions ?? []).filter(hasInputs);
  if (reference.baseAnalyticCompositionId) {
    const direct = base.find(composition => composition.id === reference.baseAnalyticCompositionId);
    if (direct) return { composition: direct, source: 'base_id', inherited: true };
  }

  const taskIds = [reference.baseTaskId, reference.linkedTaskId, reference.taskId].filter(Boolean) as string[];
  for (const taskId of taskIds) {
    const byTask = uniqueMatch(base, composition =>
      composition.taskId === taskId || composition.linkedTaskId === taskId,
    );
    if (byTask) return { composition: byTask, source: 'task', inherited: true };
  }

  const budget = budgetForReference(project, reference);
  if (budget?.taskId) {
    const byBudgetTask = uniqueMatch(base, composition =>
      composition.taskId === budget.taskId || composition.linkedTaskId === budget.taskId,
    );
    if (byBudgetTask) return { composition: byBudgetTask, source: 'task', inherited: true };
  }

  // Novo servico exige Analitica propria; nunca herda por coincidencia textual.
  if (reference.isNewService) return { source: 'none', inherited: false };

  const item = normalizeAnalyticItem(budget?.item || itemOf(reference));
  const code = normalizeAnalyticCode(budget?.code || reference.code);
  if (item && code) {
    const byNaturalKey = uniqueMatch(base, composition =>
      normalizeAnalyticItem(itemOf(composition)) === item
      && normalizeAnalyticCode(composition.code) === code,
    );
    if (byNaturalKey) return { composition: byNaturalKey, source: 'item_code', inherited: true };
  }

  return { source: 'none', inherited: false };
}

export function compositionWithResolvedInputs(
  project: Project,
  composition: AdditiveComposition,
): { composition: AdditiveComposition; resolution: AnalyticResolution } {
  const resolution = resolveAnalyticComposition(project, composition);
  if (!resolution.composition || resolution.composition === composition) return { composition, resolution };
  return {
    composition: { ...composition, inputs: resolution.composition.inputs },
    resolution,
  };
}

export interface AnalyticLinkRepairResult {
  project: Project;
  changed: boolean;
  linked: number;
  unresolved: number;
}

/** Idempotente e sem qualquer recalculo de preco, BDI, quantidade ou total. */
export function repairProjectAnalyticLinks(project: Project): AnalyticLinkRepairResult {
  let changed = project.analyticLinkSchemaVersion !== ANALYTIC_LINK_SCHEMA_VERSION;
  let linked = 0;
  let unresolved = 0;
  const additives = (project.additives ?? []).map(additive => ({
    ...additive,
    compositions: (additive.compositions ?? []).map(composition => {
      const budget = budgetForReference(project, composition);
      const resolution = resolveAnalyticComposition(project, {
        ...composition,
        // O identificador-base nunca aponta para a propria revisao Analitica do Aditivo.
        inputs: [],
        baseBudgetItemId: composition.baseBudgetItemId || budget?.id,
        baseTaskId: composition.baseTaskId || budget?.taskId,
      });
      if (!resolution.composition) {
        unresolved += 1;
        return composition;
      }
      linked += 1;
      const next = {
        ...composition,
        baseBudgetItemId: composition.baseBudgetItemId || budget?.id,
        baseTaskId: composition.baseTaskId || budget?.taskId || composition.linkedTaskId || composition.taskId,
        baseAnalyticCompositionId: composition.baseAnalyticCompositionId || resolution.composition.id,
      };
      if (
        next.baseBudgetItemId !== composition.baseBudgetItemId
        || next.baseTaskId !== composition.baseTaskId
        || next.baseAnalyticCompositionId !== composition.baseAnalyticCompositionId
      ) changed = true;
      return next;
    }),
  }));

  return {
    project: changed
      ? { ...project, additives, analyticLinkSchemaVersion: ANALYTIC_LINK_SCHEMA_VERSION }
      : project,
    changed,
    linked,
    unresolved,
  };
}
