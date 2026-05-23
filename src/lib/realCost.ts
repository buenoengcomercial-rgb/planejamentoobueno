import type {
  Additive,
  AdditiveComposition,
  AdditiveInput,
  AdditiveStatus,
  BudgetItem,
  ComparisonItem,
  ComparisonItemPrice,
  MaterialComparison,
  Project,
  Task,
} from '@/types/project';
import { buildOrderedTasks } from '@/components/measurement/measurementFormat';
import { getWorkEndDate } from '@/components/gantt/utils';
import { additiveTotals, computeAdditiveRow } from '@/lib/additiveImport';
import { getChapterNumbering, getChapterTree, type ChapterNode } from '@/lib/chapters';
import { money2, trunc2 } from '@/lib/financialEngine';

export type RealCostSignal = 'healthy' | 'attention' | 'danger' | 'incomplete';

export interface RealCostPriceSource {
  unitPrice: number;
  supplierId?: string;
  supplierName: string;
  comparisonId: string;
  comparisonName: string;
  date?: string;
}

export interface RealCostInputRow {
  id: string;
  code?: string;
  bank?: string;
  description: string;
  unit: string;
  coefficient: number;
  totalQuantity: number;
  referenceUnitPrice: number;
  referenceTotal: number;
  realUnitPrice?: number;
  realTotal: number;
  grossProfit: number;
  marginPct: number;
  priceSource?: RealCostPriceSource;
  status: 'quoted' | 'missing';
}

export interface RealCostCompositionRow {
  id: string;
  item: string;
  code?: string;
  bank?: string;
  description: string;
  unit: string;
  quantity: number;
  quantityContracted: number;
  quantitySuppressed: number;
  quantityAdded: number;
  quantityFinal: number;
  unitPriceReference: number;
  unitPriceContracted: number;
  valueSuppressed: number;
  valueAdded: number;
  chapterId: string;
  chapter: string;
  taskId?: string;
  taskName?: string;
  source: 'contract' | 'additive' | 'analytic';
  sourceName: string;
  sourceStatus?: string;
  sourceDetail?: string;
  contractedValue: number;
  realCost: number;
  grossProfit: number;
  marginPct: number;
  signal: RealCostSignal;
  missingQuoteCount: number;
  hasAnalytic: boolean;
  hasScheduleLink: boolean;
  hasContractValue: boolean;
  inputs: RealCostInputRow[];
}

export interface RealCostChapterRow {
  id: string;
  chapter: string;
  contractedValue: number;
  realCost: number;
  grossProfit: number;
  marginPct: number;
  signal: RealCostSignal;
  compositionCount: number;
  pendingCompositionCount: number;
}

export interface RealCostGroupTotals {
  contractedValue: number;
  realCost: number;
  grossProfit: number;
  marginPct: number;
  signal: RealCostSignal;
  compositionCount: number;
  pendingCompositionCount: number;
}

export interface RealCostGroupNode {
  phaseId: string;
  number: string;
  name: string;
  depth: number;
  rows: RealCostCompositionRow[];
  children: RealCostGroupNode[];
  totals: RealCostGroupTotals;
}

export interface RealCostMonthRow {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  contractedValue: number;
  realCost: number;
  grossProfit: number;
  marginPct: number;
  signal: RealCostSignal;
  taskCount: number;
}

export interface RealCostPendingSummary {
  inputsWithoutQuote: number;
  compositionsWithoutAnalytic: number;
  itemsWithoutScheduleLink: number;
  itemsWithoutContractValue: number;
  incompleteCompositions: number;
}

export interface RealCostAnalysis {
  compositions: RealCostCompositionRow[];
  chapters: RealCostChapterRow[];
  groupTree: RealCostGroupNode[];
  months: RealCostMonthRow[];
  pending: RealCostPendingSummary;
  totals: {
    contractedValue: number;
    realCost: number;
    grossProfit: number;
    marginPct: number;
    signal: RealCostSignal;
  };
}

type CompositionSource = {
  id: string;
  item: string;
  code?: string;
  bank?: string;
  description: string;
  unit: string;
  quantity: number;
  quantityContracted: number;
  quantitySuppressed: number;
  quantityAdded: number;
  quantityFinal: number;
  unitPriceReference: number;
  unitPriceContracted: number;
  valueSuppressed: number;
  valueAdded: number;
  contractedValue: number;
  source: RealCostCompositionRow['source'];
  sourceName: string;
  sourceStatus?: string;
  sourceDetail?: string;
  taskId?: string;
  phaseId?: string;
  phaseChain?: string;
  composition?: AdditiveComposition;
};

function additiveTimestamp(additive: Additive): number {
  const value = additive.contractedAt || additive.approvedAt || additive.importedAt;
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}

function getOfficialRealCostContractedValue(project: Project): number | null {
  const additives = project.additives ?? [];
  if (additives.length === 0) return null;

  const contracted = additives
    .filter(additive => additive.isContracted || additive.status === 'aditivo_contratado')
    .sort((a, b) => additiveTimestamp(b) - additiveTimestamp(a));
  const referenceAdditive = contracted[0] ?? additives[0];
  if (!referenceAdditive) return null;

  return money2(additiveTotals(referenceAdditive, project).valorFinal);
}

const normalize = (value: string | undefined | null): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

const normalizeDesc = (value: string | undefined | null): string =>
  normalize(value).replace(/[^a-z0-9 ]/g, '');

const looseItemKey = (item: { code?: string; description: string; unit: string }) =>
  `${normalize(item.code)}|${normalizeDesc(item.description)}|${normalize(item.unit)}`;

const sourceIdKey = (sourceId?: string) => sourceId ? `id:${sourceId}` : '';

const compositionFinalQuantity = (composition: {
  quantity?: number;
  originalQuantity?: number;
  addedQuantity?: number;
  suppressedQuantity?: number;
}) => {
  const hasDelta =
    composition.originalQuantity != null ||
    composition.addedQuantity != null ||
    composition.suppressedQuantity != null;
  if (hasDelta) {
    return trunc2(
      (composition.originalQuantity ?? 0) +
      (composition.addedQuantity ?? 0) -
      (composition.suppressedQuantity ?? 0),
    );
  }
  return trunc2(composition.quantity ?? 0);
};

const contractValueFromComposition = (composition: AdditiveComposition, quantity = compositionFinalQuantity(composition)) => {
  if ((composition.totalWithBDI ?? 0) > 0) return money2(composition.totalWithBDI);
  if ((composition.analyticTotalWithBDI ?? 0) > 0) return money2(composition.analyticTotalWithBDI);
  if ((composition.unitPriceWithBDI ?? 0) > 0) return trunc2((composition.unitPriceWithBDI ?? 0) * quantity);
  if ((composition.total ?? 0) > 0) return money2(composition.total);
  return 0;
};

const ADDITIVE_STATUS_LABEL: Record<AdditiveStatus, string> = {
  rascunho: 'Rascunho',
  em_analise: 'Em analise',
  reprovado: 'Reprovado',
  aprovado: 'Aprovado',
  aditivo_contratado: 'Integrado ao projeto',
};

const additiveStatusLabel = (additive: Additive) =>
  ADDITIVE_STATUS_LABEL[additive.status ?? 'rascunho'];

const additiveDetailLabel = (composition: AdditiveComposition) => {
  if (composition.isNewService) return 'Novo servico';
  const added = composition.addedQuantity ?? 0;
  const suppressed = composition.suppressedQuantity ?? 0;
  if (added > 0 && suppressed > 0) return 'Acrescimo e supressao';
  if (added > 0) return 'Acrescimo';
  if (suppressed > 0) return 'Supressao';
  return 'Sem alteracao';
};

const hasAdditiveReference = (composition: AdditiveComposition) =>
  !composition.isNewService && (
    !!composition.taskId ||
    !!composition.linkedTaskId ||
    !!normalize(composition.item) ||
    !!normalize(composition.code) ||
    !!normalizeDesc(composition.description)
  );

const replacementKeysForComposition = (composition: AdditiveComposition) => {
  const keys: string[] = [];
  const taskId = composition.linkedTaskId || composition.taskId;
  if (taskId) keys.push(`task:${taskId}`);
  if (normalize(composition.item)) keys.push(`item:${normalize(composition.item)}`);
  if (normalize(composition.code)) {
    keys.push(`code:${normalize(composition.code)}|${normalize(composition.bank)}`);
  }
  if (normalizeDesc(composition.description)) keys.push(`desc:${normalizeDesc(composition.description)}`);
  return keys;
};

const replacementKeysForBudgetItem = (budget: BudgetItem) => {
  const keys: string[] = [];
  if (budget.taskId) keys.push(`task:${budget.taskId}`);
  if (normalize(budget.item)) keys.push(`item:${normalize(budget.item)}`);
  if (normalize(budget.code)) keys.push(`code:${normalize(budget.code)}|${normalize(budget.bank)}`);
  if (normalizeDesc(budget.description)) keys.push(`desc:${normalizeDesc(budget.description)}`);
  return keys;
};

const signalFromMargin = (marginPct: number, complete: boolean): RealCostSignal => {
  if (!complete) return 'incomplete';
  if (marginPct < 5) return 'danger';
  if (marginPct < 15) return 'attention';
  return 'healthy';
};

function pickLowerPrice(current: RealCostPriceSource | undefined, candidate: RealCostPriceSource) {
  if (!current || candidate.unitPrice < current.unitPrice) return candidate;
  return current;
}

function supplierNameFor(
  supplierId: string,
  comparison: MaterialComparison,
  projectSupplierMap: Map<string, string>,
) {
  return (
    comparison.suppliers.find(supplier => supplier.id === supplierId)?.name ||
    projectSupplierMap.get(supplierId) ||
    'Fornecedor'
  );
}

function buildPriceIndex(project: Project) {
  const projectSupplierMap = new Map<string, string>();
  for (const supplier of project.materialSuppliers ?? []) {
    projectSupplierMap.set(supplier.id, supplier.name);
  }
  for (const comparison of project.materialComparisons ?? []) {
    for (const supplier of comparison.suppliers ?? []) {
      projectSupplierMap.set(supplier.id, supplier.name);
    }
  }

  const bySourceId = new Map<string, RealCostPriceSource>();
  const byLooseKey = new Map<string, RealCostPriceSource>();

  const consider = (
    item: ComparisonItem,
    price: ComparisonItemPrice,
    comparison: MaterialComparison,
  ) => {
    if (!(price.price > 0) || price.available === false) return;
    const source: RealCostPriceSource = {
      unitPrice: trunc2(price.price),
      supplierId: price.supplierId,
      supplierName: supplierNameFor(price.supplierId, comparison, projectSupplierMap),
      comparisonId: comparison.id,
      comparisonName: item.purchaseGroup || comparison.name,
      date: comparison.closedAt || comparison.updatedAt || comparison.createdAt,
    };

    if (item.sourceId) {
      const idKey = sourceIdKey(item.sourceId);
      bySourceId.set(idKey, pickLowerPrice(bySourceId.get(idKey), source));
    }

    const loose = looseItemKey(item);
    byLooseKey.set(loose, pickLowerPrice(byLooseKey.get(loose), source));
  };

  for (const comparison of project.materialComparisons ?? []) {
    for (const item of comparison.items ?? []) {
      for (const price of item.prices ?? []) {
        consider(item, price, comparison);
      }
    }
  }

  return { bySourceId, byLooseKey };
}

function resolveInputPrice(
  input: AdditiveInput,
  index: ReturnType<typeof buildPriceIndex>,
): RealCostPriceSource | undefined {
  return (
    index.bySourceId.get(sourceIdKey(input.id)) ||
    index.byLooseKey.get(looseItemKey({
      code: input.code || undefined,
      description: input.description,
      unit: input.unit,
    }))
  );
}

function buildTaskIndexes(project: Project) {
  const ordered = buildOrderedTasks(project);
  const byId = new Map<string, { task: Task; phaseId: string; chapter: string }>();
  const byCode = new Map<string, { task: Task; phaseId: string; chapter: string }[]>();
  const byDesc = new Map<string, { task: Task; phaseId: string; chapter: string }[]>();

  for (const entry of ordered) {
    const info = { task: entry.task, phaseId: entry.phase.id, chapter: entry.chain };
    byId.set(entry.task.id, info);
    const code = normalize(entry.task.itemCode);
    if (code) byCode.set(code, [...(byCode.get(code) ?? []), info]);
    const desc = normalizeDesc(entry.task.name);
    if (desc) byDesc.set(desc, [...(byDesc.get(desc) ?? []), info]);
  }

  return { ordered, byId, byCode, byDesc };
}

function matchTaskForSource(source: CompositionSource, taskIndexes: ReturnType<typeof buildTaskIndexes>) {
  if (source.taskId) {
    const direct = taskIndexes.byId.get(source.taskId);
    if (direct) return direct;
  }
  const byCode = source.code ? taskIndexes.byCode.get(normalize(source.code))?.[0] : undefined;
  if (byCode) return byCode;
  const byDesc = taskIndexes.byDesc.get(normalizeDesc(source.description))?.[0];
  return byDesc;
}

function matchCompositionForBudgetItem(
  budget: BudgetItem,
  baseCompositions: AdditiveComposition[],
  additiveCompositions: AdditiveComposition[],
) {
  const preferred = budget.source === 'aditivo' ? additiveCompositions : baseCompositions;
  const fallback = budget.source === 'aditivo' ? baseCompositions : additiveCompositions;
  const pools = [preferred, fallback];

  for (const pool of pools) {
    const byTask = budget.taskId
      ? pool.find(comp => comp.taskId === budget.taskId || comp.linkedTaskId === budget.taskId)
      : undefined;
    if (byTask) return byTask;

    const byItem = pool.find(comp => normalize(comp.item) && normalize(comp.item) === normalize(budget.item));
    if (byItem) return byItem;

    const byCode = pool.find(comp =>
      normalize(comp.code) &&
      normalize(comp.code) === normalize(budget.code) &&
      (!budget.bank || !comp.bank || normalize(comp.bank) === normalize(budget.bank)),
    );
    if (byCode) return byCode;

    const byDesc = pool.find(comp => normalizeDesc(comp.description) === normalizeDesc(budget.description));
    if (byDesc) return byDesc;
  }

  return undefined;
}

function buildCompositionSources(project: Project): CompositionSource[] {
  const baseCompositions = project.analyticCompositions ?? [];
  const additivePairs = (project.additives ?? []).flatMap(additive =>
    (additive.compositions ?? []).map(composition => ({ additive, composition })),
  );
  const additiveCompositions = additivePairs.map(pair => pair.composition);
  const additiveReplacementKeys = new Set<string>();
  const budgetRepresentationKeys = new Set<string>();
  const usedCompositionIds = new Set<string>();
  const sources: CompositionSource[] = [];

  for (const pair of additivePairs) {
    if (!hasAdditiveReference(pair.composition)) continue;
    replacementKeysForComposition(pair.composition).forEach(key => additiveReplacementKeys.add(key));
  }

  for (const budget of project.budgetItems ?? []) {
    if (budget.source !== 'sintetica' && budget.source !== 'aditivo') continue;
    replacementKeysForBudgetItem(budget).forEach(key => budgetRepresentationKeys.add(key));

    const composition = matchCompositionForBudgetItem(budget, baseCompositions, additiveCompositions);
    if (composition) usedCompositionIds.add(composition.id);
    const quantity = trunc2(budget.quantity);
    sources.push({
      id: `budget:${budget.id}`,
      item: budget.item,
      code: budget.code || undefined,
      bank: budget.bank || undefined,
      description: budget.description,
      unit: budget.unit,
      quantity,
      quantityContracted: quantity,
      quantitySuppressed: 0,
      quantityAdded: 0,
      quantityFinal: quantity,
      unitPriceReference: trunc2(budget.unitPriceNoBDI),
      unitPriceContracted: trunc2(budget.unitPriceWithBDI),
      valueSuppressed: 0,
      valueAdded: 0,
      contractedValue: money2(budget.totalWithBDI),
      source: budget.source === 'aditivo' ? 'additive' : 'contract',
      sourceName: budget.source === 'aditivo' ? 'Aditivo integrado na medicao' : 'Contrato',
      sourceStatus: budget.source === 'aditivo' ? 'Integrado ao projeto' : undefined,
      sourceDetail: budget.source === 'aditivo' ? 'Servico integrado' : 'Contrato original',
      taskId: budget.taskId,
      composition,
    });
  }

  for (const pair of additivePairs) {
    if (usedCompositionIds.has(pair.composition.id)) continue;
    const alreadyRepresentedByBudget = replacementKeysForComposition(pair.composition).some(key => budgetRepresentationKeys.has(key));
    if (alreadyRepresentedByBudget) continue;

    const bdi = pair.additive.bdiPercent ?? project.syntheticBdiPercent ?? project.contractInfo?.bdiPercent ?? 0;
    const discount = pair.additive.globalDiscountPercent ?? 0;
    const r = computeAdditiveRow(pair.composition, bdi, discount);
    const quantity = trunc2(r.qtdFinal);
    sources.push({
      id: `additive:${pair.additive.id}:${pair.composition.id}`,
      item: pair.composition.itemNumber || pair.composition.item,
      code: pair.composition.code || undefined,
      bank: pair.composition.bank || undefined,
      description: pair.composition.description,
      unit: pair.composition.unit,
      quantity,
      quantityContracted: r.qtdContratada,
      quantitySuppressed: r.qtdSuprimida,
      quantityAdded: r.qtdAcrescida,
      quantityFinal: quantity,
      unitPriceReference: r.referenceUnitNoBDI,
      unitPriceContracted: r.unitPriceWithBDI,
      valueSuppressed: r.valorSuprimido,
      valueAdded: r.valorAcrescido,
      contractedValue: r.valorFinal,
      source: 'additive',
      sourceName: pair.additive.name || 'Aditivo',
      sourceStatus: additiveStatusLabel(pair.additive),
      sourceDetail: additiveDetailLabel(pair.composition),
      taskId: pair.composition.linkedTaskId || pair.composition.taskId,
      phaseId: pair.composition.phaseId,
      phaseChain: pair.composition.phaseChain,
      composition: pair.composition,
    });
  }

  for (const composition of baseCompositions) {
    if (usedCompositionIds.has(composition.id)) continue;
    const representedByAdditive = replacementKeysForComposition(composition).some(key => additiveReplacementKeys.has(key));
    if (representedByAdditive) continue;

    const quantity = compositionFinalQuantity(composition);
    const contractedValue = contractValueFromComposition(composition, quantity);
    sources.push({
      id: `analytic:${composition.id}`,
      item: composition.item,
      code: composition.code || undefined,
      bank: composition.bank || undefined,
      description: composition.description,
      unit: composition.unit,
      quantity,
      quantityContracted: quantity,
      quantitySuppressed: 0,
      quantityAdded: 0,
      quantityFinal: quantity,
      unitPriceReference: trunc2(composition.unitPriceNoBDI),
      unitPriceContracted: trunc2(composition.unitPriceWithBDI),
      valueSuppressed: 0,
      valueAdded: 0,
      contractedValue,
      source: 'analytic',
      sourceName: 'Analitica do contrato',
      sourceDetail: 'Contrato original',
      taskId: composition.linkedTaskId || composition.taskId,
      phaseId: composition.phaseId,
      phaseChain: composition.phaseChain,
      composition,
    });
  }

  return sources;
}

function buildInputRows(
  source: CompositionSource,
  priceIndex: ReturnType<typeof buildPriceIndex>,
): RealCostInputRow[] {
  const inputs = source.composition?.inputs ?? [];
  return inputs.map(input => {
    const price = resolveInputPrice(input, priceIndex);
    const totalQuantity = trunc2((input.coefficient || 0) * source.quantity);
    const referenceUnitPrice = trunc2(input.unitPrice || 0);
    const referenceTotal = trunc2(totalQuantity * referenceUnitPrice);
    const realTotal = price ? trunc2(totalQuantity * price.unitPrice) : 0;
    const grossProfit = money2(referenceTotal - realTotal);
    const marginPct = referenceTotal > 0 ? trunc2((grossProfit / referenceTotal) * 100) : 0;
    return {
      id: input.id,
      code: input.code || undefined,
      bank: input.bank || undefined,
      description: input.description,
      unit: input.unit,
      coefficient: trunc2(input.coefficient || 0),
      totalQuantity,
      referenceUnitPrice,
      referenceTotal,
      realUnitPrice: price?.unitPrice,
      realTotal,
      grossProfit,
      marginPct,
      priceSource: price,
      status: price ? 'quoted' : 'missing',
    };
  });
}

function buildCompositionRows(project: Project): RealCostCompositionRow[] {
  const priceIndex = buildPriceIndex(project);
  const taskIndexes = buildTaskIndexes(project);
  const sources = buildCompositionSources(project);

  return sources.map(source => {
    const matchedTask = matchTaskForSource(source, taskIndexes);
    const phaseId = source.phaseId || matchedTask?.phaseId || '__unlinked__';
    const chapter = source.phaseChain || matchedTask?.chapter || 'Sem vinculo com cronograma';
    const inputs = buildInputRows(source, priceIndex);
    const realCost = money2(inputs.reduce((sum, input) => sum + input.realTotal, 0));
    const missingQuoteCount = inputs.filter(input => input.status === 'missing').length;
    const hasAnalytic = inputs.length > 0;
    const hasScheduleLink = !!(matchedTask || source.phaseId);
    const hasContractValue = source.contractedValue > 0;
    const complete = hasAnalytic && hasScheduleLink && hasContractValue && missingQuoteCount === 0;
    const grossProfit = money2(source.contractedValue - realCost);
    const marginPct = source.contractedValue > 0 ? trunc2((grossProfit / source.contractedValue) * 100) : 0;

    return {
      id: source.id,
      item: source.item,
      code: source.code,
      bank: source.bank,
      description: source.description,
      unit: source.unit,
      quantity: source.quantity,
      quantityContracted: source.quantityContracted,
      quantitySuppressed: source.quantitySuppressed,
      quantityAdded: source.quantityAdded,
      quantityFinal: source.quantityFinal,
      unitPriceReference: source.unitPriceReference,
      unitPriceContracted: source.unitPriceContracted,
      valueSuppressed: source.valueSuppressed,
      valueAdded: source.valueAdded,
      chapterId: phaseId,
      chapter,
      taskId: matchedTask?.task.id || source.taskId,
      taskName: matchedTask?.task.name,
      source: source.source,
      sourceName: source.sourceName,
      sourceStatus: source.sourceStatus,
      sourceDetail: source.sourceDetail,
      contractedValue: money2(source.contractedValue),
      realCost,
      grossProfit,
      marginPct,
      signal: signalFromMargin(marginPct, complete),
      missingQuoteCount,
      hasAnalytic,
      hasScheduleLink,
      hasContractValue,
      inputs,
    };
  }).sort((a, b) => a.item.localeCompare(b.item, 'pt-BR', { numeric: true }));
}

function totalsFromRowsAndChildren(
  rows: RealCostCompositionRow[],
  children: RealCostGroupNode[],
): RealCostGroupTotals {
  const contractedValue = money2(
    rows.reduce((sum, row) => sum + row.contractedValue, 0) +
    children.reduce((sum, child) => sum + child.totals.contractedValue, 0),
  );
  const realCost = money2(
    rows.reduce((sum, row) => sum + row.realCost, 0) +
    children.reduce((sum, child) => sum + child.totals.realCost, 0),
  );
  const grossProfit = money2(contractedValue - realCost);
  const marginPct = contractedValue > 0 ? trunc2((grossProfit / contractedValue) * 100) : 0;
  const compositionCount =
    rows.length + children.reduce((sum, child) => sum + child.totals.compositionCount, 0);
  const pendingCompositionCount =
    rows.filter(row => row.signal === 'incomplete').length +
    children.reduce((sum, child) => sum + child.totals.pendingCompositionCount, 0);

  return {
    contractedValue,
    realCost,
    grossProfit,
    marginPct,
    compositionCount,
    pendingCompositionCount,
    signal: signalFromMargin(marginPct, pendingCompositionCount === 0 && contractedValue > 0),
  };
}

function buildRealCostGroupTree(project: Project, compositions: RealCostCompositionRow[]): RealCostGroupNode[] {
  const rowsByPhase = new Map<string, RealCostCompositionRow[]>();
  for (const row of compositions) {
    const arr = rowsByPhase.get(row.chapterId) ?? [];
    arr.push(row);
    rowsByPhase.set(row.chapterId, arr);
  }

  const numbering = getChapterNumbering(project);
  const tree = getChapterTree(project);

  const buildNode = (chapterNode: ChapterNode, depth: number): RealCostGroupNode | null => {
    const rows = (rowsByPhase.get(chapterNode.phase.id) ?? [])
      .slice()
      .sort((a, b) => a.item.localeCompare(b.item, 'pt-BR', { numeric: true }));
    const children = chapterNode.children
      .map(child => buildNode(child, depth + 1))
      .filter((child): child is RealCostGroupNode => child !== null);
    if (rows.length === 0 && children.length === 0) return null;

    return {
      phaseId: chapterNode.phase.id,
      number: numbering.get(chapterNode.phase.id) || '',
      name: chapterNode.phase.name,
      depth,
      rows,
      children,
      totals: totalsFromRowsAndChildren(rows, children),
    };
  };

  const groups = tree
    .map(node => buildNode(node, 0))
    .filter((node): node is RealCostGroupNode => node !== null)
    .sort((a, b) => a.number.localeCompare(b.number, 'pt-BR', { numeric: true }));

  const orphanRows = (rowsByPhase.get('__unlinked__') ?? [])
    .slice()
    .sort((a, b) => a.item.localeCompare(b.item, 'pt-BR', { numeric: true }));
  if (orphanRows.length > 0) {
    groups.push({
      phaseId: '__unlinked__',
      number: 'SV',
      name: 'Sem vinculo com cronograma',
      depth: 0,
      rows: orphanRows,
      children: [],
      totals: totalsFromRowsAndChildren(orphanRows, []),
    });
  }

  return groups;
}

function flattenGroupChapters(groups: RealCostGroupNode[]): RealCostChapterRow[] {
  const rows: RealCostChapterRow[] = [];
  const walk = (group: RealCostGroupNode) => {
    rows.push({
      id: group.phaseId,
      chapter: `${group.number} ${group.name}`.trim(),
      contractedValue: group.totals.contractedValue,
      realCost: group.totals.realCost,
      grossProfit: group.totals.grossProfit,
      marginPct: group.totals.marginPct,
      signal: group.totals.signal,
      compositionCount: group.totals.compositionCount,
      pendingCompositionCount: group.totals.pendingCompositionCount,
    });
    group.children.forEach(walk);
  };
  groups.forEach(walk);
  return rows;
}

const isISODate = (value: string | undefined | null): value is string =>
  !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);

const iso = (year: number, monthIndex: number, day: number) =>
  `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const monthLabel = (key: string) => {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, 1);
  return date.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');
};

const monthBounds = (key: string) => {
  const [year, month] = key.split('-').map(Number);
  const monthIndex = (month || 1) - 1;
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return { startDate: iso(year, monthIndex, 1), endDate: iso(year, monthIndex, lastDay) };
};

const dateToDay = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, (month || 1) - 1, day || 1) / 86400000);
};

const overlapDaysInclusive = (startA: string, endA: string, startB: string, endB: string) => {
  const start = Math.max(dateToDay(startA), dateToDay(startB));
  const end = Math.min(dateToDay(endA), dateToDay(endB));
  return Math.max(0, end - start + 1);
};

function buildMonthSkeleton(startISO: string, endISO: string): RealCostMonthRow[] {
  if (!isISODate(startISO) || !isISODate(endISO) || startISO > endISO) return [];
  const [startYear, startMonth] = startISO.split('-').map(Number);
  const [endYear, endMonth] = endISO.split('-').map(Number);
  const endKey = `${endYear}-${String(endMonth).padStart(2, '0')}`;
  const months: RealCostMonthRow[] = [];
  let year = startYear;
  let monthIndex = (startMonth || 1) - 1;

  while (`${year}-${String(monthIndex + 1).padStart(2, '0')}` <= endKey) {
    const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const bounds = monthBounds(key);
    months.push({
      key,
      label: monthLabel(key),
      startDate: bounds.startDate,
      endDate: bounds.endDate,
      contractedValue: 0,
      realCost: 0,
      grossProfit: 0,
      marginPct: 0,
      signal: 'incomplete',
      taskCount: 0,
    });
    monthIndex += 1;
    if (monthIndex > 11) {
      monthIndex = 0;
      year += 1;
    }
  }

  return months;
}

function buildMonthlyRows(
  project: Project,
  compositions: RealCostCompositionRow[],
  trabalhaSabado: boolean,
): RealCostMonthRow[] {
  const taskIndexes = buildTaskIndexes(project);
  let minDate = '';
  let maxDate = '';
  const taskDates = new Map<string, { startDate: string; endDate: string }>();

  for (const composition of compositions) {
    if (!composition.taskId) continue;
    const taskInfo = taskIndexes.byId.get(composition.taskId);
    const task = taskInfo?.task;
    if (!task || !isISODate(task.startDate) || !task.duration || task.duration <= 0) continue;
    const startDate = task.startDate;
    const endDate = getWorkEndDate(task.startDate, task.duration, trabalhaSabado);
    taskDates.set(composition.id, { startDate, endDate });
    if (!minDate || startDate < minDate) minDate = startDate;
    if (!maxDate || endDate > maxDate) maxDate = endDate;
  }

  const months = buildMonthSkeleton(minDate, maxDate);
  const monthMap = new Map(months.map(month => [month.key, month]));

  for (const composition of compositions) {
    const dates = taskDates.get(composition.id);
    if (!dates) continue;
    const totalDays = overlapDaysInclusive(dates.startDate, dates.endDate, dates.startDate, dates.endDate);
    if (totalDays <= 0) continue;
    const touchedMonths = new Set<string>();

    for (const month of months) {
      const overlap = overlapDaysInclusive(dates.startDate, dates.endDate, month.startDate, month.endDate);
      if (overlap <= 0) continue;
      const ratio = overlap / totalDays;
      const target = monthMap.get(month.key);
      if (!target) continue;
      target.contractedValue = money2(target.contractedValue + composition.contractedValue * ratio);
      target.realCost = money2(target.realCost + composition.realCost * ratio);
      touchedMonths.add(month.key);
    }

    for (const key of touchedMonths) {
      const target = monthMap.get(key);
      if (target) target.taskCount += 1;
    }
  }

  return months.map(month => {
    const grossProfit = money2(month.contractedValue - month.realCost);
    const marginPct = month.contractedValue > 0 ? trunc2((grossProfit / month.contractedValue) * 100) : 0;
    return {
      ...month,
      grossProfit,
      marginPct,
      signal: signalFromMargin(marginPct, month.contractedValue > 0 && month.taskCount > 0),
    };
  });
}

export function buildRealCostAnalysis(project: Project, trabalhaSabado = false): RealCostAnalysis {
  const compositions = buildCompositionRows(project);
  const groupTree = buildRealCostGroupTree(project, compositions);
  const chapters = flattenGroupChapters(groupTree);
  const months = buildMonthlyRows(project, compositions, trabalhaSabado);
  const pending: RealCostPendingSummary = {
    inputsWithoutQuote: compositions.reduce((sum, row) => sum + row.missingQuoteCount, 0),
    compositionsWithoutAnalytic: compositions.filter(row => !row.hasAnalytic).length,
    itemsWithoutScheduleLink: compositions.filter(row => !row.hasScheduleLink).length,
    itemsWithoutContractValue: compositions.filter(row => !row.hasContractValue).length,
    incompleteCompositions: compositions.filter(row => row.signal === 'incomplete').length,
  };

  const reconstructedContractedValue = money2(compositions.reduce((sum, row) => sum + row.contractedValue, 0));
  const contractedValue = getOfficialRealCostContractedValue(project) ?? reconstructedContractedValue;
  const realCost = money2(compositions.reduce((sum, row) => sum + row.realCost, 0));
  const grossProfit = money2(contractedValue - realCost);
  const marginPct = contractedValue > 0 ? trunc2((grossProfit / contractedValue) * 100) : 0;

  return {
    compositions,
    chapters,
    groupTree,
    months,
    pending,
    totals: {
      contractedValue,
      realCost,
      grossProfit,
      marginPct,
      signal: signalFromMargin(marginPct, pending.incompleteCompositions === 0 && contractedValue > 0),
    },
  };
}
