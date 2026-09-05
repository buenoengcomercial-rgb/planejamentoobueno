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
  withdrawnQuantity: number;
}

export interface WarehouseBudgetMaterialChapter {
  id: string;
  number: string;
  name: string;
  rows: WarehouseBudgetMaterialRow[];
}

const round = (value: number) => Math.round(value * 100) / 100;
function active(additive: Additive) {
  return !['rejeitado', 'reprovado', 'cancelado'].includes(additive.status ?? 'rascunho');
}

function contracted(additive: Additive) {
  return additive.isContracted === true || additive.status === 'contratado' || additive.status === 'aditivo_contratado';
}

function quantityChanges(composition: AdditiveComposition) {
  const suppressed = Math.max(0, composition.suppressedQuantity ?? 0);
  if (composition.isNewService) {
    const added = Math.max(0, composition.addedQuantity ?? composition.quantity ?? 0);
    return { added, suppressed, net: added - suppressed };
  }
  if (composition.addedQuantity != null || composition.suppressedQuantity != null) {
    const added = Math.max(0, composition.addedQuantity ?? 0);
    return { added, suppressed, net: added - suppressed };
  }
  if (composition.changeKind === 'acrescido') {
    const added = Math.max(0, composition.quantity ?? 0);
    return { added, suppressed: 0, net: added };
  }
  if (composition.changeKind === 'suprimido') {
    const removed = Math.max(0, composition.quantity ?? 0);
    return { added: 0, suppressed: removed, net: -removed };
  }
  return { added: 0, suppressed: 0, net: 0 };
}

function materialIdentity(code: string | undefined, description: string, unit: string) {
  const normalizedCode = normalizeAnalyticCode(code);
  if (normalizedCode) return `code:${normalizedCode}|unit:${unit.trim().toLocaleUpperCase('pt-BR')}`;
  return `description:${description.trim().replace(/\s+/g, ' ').toLocaleUpperCase('pt-BR')}|unit:${unit.trim().toLocaleUpperCase('pt-BR')}`;
}

function chapterResolver(project: Project) {
  const phases = new Map((project.phases ?? []).map(phase => [phase.id, phase]));
  const chapterId = (number: string, fallback: string) => {
    const principalNumber = number.trim().split('.')[0];
    return principalNumber ? `chapter:${principalNumber}` : fallback;
  };
  const root = (phaseId?: string) => {
    let phase = phaseId ? phases.get(phaseId) : undefined;
    while (phase?.parentId) phase = phases.get(phase.parentId) ?? phase;
    if (!phase) return undefined;
    const number = phase.customNumber || '';
    return { id: chapterId(number, phase.id), number, name: phase.name };
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
    return budget.chapterCode ? {
      id: chapterId(budget.chapterCode, `budget:${budget.chapterCode}`),
      number: budget.chapterCode,
      name: budget.chapterName || `Capítulo ${budget.chapterCode}`,
    } : undefined;
  };
  return (composition: AdditiveComposition) => root(composition.phaseId) || fromBudget(composition) || { id: '__unlinked__', number: '', name: 'Sem capítulo vinculado' };
}

export function warehouseBudgetMaterialsByChapter(project: Project): WarehouseBudgetMaterialChapter[] {
  const chapterOf = chapterResolver(project);
  const chapters = new Map<string, WarehouseBudgetMaterialChapter>();
  const add = (composition: AdditiveComposition, quantity: number, source: 'contracted' | 'additive') => {
    if (!quantity) return;
    const chapter = chapterOf(composition);
    const bucket = chapters.get(chapter.id) ?? { ...chapter, rows: [] };
    chapters.set(chapter.id, bucket);
    const resolved = compositionWithResolvedInputs(project, composition).composition;
    for (const input of resolved.inputs ?? []) {
      if (resolveMaterialCostClass(project, { code: input.code, description: input.description, unit: input.unit, sourceId: input.id, sourceType: source === 'additive' ? 'additive_input' : 'analytic_input', legacyInputType: input.type }) !== 'material') continue;
      const amount = round((Number(input.coefficient) || 0) * quantity);
      if (!amount) continue;
      const key = `${input.bank || ''}|${input.code || ''}|${input.description.trim().toLocaleUpperCase('pt-BR')}|${input.unit}`;
      let row = bucket.rows.find(item => item.key === key);
      if (!row) {
        row = { key, code: input.code || undefined, bank: input.bank || undefined, description: input.description, unit: input.unit, contractedQuantity: 0, withdrawnQuantity: 0 };
        bucket.rows.push(row);
      }
      row.contractedQuantity = round(row.contractedQuantity + amount);
    }
  };

  for (const composition of project.analyticCompositions ?? []) {
    const contractedQuantity = Math.max(0, composition.quantity || 0);
    add(composition, contractedQuantity, 'contracted');
  }
  for (const additive of (project.additives ?? []).filter(active)) {
    for (const composition of additive.compositions ?? []) {
      const changes = quantityChanges(composition);
      // Supressões ajustam imediatamente o contratado vigente. Acréscimos só
      // passam a integrá-lo após a contratação formal do aditivo.
      add(composition, -changes.suppressed + (contracted(additive) ? changes.added : 0), 'additive');
    }
  }
  const normalizedChapters = [...chapters.values()].map(chapter => ({ ...chapter, rows: chapter.rows
    .filter(row => row.contractedQuantity > 0) }));

  const phaseById = new Map((project.phases ?? []).map(phase => [phase.id, phase] as const));
  const rootChapterId = (phaseId: string) => {
    let phase = phaseById.get(phaseId);
    while (phase?.parentId) phase = phaseById.get(phase.parentId) ?? phase;
    if (!phase) return phaseId;
    const number = phase.customNumber?.trim() || '';
    return number ? `chapter:${number.split('.')[0]}` : phase.id;
  };
  const rowsByChapterAndIdentity = new Map<string, WarehouseBudgetMaterialRow>();
  for (const chapter of normalizedChapters) {
    for (const row of chapter.rows) rowsByChapterAndIdentity.set(`${chapter.id}|${materialIdentity(row.code, row.description, row.unit)}`, row);
  }
  const linksByWarehouseItem = new Map<string, Array<{ code?: string; description: string; unit: string; factor: number }>>();
  for (const link of project.warehouse?.materialLinks ?? []) {
    const links = linksByWarehouseItem.get(link.warehouseItemKey) ?? [];
    links.push({ code: link.projectMaterialCode, description: link.projectMaterialDescription, unit: link.projectMaterialUnit, factor: Number(link.conversionFactor) || 1 });
    linksByWarehouseItem.set(link.warehouseItemKey, links);
  }
  const requisitionsById = new Map((project.warehouse?.requisitions ?? []).map(requisition => [requisition.id, requisition] as const));
  for (const movement of project.warehouse?.movements ?? []) {
    if (movement.type !== 'retirada' || movement.reversedById || !movement.requisitionId) continue;
    const requisition = requisitionsById.get(movement.requisitionId);
    if (requisition?.status !== 'entregue' || !requisition.chapterId) continue;
    const chapterId = rootChapterId(requisition.chapterId);
    const linked = linksByWarehouseItem.get(movement.itemKey) ?? [{ code: movement.itemCode, description: movement.itemDescription, unit: movement.itemUnit, factor: 1 }];
    for (const material of linked) {
      const row = rowsByChapterAndIdentity.get(`${chapterId}|${materialIdentity(material.code, material.description, material.unit)}`);
      if (!row) continue;
      row.withdrawnQuantity = round(row.withdrawnQuantity + (Number(movement.quantity) || 0) * material.factor);
    }
  }

  return normalizedChapters
    .map(chapter => ({ ...chapter, rows: chapter.rows
      .sort((a, b) => a.description.localeCompare(b.description, 'pt-BR')) }))
    .filter(chapter => chapter.rows.length > 0)
    .sort((a, b) => a.id === '__unlinked__' ? 1 : b.id === '__unlinked__' ? -1 : a.number.localeCompare(b.number, 'pt-BR', { numeric: true }));
}
