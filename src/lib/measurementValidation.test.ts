import { describe, expect, it } from 'vitest';
import { validateMeasurement, type MinimalRow } from './measurementValidation';

const baseRow: MinimalRow = {
  taskId: 'task-1',
  itemCode: 'SINAPI 123',
  description: 'TAREFA DE TESTE',
  unit: 'UN',
  priceBank: 'SINAPI',
  unitPriceNoBDI: 10,
  qtyContracted: 10,
  qtyPeriod: 0,
  qtyPriorAccum: 0,
  qtyCurrentAccum: 0,
  qtyBalance: 10,
};

function validateRows(rows: MinimalRow[]) {
  return validateMeasurement({
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    measurementNumber: 1,
    rows,
    measurements: [],
    contract: {
      contractor: 'CONTRATANTE', contracted: 'CONTRATADA', contractNumber: '1',
      contractObject: 'OBJETO', location: 'LOCAL', budgetSource: 'ORÇAMENTO', bdiPercent: 25,
    },
  });
}

describe('validateMeasurement — apontamento de divergências por tarefa', () => {
  it('detalha a tarefa cuja medição do período supera o saldo disponível', () => {
    const issue = validateRows([{
      ...baseRow, qtyPriorAccum: 8, qtyPeriod: 3, qtyCurrentAccum: 11, qtyBalance: 0,
    }]).find(item => item.code === 'qty-over-balance');

    expect(issue?.affectedTaskIds).toEqual(['task-1']);
    expect(issue?.affectedTasks).toEqual([expect.objectContaining({
      taskId: 'task-1', itemCode: 'SINAPI 123', description: 'TAREFA DE TESTE', unit: 'UN',
      qtyContracted: 10, qtyPriorAccum: 8, qtyPeriod: 3, qtyBalanceBeforePeriod: 2,
    })]);
  });

  it('detalha a tarefa cujo acumulado supera o contratado e informa o excedente', () => {
    const issue = validateRows([{
      ...baseRow, qtyPriorAccum: 8, qtyPeriod: 3, qtyCurrentAccum: 11, qtyBalance: 0,
    }]).find(item => item.code === 'accum-over-contracted');

    expect(issue?.affectedTasks).toEqual([expect.objectContaining({
      taskId: 'task-1', qtyContracted: 10, qtyCurrentAccum: 11, qtyExcess: 1,
    })]);
  });

  it('lista somente as tarefas com divergência', () => {
    const issues = validateRows([
      { ...baseRow, taskId: 'task-ok', description: 'TAREFA CORRETA', qtyPeriod: 2, qtyCurrentAccum: 2, qtyBalance: 8 },
      { ...baseRow, taskId: 'task-over', description: 'TAREFA ACIMA DO SALDO', qtyPriorAccum: 9, qtyPeriod: 2, qtyCurrentAccum: 11, qtyBalance: 0 },
      { ...baseRow, taskId: 'task-over-2', description: 'SEGUNDA TAREFA ACIMA DO SALDO', qtyPriorAccum: 8, qtyPeriod: 3, qtyCurrentAccum: 11, qtyBalance: 0 },
    ]);

    expect(issues.find(item => item.code === 'qty-over-balance')?.affectedTasks?.map(task => task.taskId)).toEqual(['task-over', 'task-over-2']);
    expect(issues.find(item => item.code === 'accum-over-contracted')?.affectedTasks?.map(task => task.taskId)).toEqual(['task-over', 'task-over-2']);
    expect(issues.find(item => item.code === 'contract-incomplete')?.affectedTasks).toBeUndefined();
  });
});
