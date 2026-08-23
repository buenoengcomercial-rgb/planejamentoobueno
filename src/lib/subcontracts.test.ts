import { describe, expect, it } from 'vitest';
import { allocateSubcontractValue, allocatedPaymentValue, freezeSubcontractPayments, subcontractBalance } from '@/lib/subcontracts';
import type { Subcontract } from '@/types/project';

describe('terceirização de mão de obra', () => {
  it('rateia proporcionalmente e conserva exatamente os centavos', () => {
    const result = allocateSubcontractValue(100, [
      { compositionId: 'a', referenceLaborCost: 1 },
      { compositionId: 'b', referenceLaborCost: 2 },
      { compositionId: 'c', referenceLaborCost: 3 },
    ]);
    expect(result.map(item => item.allocatedAmount)).toEqual([16.67, 33.33, 50]);
    expect(result.reduce((sum, item) => sum + item.allocatedAmount, 0)).toBe(100);
  });

  it('distribui pagamentos parciais usando o mesmo rateio congelado', () => {
    const contract: Subcontract = {
      id: 's', name: 'Iluminação', contractorName: 'Prestador', contractDate: '2026-08-22', contractedValue: 300,
      status: 'contracted', createdAt: '2026-08-22T00:00:00Z', items: [
        { id: 'a', compositionId: 'a', item: '1', description: 'A', unit: 'un', referenceLaborCost: 100, allocationPercent: 33.333, contractedAmount: 100 },
        { id: 'b', compositionId: 'b', item: '2', description: 'B', unit: 'un', referenceLaborCost: 200, allocationPercent: 66.667, contractedAmount: 200 },
      ], payments: [{ id: 'p', date: '2026-08-22', amount: 90, createdAt: '2026-08-22T00:00:00Z' }],
    };
    expect(allocatedPaymentValue(contract, contract.items[0])).toBe(30);
    expect(allocatedPaymentValue(contract, contract.items[1])).toBe(60);
    expect(subcontractBalance(contract)).toBe(210);
  });

  it('preserva o rateio de pagamentos legados após alteração das atividades do pacote', () => {
    const contract: Subcontract = {
      id: 's', name: 'Iluminação', contractorName: 'Prestador', contractDate: '2026-08-22', contractedValue: 300,
      status: 'contracted', createdAt: '2026-08-22T00:00:00Z', items: [
        { id: 'a', compositionId: 'a', item: '1', description: 'A', unit: 'un', referenceLaborCost: 100, allocationPercent: 33.333, contractedAmount: 100 },
        { id: 'b', compositionId: 'b', item: '2', description: 'B', unit: 'un', referenceLaborCost: 200, allocationPercent: 66.667, contractedAmount: 200 },
      ], payments: [{ id: 'p', date: '2026-08-22', amount: 90, createdAt: '2026-08-22T00:00:00Z' }],
    };
    const frozen = { ...contract, payments: freezeSubcontractPayments(contract), items: [contract.items[0]] };
    expect(frozen.payments[0].allocations).toEqual([{ allocationId: 'a', amount: 30 }, { allocationId: 'b', amount: 60 }]);
    expect(allocatedPaymentValue(frozen, frozen.items[0])).toBe(30);
  });
});
