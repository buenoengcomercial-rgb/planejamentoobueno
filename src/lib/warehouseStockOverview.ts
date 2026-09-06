import type { MaterialCostClass, Project } from '@/types/project';
import { trunc2 } from '@/lib/financialEngine';
import {
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
 * Exibe somente itens com entrada fiscal. O orçamento enriquece os itens
 * vinculados, sem criar linhas de estoque ou alterar movimentos/painel.
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
  const fiscalKeys = new Set((project.warehouse?.movements ?? [])
    .filter(movement => movement.type === 'entrada' && (movement.fiscalNoteId || movement.invoiceNumber?.trim()))
    .map(movement => movement.itemKey));

  const physical = physicalRows.filter(row => fiscalKeys.has(row.key)).map(row => {
    const linked = row.projectLinks
      .map(link => ({ link, suggestion: suggestionsByKey.get(link.projectMaterialKey) }))
      .filter((entry): entry is { link: typeof row.projectLinks[number]; suggestion: MaterialSuggestion } => !!entry.suggestion);
    const additive = trunc2(linked.reduce((total, entry) => total + entry.suggestion.additiveQuantity * (Number(entry.link.conversionFactor) || 1), 0));
    const planned = trunc2(linked.reduce((total, entry) => total + entry.suggestion.quantity * (Number(entry.link.conversionFactor) || 1), 0));
    const contracted = trunc2(Math.max(0, planned - additive));
    return withStockRule(project, { ...row, planned }, {
      isPhysicalStock: true,
      contracted,
      additive,
      classificationSubject: linked[0]?.suggestion ?? fallbackSubject(row),
    });
  });

  const order: MaterialCostClass[] = ['material', 'labor', 'equipment', 'unclassified'];
  return physical.sort((left, right) => order.indexOf(left.costClass) - order.indexOf(right.costClass)
    || Number(right.isPhysicalStock) - Number(left.isPhysicalStock)
    || right.withdrawn - left.withdrawn
    || left.description.localeCompare(right.description, 'pt-BR'));
}
