import type {
  Project,
  MaterialComparison,
  ComparisonSupplier,
  ComparisonItem,
  ComparisonItemPrice,
  ComparisonItemStatus,
  PriceHistoryEntry,
  MaterialComparisonStatus,
  StockMovement,
  StockMovementType,
  MaterialCostClass,
  AdditiveInputType,
  AdditiveComposition,
} from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { trunc2 } from '@/lib/financialEngine';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nowISO = () => new Date().toISOString();

// ============== CRUD COMPARATIVO ==============

export function createComparison(name: string): MaterialComparison {
  const ts = nowISO();
  return {
    id: uid(),
    name: name.trim() || 'Novo comparativo',
    status: 'rascunho',
    suppliers: [],
    items: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

export function upsertComparison(project: Project, comp: MaterialComparison): Project {
  const list = project.materialComparisons ?? [];
  const idx = list.findIndex(c => c.id === comp.id);
  const next = { ...comp, updatedAt: nowISO() };
  const updated = idx >= 0 ? list.map((c, i) => (i === idx ? next : c)) : [...list, next];
  return { ...project, materialComparisons: updated };
}

export function deleteComparison(project: Project, comparisonId: string): Project {
  const list = (project.materialComparisons ?? []).filter(c => c.id !== comparisonId);
  return { ...project, materialComparisons: list };
}

export function setComparisonStatus(comp: MaterialComparison, status: MaterialComparisonStatus): MaterialComparison {
  return { ...comp, status, updatedAt: nowISO(), closedAt: status === 'fechado' || status === 'comprado' ? nowISO() : comp.closedAt };
}

// ============== FORNECEDORES ==============

export function addSupplier(comp: MaterialComparison, supplier: Omit<ComparisonSupplier, 'id'>): MaterialComparison {
  const s: ComparisonSupplier = { id: uid(), ...supplier };
  return { ...comp, suppliers: [...comp.suppliers, s], updatedAt: nowISO() };
}

export function updateSupplier(comp: MaterialComparison, supplierId: string, patch: Partial<ComparisonSupplier>): MaterialComparison {
  return {
    ...comp,
    suppliers: comp.suppliers.map(s => (s.id === supplierId ? { ...s, ...patch } : s)),
    updatedAt: nowISO(),
  };
}

export function removeSupplier(comp: MaterialComparison, supplierId: string): MaterialComparison {
  return {
    ...comp,
    suppliers: comp.suppliers.filter(s => s.id !== supplierId),
    items: comp.items.map(it => ({
      ...it,
      prices: it.prices.filter(p => p.supplierId !== supplierId),
      chosenSupplierId: it.chosenSupplierId === supplierId ? undefined : it.chosenSupplierId,
    })),
    updatedAt: nowISO(),
  };
}

// ============== ITENS ==============

export function addItem(comp: MaterialComparison, item: Omit<ComparisonItem, 'id' | 'prices'> & { prices?: ComparisonItemPrice[] }): MaterialComparison {
  const it: ComparisonItem = {
    id: uid(),
    prices: item.prices ?? [],
    status: 'pendente',
    ...item,
  };
  return { ...comp, items: [...comp.items, it], updatedAt: nowISO() };
}

export function addItemsBulk(comp: MaterialComparison, items: Array<Omit<ComparisonItem, 'id' | 'prices'>>): MaterialComparison {
  const created: ComparisonItem[] = items.map(i => ({ id: uid(), prices: [], status: 'pendente', ...i }));
  return { ...comp, items: [...comp.items, ...created], updatedAt: nowISO() };
}

export function updateItem(comp: MaterialComparison, itemId: string, patch: Partial<ComparisonItem>): MaterialComparison {
  return {
    ...comp,
    items: comp.items.map(it => (it.id === itemId ? { ...it, ...patch } : it)),
    updatedAt: nowISO(),
  };
}

export function removeItem(comp: MaterialComparison, itemId: string): MaterialComparison {
  return { ...comp, items: comp.items.filter(it => it.id !== itemId), updatedAt: nowISO() };
}

export function setItemStatus(comp: MaterialComparison, itemId: string, status: ComparisonItemStatus): MaterialComparison {
  return updateItem(comp, itemId, { status });
}

export function setItemPrice(comp: MaterialComparison, itemId: string, supplierId: string, price: number, extras?: Partial<ComparisonItemPrice>): MaterialComparison {
  return {
    ...comp,
    items: comp.items.map(it => {
      if (it.id !== itemId) return it;
      const idx = it.prices.findIndex(p => p.supplierId === supplierId);
      const total = +(price * (it.quantity || 0)).toFixed(2);
      const entry: ComparisonItemPrice = { supplierId, price, total, available: true, ...extras };
      const prices = idx >= 0
        ? it.prices.map((p, i) => (i === idx ? { ...p, ...entry } : p))
        : [...it.prices, entry];
      return { ...it, prices };
    }),
    updatedAt: nowISO(),
  };
}

export function setChosenSupplier(comp: MaterialComparison, itemId: string, supplierId: string | undefined): MaterialComparison {
  return updateItem(comp, itemId, { chosenSupplierId: supplierId });
}

// ============== CÁLCULOS ==============

export interface ItemAnalysis {
  itemId: string;
  bestSupplierId?: string;
  bestPrice?: number;
  bestTotal?: number;
  chosenSupplierId?: string;
  chosenPrice?: number;
  chosenTotal?: number;
  referenceTotal?: number;
  savings?: number;
  savingsPct?: number;
}

export function analyzeItem(item: ComparisonItem): ItemAnalysis {
  const valid = item.prices.filter(p => p.price > 0 && p.available !== false);
  const best = valid.reduce<ComparisonItemPrice | undefined>(
    (acc, p) => (!acc || p.price < acc.price ? p : acc),
    undefined,
  );
  const chosenId = item.chosenSupplierId ?? best?.supplierId;
  const chosen = chosenId ? item.prices.find(p => p.supplierId === chosenId) : undefined;
  const refTotal = item.referencePrice != null ? +(item.referencePrice * item.quantity).toFixed(2) : undefined;
  const chosenTotal = chosen ? +(chosen.price * item.quantity).toFixed(2) : undefined;
  const savings = refTotal != null && chosenTotal != null ? +(refTotal - chosenTotal).toFixed(2) : undefined;
  const savingsPct = refTotal && refTotal > 0 && savings != null ? +((savings / refTotal) * 100).toFixed(2) : undefined;
  return {
    itemId: item.id,
    bestSupplierId: best?.supplierId,
    bestPrice: best?.price,
    bestTotal: best ? +(best.price * item.quantity).toFixed(2) : undefined,
    chosenSupplierId: chosenId,
    chosenPrice: chosen?.price,
    chosenTotal,
    referenceTotal: refTotal,
    savings,
    savingsPct,
  };
}

export interface SupplierTotal {
  supplierId: string;
  supplierName: string;
  total: number;
  itemsCount: number;
  itemsCovered: number;
}

export function totalsBySupplier(comp: MaterialComparison): SupplierTotal[] {
  return comp.suppliers.map(s => {
    let total = 0;
    let covered = 0;
    for (const it of comp.items) {
      const p = it.prices.find(pp => pp.supplierId === s.id);
      if (p && p.price > 0) {
        total += p.price * it.quantity;
        covered += 1;
      }
    }
    return {
      supplierId: s.id,
      supplierName: s.name,
      total: +total.toFixed(2),
      itemsCount: comp.items.length,
      itemsCovered: covered,
    };
  });
}

export interface OptimizedPlanRow {
  itemId: string;
  code?: string;
  description: string;
  unit: string;
  quantity: number;
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  total: number;
}
export interface OptimizedPlan {
  rows: OptimizedPlanRow[];
  totalCost: number;
  referenceTotal: number;
  savings: number;
  savingsPct: number;
  bySupplier: Array<{ supplierId: string; supplierName: string; total: number; itemsCount: number }>;
  unresolvedItems: Array<{ itemId: string; description: string }>;
}

export function optimizedPurchasePlan(comp: MaterialComparison): OptimizedPlan {
  const rows: OptimizedPlanRow[] = [];
  const unresolved: Array<{ itemId: string; description: string }> = [];
  let totalCost = 0;
  let referenceTotal = 0;
  const supplierMap = new Map(comp.suppliers.map(s => [s.id, s.name] as const));

  for (const it of comp.items) {
    const an = analyzeItem(it);
    if (it.referencePrice != null) referenceTotal += it.referencePrice * it.quantity;
    if (!an.chosenSupplierId || an.chosenPrice == null) {
      unresolved.push({ itemId: it.id, description: it.description });
      continue;
    }
    const supplierName = supplierMap.get(an.chosenSupplierId) ?? '—';
    const total = +(an.chosenPrice * it.quantity).toFixed(2);
    totalCost += total;
    rows.push({
      itemId: it.id,
      code: it.code,
      description: it.description,
      unit: it.unit,
      quantity: it.quantity,
      supplierId: an.chosenSupplierId,
      supplierName,
      unitPrice: an.chosenPrice,
      total,
    });
  }

  const bySupplierMap = new Map<string, { supplierId: string; supplierName: string; total: number; itemsCount: number }>();
  for (const r of rows) {
    const cur = bySupplierMap.get(r.supplierId) ?? { supplierId: r.supplierId, supplierName: r.supplierName, total: 0, itemsCount: 0 };
    cur.total = +(cur.total + r.total).toFixed(2);
    cur.itemsCount += 1;
    bySupplierMap.set(r.supplierId, cur);
  }

  const savings = +(referenceTotal - totalCost).toFixed(2);
  const savingsPct = referenceTotal > 0 ? +((savings / referenceTotal) * 100).toFixed(2) : 0;

  return {
    rows,
    totalCost: +totalCost.toFixed(2),
    referenceTotal: +referenceTotal.toFixed(2),
    savings,
    savingsPct,
    bySupplier: Array.from(bySupplierMap.values()).sort((a, b) => b.total - a.total),
    unresolvedItems: unresolved,
  };
}

// ============== HISTÓRICO DE PREÇOS ==============

export function appendPriceHistoryFromComparison(project: Project, comp: MaterialComparison): Project {
  // Remove registros antigos deste mesmo comparativo (evita duplicação ao fechar 2x).
  const existing = (project.materialPriceHistory ?? []).filter(h => h.comparisonId !== comp.id);
  const supplierMap = new Map(comp.suppliers.map(s => [s.id, s.name] as const));
  const entries: PriceHistoryEntry[] = [];
  const date = nowISO();
  for (const it of comp.items) {
    for (const p of it.prices) {
      if (!(p.price > 0)) continue;
      entries.push({
        id: uid(),
        itemCode: it.code,
        itemDescription: it.description,
        unit: it.unit,
        supplierId: p.supplierId,
        supplierName: supplierMap.get(p.supplierId) ?? '—',
        price: p.price,
        date,
        comparisonId: comp.id,
        comparisonName: comp.name,
      });
    }
  }
  return { ...project, materialPriceHistory: [...existing, ...entries] };
}

// ============== SUGESTÕES DE MATERIAIS DO PROJETO ==============
// Regra: somente INSUMOS ANALÍTICOS são sugeridos. Composições sintéticas
// (BudgetItem source='sintetica') NÃO devem aparecer como item de compra.

export type MaterialSuggestionSource = 'analytic_input' | 'additive_input' | 'task_material';
export type MaterialSuggestionDetail =
  | 'contracted_item'
  | 'additive_new_service'
  | 'additive_existing_changed';

export interface MaterialSuggestion {
  key: string;
  description: string;
  unit: string;
  quantity: number;
  code?: string;
  bank?: string;
  referencePrice?: number;
  sourceType: MaterialSuggestionSource;
  sourceDetail?: MaterialSuggestionDetail;
  sourceId: string;
  legacyInputType?: AdditiveInputType;
  /** Aviso opcional (ex.: composição sem analítico). */
  warning?: string;
}

export interface MaterialSuggestionDiagnostics {
  additiveCompositionsWithAnalytic: number;
  additiveAnalyticInputs: number;
  additivesRead: number;
  baseCompositionsWithAnalytic: number;
  baseCompositionsWithoutAnalytic: number;
  baseAnalyticInputs: number;
  contractedAdditivesRead: number;
  syntheticCompositionsIgnored: number;
  taskMaterials: number;
  groupedInputs: number;
}

function makeKey(code: string | undefined, description: string, unit: string, bank?: string): string {
  return [code ?? '', bank ?? '', description, unit].join('|').toLowerCase();
}

export function suggestMaterialsFromProject(project: Project): MaterialSuggestion[] {
  return suggestMaterialsWithDiagnostics(project).suggestions;
}

export function suggestMaterialsWithDiagnostics(
  project: Project,
): { suggestions: MaterialSuggestion[]; diagnostics: MaterialSuggestionDiagnostics } {
  const suggestions = new Map<string, MaterialSuggestion>();
  const diag: MaterialSuggestionDiagnostics = {
    additiveCompositionsWithAnalytic: 0,
    additiveAnalyticInputs: 0,
    additivesRead: 0,
    baseCompositionsWithAnalytic: 0,
    baseCompositionsWithoutAnalytic: 0,
    baseAnalyticInputs: 0,
    contractedAdditivesRead: 0,
    syntheticCompositionsIgnored: 0,
    taskMaterials: 0,
    groupedInputs: 0,
  };

  const upsert = (s: MaterialSuggestion) => {
    const cur = suggestions.get(s.key);
    if (cur) {
      cur.quantity = trunc2(cur.quantity + s.quantity);
      if (!cur.referencePrice && s.referencePrice) cur.referencePrice = s.referencePrice;
      if (!cur.legacyInputType && s.legacyInputType) cur.legacyInputType = s.legacyInputType;
      // Se origens diferem dentro do mesmo insumo, manter o detalhe "alterado"
      // como mais informativo do que "contratado".
      if (s.sourceDetail && cur.sourceDetail && s.sourceDetail !== cur.sourceDetail) {
        const ranking: Record<MaterialSuggestionDetail, number> = {
          contracted_item: 0,
          additive_existing_changed: 1,
          additive_new_service: 2,
        };
        if (ranking[s.sourceDetail] > ranking[cur.sourceDetail]) cur.sourceDetail = s.sourceDetail;
      } else if (s.sourceDetail && !cur.sourceDetail) {
        cur.sourceDetail = s.sourceDetail;
      }
    } else {
      suggestions.set(s.key, { ...s, quantity: trunc2(s.quantity) });
    }
  };

  // Qtd Final exibida na tabela do Aditivo:
  //   se houver original/added/suppressed → original + added − suppressed
  //   senão → quantity da composição.
  const qtyFinal = (c: { quantity?: number; originalQuantity?: number; addedQuantity?: number; suppressedQuantity?: number }) => {
    const hasDelta = c.originalQuantity != null || c.addedQuantity != null || c.suppressedQuantity != null;
    if (hasDelta) {
      return (c.originalQuantity ?? 0) + (c.addedQuantity ?? 0) - (c.suppressedQuantity ?? 0);
    }
    return c.quantity ?? 0;
  };

  // A) FONTE PRINCIPAL — Insumos analíticos das composições da aba ADITIVO.
  //    Lê todos os aditivos (inclusive rascunho/em análise) apenas para fins
  //    de planejamento de compra. Não integra Medição/Cronograma/EAP/Diário.
  for (const ad of project.additives ?? []) {
    diag.additivesRead += 1;
    const isContracted = ad.isContracted === true || ad.status === 'aditivo_contratado';
    const discountFactor = 1 - ((ad.globalDiscountPercent ?? 0) / 100);
    if (isContracted) diag.contractedAdditivesRead += 1;
    for (const comp of ad.compositions ?? []) {
      const compQty = qtyFinal(comp);
      const inputs = comp.inputs ?? [];
      if (compQty <= 0 || inputs.length === 0) continue;
      diag.additiveCompositionsWithAnalytic += 1;
      const isNew = comp.isNewService === true;
      const added = comp.addedQuantity ?? 0;
      const suppressed = comp.suppressedQuantity ?? 0;
      const detail: MaterialSuggestionDetail = isNew
        ? 'additive_new_service'
        : added > 0 || suppressed > 0
          ? 'additive_existing_changed'
          : 'contracted_item';
      for (const inp of inputs) {
        const qty = trunc2((inp.coefficient || 0) * compQty);
        if (!qty) continue;
        diag.additiveAnalyticInputs += 1;
        const referencePrice = isNew
          ? trunc2((inp.unitPrice || 0) * discountFactor)
          : inp.unitPrice || undefined;
        upsert({
          key: makeKey(inp.code, inp.description, inp.unit, inp.bank),
          description: inp.description,
          unit: inp.unit,
          quantity: qty,
          code: inp.code || undefined,
          bank: inp.bank || undefined,
          referencePrice: referencePrice || undefined,
          sourceType: 'additive_input',
          sourceDetail: detail,
          sourceId: inp.id,
          legacyInputType: inp.type,
        });
      }
    }
  }

  // B) FALLBACK — Insumos analíticos do CONTRATO/BASE (planilha Analítica
  //    vinculada diretamente em project.analyticCompositions).
  for (const comp of project.analyticCompositions ?? []) {
    const compQty = comp.quantity || 0;
    const inputs = comp.inputs ?? [];
    if (inputs.length === 0) {
      diag.baseCompositionsWithoutAnalytic += 1;
      continue;
    }
    diag.baseCompositionsWithAnalytic += 1;
    for (const inp of inputs) {
      const qty = trunc2((inp.coefficient || 0) * compQty);
      if (!qty) continue;
      diag.baseAnalyticInputs += 1;
      upsert({
        key: makeKey(inp.code, inp.description, inp.unit, inp.bank),
        description: inp.description,
        unit: inp.unit,
        quantity: qty,
        code: inp.code || undefined,
        bank: inp.bank || undefined,
        referencePrice: inp.unitPrice || undefined,
        sourceType: 'analytic_input',
        sourceId: inp.id,
        legacyInputType: inp.type,
      });
    }
  }

  // Sintéticas sem analítica vinculada são apenas contabilizadas.
  for (const bi of project.budgetItems ?? []) {
    if (bi.source !== 'sintetica') continue;
    const hasAnalytic = (project.analyticCompositions ?? []).some(
      c => c.code === bi.code && c.bank === bi.bank,
    );
    if (!hasAnalytic) diag.syntheticCompositionsIgnored += 1;
  }

  // C) SECUNDÁRIA — Materiais manuais declarados nas tarefas (task.materials).
  const tasks = getAllTasks(project);
  for (const t of tasks) {
    for (const m of t.materials ?? []) {
      diag.taskMaterials += 1;
      const refPrice = m.estimatedCost && m.quantity ? +(m.estimatedCost / m.quantity).toFixed(2) : undefined;
      upsert({
        key: makeKey(undefined, m.name, m.unit),
        description: m.name,
        unit: m.unit,
        quantity: trunc2(m.quantity || 0),
        referencePrice: refPrice,
        sourceType: 'task_material',
        sourceId: t.id,
      });
    }
  }

  const sorted = Array.from(suggestions.values()).sort((a, b) =>
    a.description.localeCompare(b.description, 'pt-BR'),
  );
  diag.groupedInputs = sorted.filter(s => !s.warning).length;
  return { suggestions: sorted, diagnostics: diag };
}

// ============== VÍNCULO INSUMO ↔ COMPARATIVO ==============

export interface SuggestionLikeKey {
  sourceId?: string;
  code?: string;
  description: string;
  unit: string;
}

export function linkKeyOf(x: SuggestionLikeKey): string {
  if (x.sourceId) return `id:${x.sourceId}`;
  return `k:${(x.code ?? '').trim().toLowerCase()}|${(x.description ?? '').trim().toLowerCase()}|${(x.unit ?? '').trim().toLowerCase()}`;
}

export const MATERIAL_COST_CLASS_ORDER: MaterialCostClass[] = ['material', 'labor', 'equipment', 'unclassified'];

export const MATERIAL_COST_CLASS_LABEL: Record<MaterialCostClass, string> = {
  material: 'Material',
  labor: 'Mão de obra',
  equipment: 'Equipamento',
  unclassified: 'Sem classificação',
};

export const MATERIAL_COST_CLASS_COLOR: Record<MaterialCostClass, string> = {
  material: 'hsl(24, 82%, 54%)',
  labor: 'hsl(0, 72%, 51%)',
  equipment: 'hsl(230, 65%, 52%)',
  unclassified: 'hsl(215, 16%, 47%)',
};

function normCostText(value: string | undefined): string {
  return (value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function classFromLegacyType(type?: AdditiveInputType): MaterialCostClass | undefined {
  if (type === 'material') return 'material';
  if (type === 'mao_obra') return 'labor';
  if (type === 'equipamento') return 'equipment';
  if (type === 'outro') return 'unclassified';
  return undefined;
}

function textHasAny(text: string, words: string[]): boolean {
  return words.some(w => text.includes(w));
}

export function guessMaterialCostClass(input: {
  description: string;
  unit?: string;
  sourceType?: MaterialSuggestionSource | ComparisonItem['sourceType'];
  legacyInputType?: AdditiveInputType;
}): MaterialCostClass {
  const legacy = classFromLegacyType(input.legacyInputType);
  if (legacy) return legacy;

  const desc = normCostText(input.description);
  const unit = normCostText(input.unit);
  const laborWords = ['ajudante', 'auxiliar', 'armador', 'azulejista', 'bombeiro hidraulico', 'carpinteiro', 'eletricista', 'encanador', 'engenheiro', 'mestre', 'montador', 'oficial', 'operador', 'pedreiro', 'pintor', 'serralheiro', 'servente', 'soldador', 'tecnico', 'vigia'];
  const equipmentWords = ['betoneira', 'caminhao', 'carregadeira', 'compactador', 'compressor', 'escavadeira', 'equipamento', 'furadeira', 'guindaste', 'maquina', 'martelete', 'retroescavadeira', 'rolo compactador', 'serra circular'];
  const materialWords = ['abracadeira', 'aco', 'adesivo', 'argamassa', 'areia', 'barra', 'bloco', 'bomba', 'bucha', 'cabo', 'cimento', 'concreto', 'conexao', 'disjuntor', 'eletroduto', 'fio', 'fita', 'joelho', 'luminaria', 'parafuso', 'placa', 'porta', 'registro', 'tinta', 'tijolo', 'tubo', 'valvula'];

  if (textHasAny(desc, laborWords)) return 'labor';
  if (textHasAny(desc, equipmentWords)) return 'equipment';
  if (textHasAny(desc, materialWords)) return 'material';
  if (input.sourceType === 'task_material') return 'material';
  if (['h', 'hora', 'horas'].includes(unit) && textHasAny(desc, laborWords)) return 'labor';
  return 'unclassified';
}

export function resolveMaterialCostClass(project: Project, item: MaterialSuggestion | ComparisonItem): MaterialCostClass {
  const manual = project.materialCostClasses?.[linkKeyOf(item)];
  if (manual) return manual;
  return guessMaterialCostClass({
    description: item.description,
    unit: item.unit,
    sourceType: item.sourceType,
    legacyInputType: 'legacyInputType' in item ? item.legacyInputType : undefined,
  });
}

export function setMaterialCostClass(project: Project, item: SuggestionLikeKey, costClass: MaterialCostClass): Project {
  return {
    ...project,
    materialCostClasses: {
      ...(project.materialCostClasses ?? {}),
      [linkKeyOf(item)]: costClass,
    },
  };
}

export interface MaterialCostClassTotal {
  costClass: MaterialCostClass;
  label: string;
  total: number;
  itemsCount: number;
  missingPriceCount: number;
}

export function computeMaterialCostClassTotals(
  project: Project,
  items: MaterialSuggestion[] = suggestMaterialsFromProject(project).filter(s => !s.warning),
): MaterialCostClassTotal[] {
  const totals = new Map<MaterialCostClass, MaterialCostClassTotal>();
  for (const costClass of MATERIAL_COST_CLASS_ORDER) {
    totals.set(costClass, {
      costClass,
      label: MATERIAL_COST_CLASS_LABEL[costClass],
      total: 0,
      itemsCount: 0,
      missingPriceCount: 0,
    });
  }
  for (const item of items) {
    const row = totals.get(resolveMaterialCostClass(project, item))!;
    row.itemsCount += 1;
    if (item.referencePrice != null && item.referencePrice > 0) {
      row.total = trunc2(row.total + item.referencePrice * item.quantity);
    } else {
      row.missingPriceCount += 1;
    }
  }
  return MATERIAL_COST_CLASS_ORDER.map(c => totals.get(c)!);
}

export interface MaterialCompositionClassBreakdown {
  id: string;
  item?: string;
  code?: string;
  bank?: string;
  description: string;
  source: string;
  total: number;
  missingPriceCount: number;
  rows: MaterialCostClassTotal[];
}

function compositionQtyFinal(c: { quantity?: number; originalQuantity?: number; addedQuantity?: number; suppressedQuantity?: number }) {
  const hasDelta = c.originalQuantity != null || c.addedQuantity != null || c.suppressedQuantity != null;
  if (hasDelta) return (c.originalQuantity ?? 0) + (c.addedQuantity ?? 0) - (c.suppressedQuantity ?? 0);
  return c.quantity ?? 0;
}

export function getMaterialCompositionBreakdown(project: Project, comp: AdditiveComposition, source = 'Composição'): MaterialCompositionClassBreakdown | null {
  const qty = compositionQtyFinal(comp);
  if (qty <= 0 || !comp.inputs?.length) return null;
  const rows = computeMaterialCostClassTotals(
    project,
    comp.inputs
      .map(inp => ({
        key: makeKey(inp.code, inp.description, inp.unit, inp.bank),
        description: inp.description,
        unit: inp.unit,
        quantity: trunc2((inp.coefficient || 0) * qty),
        code: inp.code || undefined,
        bank: inp.bank || undefined,
        referencePrice: inp.unitPrice || undefined,
        sourceType: 'analytic_input' as const,
        sourceId: inp.id,
        legacyInputType: inp.type,
      }))
      .filter(inp => inp.quantity > 0),
  );
  return {
    id: `${source}:${comp.id}`,
    item: comp.item,
    code: comp.code,
    bank: comp.bank,
    description: comp.description,
    source,
    total: trunc2(rows.reduce((sum, row) => sum + row.total, 0)),
    missingPriceCount: rows.reduce((sum, row) => sum + row.missingPriceCount, 0),
    rows,
  };
}

export function getMaterialCompositionBreakdowns(project: Project): MaterialCompositionClassBreakdown[] {
  const out: MaterialCompositionClassBreakdown[] = [];
  for (const comp of project.analyticCompositions ?? []) {
    const row = getMaterialCompositionBreakdown(project, comp, 'Contrato');
    if (row) out.push(row);
  }
  for (const ad of project.additives ?? []) {
    for (const comp of ad.compositions ?? []) {
      const row = getMaterialCompositionBreakdown(project, comp, ad.name || 'Aditivo');
      if (row) out.push(row);
    }
  }
  return out.sort((a, b) => a.description.localeCompare(b.description, 'pt-BR'));
}

/** Procura em quais comparativos um insumo (por chave) já foi vinculado. */
export function findLinkedLocations(
  project: Project,
  key: string,
): Array<{ comparisonId: string; itemId: string }> {
  const out: Array<{ comparisonId: string; itemId: string }> = [];
  for (const c of project.materialComparisons ?? []) {
    for (const it of c.items) {
      if (linkKeyOf(it) === key) out.push({ comparisonId: c.id, itemId: it.id });
    }
  }
  return out;
}

/**
 * Move/seta o vínculo de um insumo para `targetComparisonId`.
 * - null/undefined → remove de todos os comparativos.
 * - Caso o item já esteja em outro comparativo, ele é removido de lá.
 */
export function setSuggestionLink(
  project: Project,
  suggestion: Omit<ComparisonItem, 'id' | 'prices' | 'status'> & { sourceType?: ComparisonItem['sourceType']; sourceDetail?: ComparisonItem['sourceDetail']; sourceId?: string },
  targetComparisonId: string | null,
): Project {
  const key = linkKeyOf(suggestion);
  const list = project.materialComparisons ?? [];
  const ts = nowISO();
  const updated = list.map(c => {
    const has = c.items.find(it => linkKeyOf(it) === key);
    if (c.id === targetComparisonId) {
      if (has) return c; // já está no destino
      const it: ComparisonItem = { id: uid(), prices: [], status: 'pendente', ...suggestion };
      return { ...c, items: [...c.items, it], updatedAt: ts };
    }
    if (has) {
      return { ...c, items: c.items.filter(it => linkKeyOf(it) !== key), updatedAt: ts };
    }
    return c;
  });
  return { ...project, materialComparisons: updated };
}

export const STATUS_LABEL: Record<MaterialComparisonStatus, string> = {
  rascunho: 'Rascunho',
  em_cotacao: 'Em cotação',
  fechado: 'Fechado',
  comprado: 'Comprado',
};

// ============== FORNECEDORES GLOBAIS (project-level) ==============

const supplierKey = (s: { name?: string; contact?: string }) =>
  `${(s.name ?? '').trim().toLowerCase()}|${(s.contact ?? '').trim().toLowerCase()}`;

/**
 * Retorna a lista de fornecedores globais do projeto, garantindo migração
 * de fornecedores antigos que estavam dentro de cada comparativo.
 */
export function getProjectSuppliers(project: Project): ComparisonSupplier[] {
  const global = project.materialSuppliers ?? [];
  if (global.length > 0) return global;
  // Fallback: derivar dos comparativos antigos (sem mutar projeto).
  const seen = new Map<string, ComparisonSupplier>();
  for (const c of project.materialComparisons ?? []) {
    for (const s of c.suppliers ?? []) {
      const k = supplierKey(s);
      if (!seen.has(k)) seen.set(k, s);
    }
  }
  return Array.from(seen.values());
}

/**
 * Garante que project.materialSuppliers exista, migrando fornecedores antigos
 * de comparison.suppliers (preservando os IDs originais para não quebrar preços).
 */
export function ensureGlobalSuppliers(project: Project): Project {
  if (project.materialSuppliers && project.materialSuppliers.length >= 0 && project.materialSuppliers !== undefined) {
    // Mesmo se já existir, fundir com qualquer fornecedor ainda solto em comparativos.
    const byKey = new Map<string, ComparisonSupplier>();
    for (const s of project.materialSuppliers) byKey.set(supplierKey(s), s);
    let changed = false;
    for (const c of project.materialComparisons ?? []) {
      for (const s of c.suppliers ?? []) {
        const k = supplierKey(s);
        if (!byKey.has(k)) { byKey.set(k, s); changed = true; }
      }
    }
    if (!changed) return project;
    return { ...project, materialSuppliers: Array.from(byKey.values()) };
  }
  const byKey = new Map<string, ComparisonSupplier>();
  for (const c of project.materialComparisons ?? []) {
    for (const s of c.suppliers ?? []) {
      const k = supplierKey(s);
      if (!byKey.has(k)) byKey.set(k, s);
    }
  }
  return { ...project, materialSuppliers: Array.from(byKey.values()) };
}

export function addProjectSupplier(project: Project, supplier: Omit<ComparisonSupplier, 'id'>): Project {
  const list = getProjectSuppliers(project);
  const k = supplierKey(supplier);
  if (list.some(s => supplierKey(s) === k)) return project;
  const s: ComparisonSupplier = { id: uid(), ...supplier };
  return { ...project, materialSuppliers: [...list, s] };
}

export function updateProjectSupplier(project: Project, id: string, patch: Partial<ComparisonSupplier>): Project {
  const list = getProjectSuppliers(project);
  return { ...project, materialSuppliers: list.map(s => (s.id === id ? { ...s, ...patch } : s)) };
}

export function removeProjectSupplier(project: Project, id: string): Project {
  const list = getProjectSuppliers(project).filter(s => s.id !== id);
  // Limpa preços e escolhas em todos os comparativos.
  const comps = (project.materialComparisons ?? []).map(c => ({
    ...c,
    suppliers: (c.suppliers ?? []).filter(s => s.id !== id),
    items: c.items.map(it => ({
      ...it,
      prices: it.prices.filter(p => p.supplierId !== id),
      chosenSupplierId: it.chosenSupplierId === id ? undefined : it.chosenSupplierId,
    })),
  }));
  return { ...project, materialSuppliers: list, materialComparisons: comps };
}

// ============== FORNECEDORES POR COMPARATIVO ==============

/**
 * Retorna os IDs de fornecedores participantes do comparativo.
 * Migração: se `supplierIds` não existir, deriva de `comp.suppliers` (legado)
 * e dos preços já lançados nos itens.
 */
export function getComparisonSupplierIds(comp: MaterialComparison): string[] {
  if (Array.isArray(comp.supplierIds)) return comp.supplierIds;
  const set = new Set<string>();
  for (const s of comp.suppliers ?? []) set.add(s.id);
  for (const it of comp.items) for (const p of it.prices) set.add(p.supplierId);
  return Array.from(set);
}

/** Retorna os fornecedores globais filtrados pelos participantes do comparativo. */
export function getComparisonSuppliers(
  project: Project,
  comp: MaterialComparison,
): ComparisonSupplier[] {
  const ids = new Set(getComparisonSupplierIds(comp));
  const global = getProjectSuppliers(project);
  // Preserva a ordem de inclusão se possível.
  const byId = new Map(global.map(s => [s.id, s] as const));
  const ordered = getComparisonSupplierIds(comp)
    .map(id => byId.get(id))
    .filter((s): s is ComparisonSupplier => !!s);
  // Adiciona quaisquer remanescentes globais que estavam no set mas perderam ordem.
  for (const s of global) if (ids.has(s.id) && !ordered.includes(s)) ordered.push(s);
  return ordered;
}

export function addSupplierToComparison(comp: MaterialComparison, supplierId: string): MaterialComparison {
  const cur = getComparisonSupplierIds(comp);
  if (cur.includes(supplierId)) return comp;
  return { ...comp, supplierIds: [...cur, supplierId], updatedAt: nowISO() };
}

export function removeSupplierFromComparison(comp: MaterialComparison, supplierId: string): MaterialComparison {
  const cur = getComparisonSupplierIds(comp).filter(id => id !== supplierId);
  // Preserva preços lançados (apenas oculta o fornecedor deste comparativo).
  return { ...comp, supplierIds: cur, updatedAt: nowISO() };
}

/** Cadastra um novo fornecedor global E já o vincula ao comparativo informado. */
export function addProjectSupplierAndLink(
  project: Project,
  supplier: Omit<ComparisonSupplier, 'id'>,
  comparisonId: string,
): Project {
  const before = getProjectSuppliers(project);
  const next = addProjectSupplier(project, supplier);
  const after = getProjectSuppliers(next);
  // Acha o ID do fornecedor (recém-criado ou já existente).
  const k = supplierKey(supplier);
  const found = after.find(s => supplierKey(s) === k) ?? after[after.length - 1];
  if (!found) return next;
  const comps = (next.materialComparisons ?? []).map(c =>
    c.id === comparisonId ? addSupplierToComparison(c, found.id) : c,
  );
  void before;
  return { ...next, materialComparisons: comps };
}

export interface StockRow {
  key: string;
  code?: string;
  bank?: string;
  description: string;
  unit: string;
  comparisonId?: string;
  comparisonName?: string;
  planned: number;
  purchased: number;  // quantidade comprada/pedida (status comprado em itens)
  received: number;   // soma de entradas
  used: number;       // soma de saídas
  balance: number;    // received - used + ajustes
  diffPlannedUsed: number; // planned - used
  status: StockStatus;
}

export type StockStatus =
  | 'nao_comprado'
  | 'pedido_aberto'
  | 'recebido_parcial'
  | 'em_estoque'
  | 'consumo_previsto'
  | 'consumo_acima'
  | 'falta_material';

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  nao_comprado: 'Não comprado',
  pedido_aberto: 'Pedido em aberto',
  recebido_parcial: 'Recebido parcial',
  em_estoque: 'Em estoque',
  consumo_previsto: 'Consumo conforme previsto',
  consumo_acima: 'Consumo acima do previsto',
  falta_material: 'Falta material',
};

export function computeStockRows(project: Project): StockRow[] {
  const rows = new Map<string, StockRow>();
  const comps = project.materialComparisons ?? [];
  for (const c of comps) {
    for (const it of c.items) {
      const key = linkKeyOf(it);
      const cur = rows.get(key) ?? {
        key,
        code: it.code,
        description: it.description,
        unit: it.unit,
        comparisonId: c.id,
        comparisonName: c.name,
        planned: 0,
        purchased: 0,
        received: 0,
        used: 0,
        balance: 0,
        diffPlannedUsed: 0,
        status: 'nao_comprado' as StockStatus,
      };
      cur.planned = trunc2(cur.planned + (it.quantity || 0));
      if (it.status === 'comprado') cur.purchased = trunc2(cur.purchased + (it.quantity || 0));
      rows.set(key, cur);
    }
  }
  // Movimentações
  for (const m of project.stockMovements ?? []) {
    let row = rows.get(m.itemKey);
    if (!row) {
      row = {
        key: m.itemKey,
        code: m.itemCode,
        description: m.itemDescription,
        unit: m.itemUnit,
        planned: 0, purchased: 0, received: 0, used: 0, balance: 0, diffPlannedUsed: 0,
        status: 'nao_comprado',
      };
      rows.set(m.itemKey, row);
    }
    if (m.type === 'entrada') row.received = trunc2(row.received + m.quantity);
    else if (m.type === 'saida') row.used = trunc2(row.used + m.quantity);
    else if (m.type === 'ajuste') row.balance = trunc2(row.balance + m.quantity);
  }
  // Cálculo final
  const out: StockRow[] = [];
  for (const r of rows.values()) {
    r.balance = trunc2(r.balance + r.received - r.used);
    r.diffPlannedUsed = trunc2(r.planned - r.used);
    r.status = deriveStockStatus(r);
    out.push(r);
  }
  return out.sort((a, b) => a.description.localeCompare(b.description, 'pt-BR'));
}

function deriveStockStatus(r: StockRow): StockStatus {
  if (r.received === 0 && r.purchased === 0) return 'nao_comprado';
  if (r.purchased > 0 && r.received === 0) return 'pedido_aberto';
  if (r.used > r.planned && r.planned > 0) return 'consumo_acima';
  if (r.balance < 0) return 'falta_material';
  if (r.received > 0 && r.received < r.purchased) return 'recebido_parcial';
  if (r.balance > 0) return 'em_estoque';
  if (r.used > 0 && Math.abs(r.planned - r.used) < 0.01) return 'consumo_previsto';
  return 'em_estoque';
}

export function addStockMovement(project: Project, m: Omit<StockMovement, 'id' | 'createdAt'>): Project {
  const mv: StockMovement = { id: uid(), createdAt: nowISO(), ...m };
  return { ...project, stockMovements: [...(project.stockMovements ?? []), mv] };
}

export function removeStockMovement(project: Project, id: string): Project {
  return { ...project, stockMovements: (project.stockMovements ?? []).filter(m => m.id !== id) };
}

export type { StockMovement, StockMovementType };
