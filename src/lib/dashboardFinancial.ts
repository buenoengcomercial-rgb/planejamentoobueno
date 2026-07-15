import type { MaterialCostClass, Project, ComparisonItem, ComparisonItemPrice } from '@/types/project';
import {
  linkKeyOf,
  MATERIAL_COST_CLASS_LABEL,
  MATERIAL_COST_CLASS_ORDER,
  resolveMaterialCostClass,
  suggestMaterialsFromProject,
  type MaterialSuggestion,
} from '@/lib/materialComparisons';
import { money2, trunc2 } from '@/lib/financialEngine';

export interface DashboardQuoteSelection {
  key: string;
  item: ComparisonItem;
  unitPrice: number;
  supplierId?: string;
}

export interface DashboardClassComparisonRow {
  costClass: MaterialCostClass;
  label: string;
  budgetTotal: number;
  quotedBudgetTotal: number;
  quotedLocalTotal: number;
  savings: number;
  savingsPct: number;
  quotedItemsCount: number;
  pendingItemsCount: number;
}

export interface DashboardFinancialSummary {
  budgetDirectCost: number;
  bdiPercent: number;
  bdiValue: number;
  contractedWithBdi: number;
  eligibleBudgetTotal: number;
  quotedBudgetTotal: number;
  quotedLocalTotal: number;
  savings: number;
  savingsPct: number;
  quoteCoveragePct: number;
  quotedItemsCount: number;
  pendingQuoteItemsCount: number;
  classRows: DashboardClassComparisonRow[];
  totalsRow: DashboardClassComparisonRow;
}

function validPrice(price: ComparisonItemPrice | undefined): price is ComparisonItemPrice {
  return !!price && Number.isFinite(Number(price.price)) && Number(price.price) >= 0 && price.available !== false;
}

function selectQuote(item: ComparisonItem): number | undefined {
  const chosen = item.chosenSupplierId
    ? item.prices.find(price => price.supplierId === item.chosenSupplierId)
    : undefined;
  if (validPrice(chosen)) return trunc2(chosen.price);

  const valid = item.prices.filter(validPrice);
  if (valid.length === 0) return undefined;
  return trunc2(valid.reduce((best, price) => price.price < best.price ? price : best, valid[0]).price);
}

function referenceTotal(item: MaterialSuggestion) {
  if (item.warning || item.quantity <= 0 || item.referencePrice == null || item.referencePrice < 0) return 0;
  return trunc2(item.quantity * item.referencePrice);
}

function buildQuoteIndex(project: Project): Map<string, DashboardQuoteSelection> {
  const byKey = new Map<string, DashboardQuoteSelection>();

  for (const comparison of project.materialComparisons ?? []) {
    for (const item of comparison.items ?? []) {
      const unitPrice = selectQuote(item);
      if (unitPrice == null) continue;

      const key = linkKeyOf(item);
      const current = byKey.get(key);
      if (!current || unitPrice < current.unitPrice) {
        byKey.set(key, { key, item, unitPrice, supplierId: item.chosenSupplierId });
      }
    }
  }

  return byKey;
}

function emptyClassRow(costClass: MaterialCostClass): DashboardClassComparisonRow {
  return {
    costClass,
    label: MATERIAL_COST_CLASS_LABEL[costClass],
    budgetTotal: 0,
    quotedBudgetTotal: 0,
    quotedLocalTotal: 0,
    savings: 0,
    savingsPct: 0,
    quotedItemsCount: 0,
    pendingItemsCount: 0,
  };
}

export function buildDashboardFinancialSummary(project: Project): DashboardFinancialSummary {
  const budgetItems = (project.budgetItems ?? []).filter(item => item.source === 'sintetica' || item.source === 'aditivo');
  const budgetDirectCost = money2(budgetItems.reduce((sum, item) => sum + (Number(item.totalNoBDI) || 0), 0));
  const contractedWithBdi = money2(budgetItems.reduce((sum, item) => sum + (Number(item.totalWithBDI) || 0), 0));
  const bdiValue = money2(Math.max(0, contractedWithBdi - budgetDirectCost));
  const impliedBdi = budgetDirectCost > 0 ? trunc2((bdiValue / budgetDirectCost) * 100) : 0;
  const bdiPercent = project.syntheticBdiPercent ?? project.contractInfo?.bdiPercent ?? impliedBdi;

  const suggestions = suggestMaterialsFromProject(project).filter(item => !item.warning && referenceTotal(item) > 0);
  const quotes = buildQuoteIndex(project);
  const rows = new Map<MaterialCostClass, DashboardClassComparisonRow>();
  MATERIAL_COST_CLASS_ORDER.forEach(costClass => rows.set(costClass, emptyClassRow(costClass)));

  const seenQuotedKeys = new Set<string>();

  for (const item of suggestions) {
    const costClass = resolveMaterialCostClass(project, item);
    const row = rows.get(costClass)!;
    const budgetTotal = referenceTotal(item);
    const key = linkKeyOf(item);
    const quote = quotes.get(key);

    row.budgetTotal = money2(row.budgetTotal + budgetTotal);

    if (quote) {
      const quotedLocalTotal = trunc2(quote.unitPrice * item.quantity);
      row.quotedBudgetTotal = money2(row.quotedBudgetTotal + budgetTotal);
      row.quotedLocalTotal = money2(row.quotedLocalTotal + quotedLocalTotal);
      row.quotedItemsCount += 1;
      seenQuotedKeys.add(key);
    } else {
      row.pendingItemsCount += 1;
    }
  }

  const classRows = MATERIAL_COST_CLASS_ORDER.map(costClass => {
    const row = rows.get(costClass)!;
    const savings = money2(row.quotedBudgetTotal - row.quotedLocalTotal);
    return {
      ...row,
      budgetTotal: money2(row.budgetTotal),
      quotedBudgetTotal: money2(row.quotedBudgetTotal),
      quotedLocalTotal: money2(row.quotedLocalTotal),
      savings,
      savingsPct: row.quotedBudgetTotal > 0 ? trunc2((savings / row.quotedBudgetTotal) * 100) : 0,
    };
  });

  const eligibleBudgetTotal = money2(classRows.reduce((sum, row) => sum + row.budgetTotal, 0));
  const quotedBudgetTotal = money2(classRows.reduce((sum, row) => sum + row.quotedBudgetTotal, 0));
  const quotedLocalTotal = money2(classRows.reduce((sum, row) => sum + row.quotedLocalTotal, 0));
  const savings = money2(quotedBudgetTotal - quotedLocalTotal);
  const pendingQuoteItemsCount = classRows.reduce((sum, row) => sum + row.pendingItemsCount, 0);

  const totalsRow: DashboardClassComparisonRow = {
    costClass: 'unclassified',
    label: 'Total geral',
    budgetTotal: eligibleBudgetTotal,
    quotedBudgetTotal,
    quotedLocalTotal,
    savings,
    savingsPct: quotedBudgetTotal > 0 ? trunc2((savings / quotedBudgetTotal) * 100) : 0,
    quotedItemsCount: seenQuotedKeys.size,
    pendingItemsCount: pendingQuoteItemsCount,
  };

  return {
    budgetDirectCost,
    bdiPercent,
    bdiValue,
    contractedWithBdi,
    eligibleBudgetTotal,
    quotedBudgetTotal,
    quotedLocalTotal,
    savings,
    savingsPct: totalsRow.savingsPct,
    quoteCoveragePct: eligibleBudgetTotal > 0 ? trunc2((quotedBudgetTotal / eligibleBudgetTotal) * 100) : 0,
    quotedItemsCount: totalsRow.quotedItemsCount,
    pendingQuoteItemsCount,
    classRows,
    totalsRow,
  };
}
