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
  groupMemberKeys?: string[];
  searchText?: string;
  purchaseGroupIds?: string[];
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
export function computeWarehouseStockOverviewRows(project: Project, includeArchived = false, combineGroups = true): WarehouseStockOverviewRow[] {
  const physicalRows = computeWarehouseRows(project, {
    materialOnly: true,
    confirmedOnly: true,
    includeManual: true,
    includeArchived,
  });
  const suggestions = suggestMaterialsFromProject(project).filter(suggestion => !suggestion.warning);
  const suggestionsByKey = new Map(suggestions.map(suggestion => [suggestion.key, suggestion] as const));
  const fiscalKeys = new Set((project.warehouse?.movements ?? [])
    .filter(movement => movement.type === 'entrada' && !movement.reversedById && (movement.fiscalNoteId || movement.invoiceNumber?.trim()))
    .map(movement => movement.itemKey));

  const eligible = physicalRows.filter(row => fiscalKeys.has(row.key));
  const byKey = new Map(eligible.map(row => [row.key, row]));
  const groupedSources = new Map<string, WarehouseRow[]>();
  if (combineGroups) for (const item of project.warehouse?.items ?? []) {
    const source = byKey.get(item.key);
    const target = item.groupedWithKey ? byKey.get(item.groupedWithKey) : undefined;
    if (source && target && source.key !== target.key && source.unit.trim().toLowerCase() === target.unit.trim().toLowerCase()) {
      groupedSources.set(target.key, [...(groupedSources.get(target.key) ?? []), source]);
    }
  }
  const hiddenKeys = new Set([...groupedSources.values()].flat().map(row => row.key));
  const physical = eligible.filter(row => !hiddenKeys.has(row.key)).map(primary => {
    const members = [primary, ...(groupedSources.get(primary.key) ?? [])];
    const uniqueLinks = new Map<string, WarehouseRow['projectLinks'][number]>();
    for (const member of members) for (const link of member.projectLinks) {
      if (!uniqueLinks.has(link.projectMaterialKey)) uniqueLinks.set(link.projectMaterialKey, link);
    }
    const projectLinks = [...uniqueLinks.values()];
    const linked = projectLinks
      .map(link => ({ link, suggestion: suggestionsByKey.get(link.projectMaterialKey) }))
      .filter((entry): entry is { link: WarehouseRow['projectLinks'][number]; suggestion: MaterialSuggestion } => !!entry.suggestion);
    const additive = trunc2(linked.reduce((total, entry) => total + entry.suggestion.additiveQuantity * (Number(entry.link.conversionFactor) || 1), 0));
    const planned = trunc2(linked.reduce((total, entry) => total + entry.suggestion.quantity * (Number(entry.link.conversionFactor) || 1), 0));
    const contracted = trunc2(Math.max(0, planned - additive));
    const sum = (field: 'purchased' | 'received' | 'withdrawn' | 'returned' | 'losses' | 'adjustments' | 'balance' | 'consumedCost') => trunc2(members.reduce((total, row) => total + row[field], 0));
    const incomplete = members.some(row => row.valuationIncomplete);
    const inventoryValue = incomplete ? undefined : trunc2(members.reduce((total, row) => total + (row.inventoryValue ?? 0), 0));
    const balance = sum('balance');
    const row = members.length === 1 ? primary : {
      ...primary,
      purchased: sum('purchased'), received: sum('received'), withdrawn: sum('withdrawn'),
      returned: sum('returned'), losses: sum('losses'), adjustments: sum('adjustments'), balance,
      consumedCost: sum('consumedCost'), inventoryValue, valuationIncomplete: incomplete,
      averageUnitCost: inventoryValue != null && balance > 0 ? trunc2(inventoryValue / balance) : undefined,
      lastMovementDate: members.map(member => member.lastMovementDate ?? '').sort().at(-1) || undefined,
      projectLinks,
      linkStatus: projectLinks.length ? 'linked' as const : primary.linkStatus,
    };
    return {
      ...withStockRule(project, { ...row, planned }, {
        isPhysicalStock: true,
        contracted,
        additive,
        classificationSubject: primary.projectLinks.map(link => suggestionsByKey.get(link.projectMaterialKey)).find(Boolean) ?? fallbackSubject(primary),
      }),
      ...(members.length > 1 ? {
        groupMemberKeys: members.map(member => member.key),
        searchText: members.map(member => `${member.description} ${member.code ?? ''}`).join(' '),
        purchaseGroupIds: [...new Set(members.flatMap(member => member.purchaseGroupId ? [member.purchaseGroupId] : []))],
      } : {}),
    };
  });

  const order: MaterialCostClass[] = ['material', 'labor', 'equipment', 'unclassified'];
  return physical.sort((left, right) => order.indexOf(left.costClass) - order.indexOf(right.costClass)
    || Number(right.isPhysicalStock) - Number(left.isPhysicalStock)
    || right.withdrawn - left.withdrawn
    || left.description.localeCompare(right.description, 'pt-BR'));
}
