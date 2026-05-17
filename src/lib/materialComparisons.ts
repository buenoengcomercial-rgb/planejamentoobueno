import type {
  Project,
  MaterialComparison,
  ComparisonSupplier,
  ComparisonItem,
  ComparisonItemPrice,
  ComparisonItemStatus,
  PriceHistoryEntry,
  MaterialComparisonStatus,
} from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';

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

export interface MaterialSuggestion {
  key: string;
  description: string;
  unit: string;
  quantity: number;
  code?: string;
  bank?: string;
  referencePrice?: number;
  sourceType: MaterialSuggestionSource;
  sourceId: string;
  /** Aviso opcional (ex.: composição sem analítico). */
  warning?: string;
}

export interface MaterialSuggestionDiagnostics {
  baseCompositionsWithAnalytic: number;
  baseCompositionsWithoutAnalytic: number;
  baseAnalyticInputs: number;
  contractedAdditivesRead: number;
  syntheticCompositionsIgnored: number;
  taskMaterials: number;
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
    baseCompositionsWithAnalytic: 0,
    baseCompositionsWithoutAnalytic: 0,
    baseAnalyticInputs: 0,
    contractedAdditivesRead: 0,
    syntheticCompositionsIgnored: 0,
    taskMaterials: 0,
  };

  const upsert = (s: MaterialSuggestion) => {
    const cur = suggestions.get(s.key);
    if (cur) {
      cur.quantity = +(cur.quantity + s.quantity).toFixed(4);
      if (!cur.referencePrice && s.referencePrice) cur.referencePrice = s.referencePrice;
    } else {
      suggestions.set(s.key, { ...s });
    }
  };

  // A) Insumos analíticos do CONTRATO/BASE (planilha Analítica).
  for (const comp of project.analyticCompositions ?? []) {
    const compQty = comp.quantity || 0;
    const inputs = comp.inputs ?? [];
    if (inputs.length === 0) {
      diag.baseCompositionsWithoutAnalytic += 1;
      const key = `__warn_base__${comp.id}`;
      suggestions.set(key, {
        key,
        description: `${comp.description} — composição base sem analítico vinculado`,
        unit: comp.unit,
        quantity: 0,
        code: comp.code,
        sourceType: 'analytic_input',
        sourceId: comp.id,
        warning: 'Composição base sem analítico vinculado',
      });
      continue;
    }
    diag.baseCompositionsWithAnalytic += 1;
    for (const inp of inputs) {
      const qty = +((inp.coefficient || 0) * compQty).toFixed(4);
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
      });
    }
  }

  // Sintéticas sem analítica vinculada são apenas contabilizadas (ignoradas como material).
  for (const bi of project.budgetItems ?? []) {
    if (bi.source !== 'sintetica') continue;
    const hasAnalytic = (project.analyticCompositions ?? []).some(
      c => c.code === bi.code && c.bank === bi.bank,
    );
    if (!hasAnalytic) diag.syntheticCompositionsIgnored += 1;
  }

  // B) Materiais manuais declarados nas tarefas (task.materials).
  const tasks = getAllTasks(project);
  for (const t of tasks) {
    for (const m of t.materials ?? []) {
      diag.taskMaterials += 1;
      const refPrice = m.estimatedCost && m.quantity ? +(m.estimatedCost / m.quantity).toFixed(2) : undefined;
      upsert({
        key: makeKey(undefined, m.name, m.unit),
        description: m.name,
        unit: m.unit,
        quantity: m.quantity || 0,
        referencePrice: refPrice,
        sourceType: 'task_material',
        sourceId: t.id,
      });
    }
  }

  // C) Insumos analíticos das composições de aditivos APROVADOS/CONTRATADOS.
  //    Rascunho ou em análise NÃO entram. Composição sintética principal NÃO entra.
  for (const ad of project.additives ?? []) {
    const approved = ad.isContracted === true || ad.status === 'aditivo_contratado';
    if (!approved) continue;
    diag.contractedAdditivesRead += 1;
    for (const comp of ad.compositions ?? []) {
      const compQty = comp.quantity || 0;
      const inputs = comp.inputs ?? [];
      if (inputs.length === 0) {
        const key = `__warn_add__${comp.id}`;
        suggestions.set(key, {
          key,
          description: `${comp.description} — composição de aditivo sem analítico vinculado`,
          unit: comp.unit,
          quantity: 0,
          code: comp.code,
          sourceType: 'additive_input',
          sourceId: comp.id,
          warning: 'Composição de aditivo sem analítico vinculado',
        });
        continue;
      }
      for (const inp of inputs) {
        const qty = +((inp.coefficient || 0) * compQty).toFixed(4);
        if (!qty) continue;
        upsert({
          key: makeKey(inp.code, inp.description, inp.unit, inp.bank),
          description: inp.description,
          unit: inp.unit,
          quantity: qty,
          code: inp.code || undefined,
          bank: inp.bank || undefined,
          referencePrice: inp.unitPrice || undefined,
          sourceType: 'additive_input',
          sourceId: inp.id,
        });
      }
    }
  }

  const sorted = Array.from(suggestions.values()).sort((a, b) =>
    a.description.localeCompare(b.description, 'pt-BR'),
  );
  return { suggestions: sorted, diagnostics: diag };
}

export const STATUS_LABEL: Record<MaterialComparisonStatus, string> = {
  rascunho: 'Rascunho',
  em_cotacao: 'Em cotação',
  fechado: 'Fechado',
  comprado: 'Comprado',
};
