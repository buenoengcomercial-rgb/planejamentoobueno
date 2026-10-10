import { monthlyLines, measurementBulletin, type MeasurementWorkspace } from './measurementWorkspace';
import { validateMeasurement, type ValidationIssue } from './measurementValidation';

/**
 * Mirrors the existing Medição fiscal checks using the independent workspace.
 * Diário warnings are intentionally absent: a Project prop can lag behind the
 * independently stored Diário, so it is not evidence suitable for fiscal envio.
 */
export function fiscalReviewIssuesForWorkspace(workspace: MeasurementWorkspace, periodId: string): ValidationIssue[] {
  const period = workspace.periods.find(item => item.id === periodId);
  if (!period) throw new Error('Medição não encontrada.');

  const rows = monthlyLines(workspace, periodId).map(line => ({
    taskId: line.service.sourceTaskId ?? line.service.id,
    itemNumber: line.service.item,
    description: line.service.description,
    unit: line.service.unit,
    itemCode: line.service.code ?? '',
    priceBank: line.service.bank ?? '',
    unitPriceNoBDI: line.service.priceNoBDI,
    qtyContracted: line.service.contracted,
    qtyPeriod: line.qty,
    qtyPriorAccum: line.prior,
    qtyCurrentAccum: line.accumulated,
    qtyBalance: line.balance,
  }));
  const contract = measurementBulletin(workspace, periodId).contract;

  return validateMeasurement({
    startDate: period.startDate,
    endDate: period.endDate,
    measurementNumber: period.number,
    rows,
    measurements: workspace.periods.filter(item => item.id !== periodId).map(item => ({
      id: item.id,
      number: item.number,
      startDate: item.startDate,
      endDate: item.endDate,
    })),
    contract,
  }, { mode: 'fiscal-review' }).map(issue => issue.code === 'no-items' ? {
    ...issue,
    message: 'Não há itens medidos neste período. Lance quantitativos na medição atual antes do envio à fiscalização.',
  } : issue);
}
