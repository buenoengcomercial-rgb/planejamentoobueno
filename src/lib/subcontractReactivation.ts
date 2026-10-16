import type { Subcontract } from '@/types/project';
import { allocateSubcontractValue, freezeSubcontractPayments, subcontractPaidValue } from './subcontracts';

export interface ReactivationCatalogItem { id: string; laborCost: number }

export function reactivationAvailability(contract: Subcontract, contracts: Subcontract[], catalog: ReactivationCatalogItem[]) {
  return contract.items.map(item => {
    const matches = catalog.filter(row => row.id === item.compositionId);
    const owners = contracts.filter(other => other.id !== contract.id && other.status !== 'cancelled'
      && other.items.some(allocation => allocation.compositionId === item.compositionId
        || (allocation.item === item.item && allocation.code === item.code && allocation.bank === item.bank)));
    const duplicate = contract.items.filter(other => other.compositionId === item.compositionId).length !== 1;
    const issue = matches.length !== 1 || duplicate ? 'Vínculo ausente ou ambíguo; revise a composição.'
      : !(matches[0].laborCost > 0) ? 'Referência de mão de obra indisponível; revise a composição.' : undefined;
    return { item, row: matches[0], owners, issue, free: !issue && owners.length === 0 };
  });
}

export function lifecycleHistory(contract: Subcontract): NonNullable<Subcontract['lifecycleEvents']> {
  const events = contract.lifecycleEvents ?? [];
  if (!contract.cancelledAt || events.some(event => event.action === 'cancelled' && event.at === contract.cancelledAt)) return events;
  return [...events, { id: `legacy-cancel:${contract.id}:${contract.cancelledAt}`, action: 'cancelled', at: contract.cancelledAt,
    by: contract.cancelledBy, reason: contract.cancellationReason || 'Cancelamento anterior' }];
}

export function cancelSubcontract(contract: Subcontract, reason: string, at: string, by?: string): Subcontract {
  return { ...contract, status: 'cancelled', cancelledAt: at, cancelledBy: by, cancellationReason: reason.trim(), updatedAt: at, updatedBy: by,
    lifecycleEvents: [...lifecycleHistory(contract), { id: crypto.randomUUID(), action: 'cancelled', at, by, reason: reason.trim() }] };
}

export function reactivateSubcontract(contract: Subcontract, contracts: Subcontract[], catalog: ReactivationCatalogItem[],
  selectedIds: string[], total: number, reason: string, at: string, by?: string): Subcontract {
  if (contract.status !== 'cancelled') throw new Error('O contrato não está mais cancelado. Atualize a lista.');
  if (!reason.trim()) throw new Error('Informe o motivo da reativação.');
  if (!Number.isFinite(total) || total <= 0 || Math.round(total * 100) / 100 !== total || total < subcontractPaidValue(contract)) {
    throw new Error('Informe um total positivo, em centavos, que cubra o valor líquido já pago.');
  }
  const available = reactivationAvailability(contract, contracts, catalog);
  const selected = available.filter(row => selectedIds.includes(row.item.id));
  if (!selected.length || new Set(selectedIds).size !== selectedIds.length || selected.length !== selectedIds.length || selected.some(row => !row.free)) {
    throw new Error('Selecione somente atividades livres e com vínculo válido. Atualize a revisão.');
  }
  const items = allocateSubcontractValue(total, selected.map(({ item, row }) => ({ ...item, referenceLaborCost: row.laborCost })))
    .map(({ allocatedAmount, ...item }) => ({ ...item, contractedAmount: allocatedAmount }));
  return { ...contract, status: 'contracted', items, contractedValue: total, payments: freezeSubcontractPayments(contract),
    updatedAt: at, updatedBy: by,
    amendments: [...(contract.amendments ?? []), { id: crypto.randomUUID(), date: at.slice(0, 10), reason: `Reativação: ${reason.trim()}`,
      previousContractedValue: contract.contractedValue, nextContractedValue: total, previousItems: contract.items, nextItems: items, createdAt: at, createdBy: by }],
    lifecycleEvents: [...lifecycleHistory(contract), { id: crypto.randomUUID(), action: 'reactivated', at, by, reason: reason.trim() }],
  };
}
