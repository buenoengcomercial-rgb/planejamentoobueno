import type { MaterialCostClass, Project } from '@/types/project';
import { trunc2 } from '@/lib/financialEngine';
import {
  isFullySuppressedSuggestion,
  resolveMaterialCostClass,
  suggestMaterialsFromProject,
  type MaterialSuggestion,
  type SuggestionLikeKey,
} from '@/lib/materialComparisons';
import { computeWarehouseRows, type WarehouseRow } from '@/lib/warehouse';

export type WarehouseStockOverviewRow = WarehouseRow & {
  isPhysicalStock: boolean;
  contracted: number;
  additive: number;
  automaticMinStock?: number;
  effectiveMinStock?: number;
  costClass: MaterialCostClass;
  classificationSubject: SuggestionLikeKey & Pick<MaterialSuggestion, 'sourceType' | 'legacyInputType'>;
};

function fallbackSubject(row: WarehouseRow): WarehouseStockOverviewRow['classificationSubject'] {
  return {
    code: row.code,
    description: row.description,
    unit: row.unit,
    sourceType: undefined,
    legacyInputType: undefined,
  };
}

function withStockRule(project: Project, row: WarehouseRow, input: {
  isPhysicalStock: boolean;
  contracted: number;
  additive: number;
  classificationSubject: WarehouseStockOverviewRow['classificationSubject'];
}): WarehouseStockOverviewRow {
  const costClass = resolveMaterialCostClass(project, input.classificationSubject);
  const automaticMinStock = input.isPhysicalStock && costClass === 'material' && row.planned > 0
    ? trunc2(row.planned * 0.3)
    : undefined;
  const effectiveMinStock = input.isPhysicalStock && costClass === 'material'
    ? Math.max(row.minStock ?? 0, automaticMinStock ?? 0)
    : undefined;
  return {
    ...row,
    isPhysicalStock: input.isPhysicalStock,
    contracted: trunc2(Math.max(0, input.contracted)),
    additive: trunc2(Math.max(0, input.additive)),
    automaticMinStock,
    effectiveMinStock: effectiveMinStock && effectiveMinStock > 0 ? trunc2(effectiveMinStock) : undefined,
    underMin: !!effectiveMinStock && row.balance < effectiveMinStock,
    costClass,
    classificationSubject: input.classificationSubject,
  };
}

/**
 * Junta a posição física do almoxarifado com o planejamento do contrato e do
 * aditivo. Esta é uma visão de consulta: não altera os totais físicos usados
 * pelo painel nem cria movimentos para mão de obra ou equipamentos.
 */
export function computeWarehouseStockOverviewRows(project: Project, includeArchived = false): WarehouseStockOverviewRow[] {
  const physicalRows = computeWarehouseRows(project, {
    materialOnly: true,
    confirmedOnly: true,
    includeManual: true,
    includeArchived,
  });
  const suggestions = suggestMaterialsFromProject(project).filter(suggestion => !suggestion.warning);
  const suggestionsByKey = new Map(suggestions.map(suggestion => [suggestion.key, suggestion] as const));
  const linkedSuggestionKeys = new Set<string>();

  const physical = physicalRows.map(row => {
    const linked = row.projectLinks
      .map(link => ({ link, suggestion: suggestionsByKey.get(link.projectMaterialKey) }))
      .filter((entry): entry is { link: typeof row.projectLinks[number]; suggestion: MaterialSuggestion } => !!entry.suggestion);
    linked.forEach(entry => linkedSuggestionKeys.add(entry.suggestion.key));
    const additive = trunc2(linked.reduce((total, entry) => total + entry.suggestion.additiveQuantity * (Number(entry.link.conversionFactor) || 1), 0));
    const contracted = trunc2(Math.max(0, row.planned - additive));
    return withStockRule(project, row, {
      isPhysicalStock: true,
      contracted,
      additive,
      classificationSubject: linked[0]?.suggestion ?? fallbackSubject(row),
    });
  });

  const planningOnly = suggestions
    .filter(suggestion => !linkedSuggestionKeys.has(suggestion.key) && !isFullySuppressedSuggestion(suggestion))
    .map(suggestion => withStockRule(project, {
      key: `planning|${suggestion.key}`,
      code: suggestion.code,
      description: suggestion.description,
      unit: suggestion.unit,
      planned: suggestion.quantity,
      purchased: 0,
      received: 0,
      returned: 0,
      withdrawn: 0,
      losses: 0,
      adjustments: 0,
      balance: 0,
      underMin: false,
      projectLinks: [],
      linkStatus: 'pending',
      consumedCost: 0,
      valuationIncomplete: false,
    }, {
      isPhysicalStock: false,
      contracted: suggestion.contractedQuantity,
      additive: suggestion.additiveQuantity,
      classificationSubject: suggestion,
    }));

  const order: MaterialCostClass[] = ['material', 'labor', 'equipment', 'unclassified'];
  return [...physical, ...planningOnly].sort((left, right) => order.indexOf(left.costClass) - order.indexOf(right.costClass)
    || Number(right.isPhysicalStock) - Number(left.isPhysicalStock)
    || right.withdrawn - left.withdrawn
    || left.description.localeCompare(right.description, 'pt-BR'));
}
