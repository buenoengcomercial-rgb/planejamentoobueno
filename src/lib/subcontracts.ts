import type { Project, Subcontract, SubcontractItemAllocation, SubcontractPayment } from '@/types/project';
import { money2 } from '@/lib/financialEngine';

export interface SubcontractAllocationCandidate {
  compositionId: string;
  referenceLaborCost: number;
}

/** Rateia centavos pelo peso congelado da mão de obra de referência. */
export function allocateSubcontractValue<T extends SubcontractAllocationCandidate>(
  total: number,
  items: T[],
): Array<T & { allocationPercent: number; allocatedAmount: number }> {
  const safeTotal = money2(Math.max(0, Number(total) || 0));
  const base = items.reduce((sum, item) => sum + Math.max(0, Number(item.referenceLaborCost) || 0), 0);
  if (items.length === 0 || base <= 0) return [];
  let allocated = 0;
  return items.map((item, index) => {
    const allocationPercent = (Math.max(0, Number(item.referenceLaborCost) || 0) / base) * 100;
    const allocatedAmount = index === items.length - 1
      ? money2(safeTotal - allocated)
      : money2(safeTotal * allocationPercent / 100);
    allocated += allocatedAmount;
    return { ...item, allocationPercent, allocatedAmount };
  });
}

export function activePayments(payments: SubcontractPayment[]) {
  return payments.filter(payment => !payment.reversedAt);
}

export function subcontractPaidValue(subcontract: Subcontract) {
  return money2(activePayments(subcontract.payments).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0));
}

export function subcontractBalance(subcontract: Subcontract) {
  return money2((Number(subcontract.contractedValue) || 0) - subcontractPaidValue(subcontract));
}

export function allocatedPaymentValue(subcontract: Subcontract, allocation: SubcontractItemAllocation) {
  return activePayments(subcontract.payments).reduce((sum, payment) => {
    const allocations = allocateSubcontractValue(Number(payment.amount) || 0, subcontract.items);
    const current = allocations.find(item => item.id === allocation.id);
    return sum + (current?.allocatedAmount ?? 0);
  }, 0);
}

/** Total físico já apontado para uma composição terceirizada em todos os diários. */
export function subcontractExecutedQuantity(project: Project, allocationId: string) {
  return (project.phases ?? []).reduce((phaseTotal, phase) => phaseTotal + phase.tasks.reduce((taskTotal, task) => taskTotal +
    (task.dailyLogs ?? []).reduce((logsTotal, log) => logsTotal +
      (log.subcontractExecutions ?? [])
        .filter(execution => execution.allocationId === allocationId)
        .reduce((sum, execution) => sum + Math.max(0, Number(execution.quantity) || 0), 0), 0), 0), 0);
}
