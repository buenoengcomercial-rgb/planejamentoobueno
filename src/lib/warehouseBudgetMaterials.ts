import type { Additive, AdditiveComposition, Project } from '@/types/project';
import { compositionWithResolvedInputs, normalizeAnalyticCode, normalizeAnalyticItem } from '@/lib/analyticLinks';
import { resolveMaterialCostClass } from '@/lib/materialComparisons';

export interface WarehouseBudgetMaterialRow {
  key: string;
  code?: string;
  bank?: string;
  description: string;
  unit: string;
  contractedQuantity: number;
  additiveQuantity: number;
  totalQuantity: number;
  additiveStatuses: string[];
}

export interface WarehouseBudgetMaterialChapter {
  id: string;
  number: string;
  name: string;
  rows: WarehouseBudgetMaterialRow[];
}

const round = (value: number) => Math.round(value * 100) / 100;
const additiveStatusLabel: Record<string, string> = {
  rascunho: 'Rascunho', em_analise: 'Em análise', aprovado: 'Aprovado',
  contratado: 'Contratado', aditivo_contratado: 'Contratado',
};

function active(additive: Additive) {
  return !['rejeitado', 'reprovado', 'cancelado'].includes(additive.status ?? 'rascunho');
}

function delta(composition: AdditiveComposition) {
  const suppressed = Math.max(0, composition.suppressedQuantity ?? 0);
  if (composition.isNewService) return Math.max(0, composition.addedQuantity ?? composition.quantity ?? 0) - suppressed;
  if (composition.addedQuantity != null || composition.suppressedQuantity != null) return Math.max(0, composition.addedQuantity ?? 0) - suppressed;
  if (composition.changeKind === 'acrescido') return Math.max(0, composition.quantity ?? 0);
  if (composition.changeKind === 'suprimido') return -Math.max(0, composition.quantity ?? 0);
  return 0;
}

function chapterResolver(project: Project) {
  const phases = new Map((project.phases ?? []).map(phase => [phase.id, phase]));
  const root = (phaseId?: string) => {
    let phase = phaseId ? phases.get(phaseId) : undefined;
    while (phase?.parentId) phase = phases.get(phase.parentId) ?? phase;
    if (!phase) return undefined;
    return { id: phase.id, number: phase.customNumber || '', name: phase.name };
  };
  const fromBudget = (composition: AdditiveComposition) => {
    const budgets = project.budgetItems ?? [];
    const direct = composition.baseBudgetItemId ? budgets.find(item => item.id === composition.baseBudgetItemId) : undefined;
    const item = normalizeAnalyticItem(composition.itemNumber || composition.item);
    const code = normalizeAnalyticCode(composition.code);
    const candidates = direct ? [direct] : budgets.filter(candidate =>
      normalizeAnalyticItem(candidate.item) === item && normalizeAnalyticCode(candidate.code) === code,
    );
    if (candidates.length !== 1) return undefined;
    const budget = candidates[0];
    return budget.chapterCode ? { id: `budget:${budget.chapterCode}`, number: budget.chapterCode, name: budget.chapterName || `Capítulo ${budget.chapterCode}` } : undefined;
  };
  return (composition: AdditiveComposition) => root(composition.phaseId) || fromBudget(composition) || { id: '__unlinked__', number: '', name: 'Sem capítulo vinculado' };
}

export function warehouseBudgetMaterialsByChapter(project: Project): WarehouseBudgetMaterialChapter[] {
  const chapterOf = chapterResolver(project);
  const chapters = new Map<string, WarehouseBudgetMaterialChapter>();
  const add = (composition: AdditiveComposition, quantity: number, kind: 'contracted' | 'additive', status?: string) => {
    if (!quantity) return;
    const chapter = chapterOf(composition);
    const bucket = chapters.get(chapter.id) ?? { ...chapter, rows: [] };
    chapters.set(chapter.id, bucket);
    const resolved = compositionWithResolvedInputs(project, composition).composition;
    for (const input of resolved.inputs ?? []) {
      if (resolveMaterialCostClass(project, { code: input.code, description: input.description, unit: input.unit, sourceId: input.id, sourceType: kind === 'additive' ? 'additive_input' : 'analytic_input', legacyInputType: input.type }) !== 'material') continue;
      const amount = round((Number(input.coefficient) || 0) * quantity);
      if (!amount) continue;
      const key = `${input.bank || ''}|${input.code || ''}|${input.description.trim().toLocaleUpperCase('pt-BR')}|${input.unit}`;
      let row = bucket.rows.find(item => item.key === key);
      if (!row) {
        row = { key, code: input.code || undefined, bank: input.bank || undefined, description: input.description, unit: input.unit, contractedQuantity: 0, additiveQuantity: 0, totalQuantity: 0, additiveStatuses: [] };
        bucket.rows.push(row);
      }
      if (kind === 'contracted') row.contractedQuantity = round(row.contractedQuantity + amount);
      else {
        row.additiveQuantity = round(row.additiveQuantity + amount);
        if (amount > 0 && status && !row.additiveStatuses.includes(status)) row.additiveStatuses.push(status);
      }
    }
  };

  for (const composition of project.analyticCompositions ?? []) add(composition, Math.max(0, composition.quantity || 0), 'contracted');
  for (const additive of (project.additives ?? []).filter(active)) {
    const status = additiveStatusLabel[additive.status ?? 'rascunho'] ?? 'Com aditivo';
    for (const composition of additive.compositions ?? []) add(composition, delta(composition), 'additive', status);
  }
  return [...chapters.values()]
    .map(chapter => ({ ...chapter, rows: chapter.rows
      .map(row => ({ ...row, totalQuantity: round(row.contractedQuantity + row.additiveQuantity) }))
      .filter(row => row.totalQuantity > 0)
      .sort((a, b) => a.description.localeCompare(b.description, 'pt-BR')) }))
    .filter(chapter => chapter.rows.length > 0)
    .sort((a, b) => a.id === '__unlinked__' ? 1 : b.id === '__unlinked__' ? -1 : a.number.localeCompare(b.number, 'pt-BR', { numeric: true }));
}
