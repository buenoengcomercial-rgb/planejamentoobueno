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
  const existing = project.materialPriceHistory ?? [];
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

export interface MaterialSuggestion {
  key: string;
  description: string;
  unit: string;
  quantity: number;
  code?: string;
  referencePrice?: number;
  sourceType: 'task' | 'composition' | 'additive';
  sourceId: string;
}

export function suggestMaterialsFromProject(project: Project): MaterialSuggestion[] {
  const suggestions = new Map<string, MaterialSuggestion>();
  const tasks = getAllTasks(project);
  for (const t of tasks) {
    for (const m of t.materials ?? []) {
      const key = `${m.name}__${m.unit}`.toLowerCase();
      const cur = suggestions.get(key);
      const refPrice = m.estimatedCost && m.quantity ? +(m.estimatedCost / m.quantity).toFixed(2) : undefined;
      if (cur) {
        cur.quantity += m.quantity || 0;
      } else {
        suggestions.set(key, {
          key,
          description: m.name,
          unit: m.unit,
          quantity: m.quantity || 0,
          referencePrice: refPrice,
          sourceType: 'task',
          sourceId: t.id,
        });
      }
    }
  }
  for (const bi of project.budgetItems ?? []) {
    const key = `bi__${bi.code || bi.description}__${bi.unit}`.toLowerCase();
    if (suggestions.has(key)) continue;
    suggestions.set(key, {
      key,
      description: bi.description,
      unit: bi.unit,
      quantity: bi.quantity,
      code: bi.code,
      referencePrice: bi.unitPriceWithBDI,
      sourceType: bi.source === 'aditivo' ? 'additive' : 'composition',
      sourceId: bi.id,
    });
  }
  return Array.from(suggestions.values()).sort((a, b) => a.description.localeCompare(b.description, 'pt-BR'));
}

export const STATUS_LABEL: Record<MaterialComparisonStatus, string> = {
  rascunho: 'Rascunho',
  em_cotacao: 'Em cotação',
  fechado: 'Fechado',
  comprado: 'Comprado',
};
