import { describe, expect, it } from 'vitest';
import type { Additive, AdditiveComposition, Project } from '@/types/project';
import { contractAdditive } from './additiveImport';

const composition = (
  id: string,
  taskId: string,
  originalQuantity: number,
  addedQuantity: number,
  suppressedQuantity: number,
): AdditiveComposition => ({
  id,
  item: '1.1.1',
  itemNumber: '1.1.1',
  code: 'ADM04',
  bank: 'PROPRIO',
  description: 'Administracao de Obra',
  quantity: originalQuantity,
  unit: 'MES',
  unitPriceNoBDI: 12_595.53,
  unitPriceWithBDI: 16_069.37,
  total: 160_693.7,
  inputs: [],
  changeKind: addedQuantity > 0 ? 'acrescido' : 'suprimido',
  originalQuantity,
  addedQuantity,
  suppressedQuantity,
  taskId,
  phaseId: 'sub-1-1',
});

const additive = (
  id: string,
  effectiveDate: string,
  comp: AdditiveComposition,
): Additive => ({
  id,
  name: id,
  importedAt: '2026-07-30T00:00:00.000Z',
  status: 'aprovado',
  approvedAt: '2026-07-30T00:00:00.000Z',
  effectiveDate,
  bdiPercent: 27.58,
  compositions: [comp],
});

describe('revisoes contratuais de aditivo', () => {
  it('preserva o contrato-base e acumula deltas sem apagar o original', () => {
    const project: Project = {
      id: 'project-1',
      name: 'Obra',
      startDate: '2026-07-30',
      endDate: '2027-07-30',
      totalBudget: 160_693.7,
      phases: [{
        id: 'sub-1-1',
        name: 'Administracao de Obra',
        color: '#000',
        tasks: [{
          id: 'task-1',
          name: 'Administracao de Obra',
          phase: 'sub-1-1',
          startDate: '2026-07-30',
          duration: 1,
          dependencies: [],
          responsible: '',
          percentComplete: 0,
          materials: [],
          level: 0,
          quantity: 10,
          unit: 'MES',
          unitPrice: 16_069.37,
          unitPriceNoBDI: 12_595.53,
          itemCode: 'ADM04',
        }],
      }],
      budgetItems: [{
        id: 'budget-1',
        item: '1.1.1',
        code: 'ADM04',
        bank: 'PROPRIO',
        description: 'Administracao de Obra',
        unit: 'MES',
        quantity: 10,
        unitPriceNoBDI: 12_595.53,
        unitPriceWithBDI: 16_069.37,
        totalNoBDI: 125_955.3,
        totalWithBDI: 160_693.7,
        source: 'sintetica',
        taskId: 'task-1',
        baseContract: {
          quantity: 10,
          unitPriceNoBDI: 12_595.53,
          unitPriceWithBDI: 16_069.37,
          totalNoBDI: 125_955.3,
          totalWithBDI: 160_693.7,
        },
      }],
      additives: [
        additive('aditivo-1', '2026-08-01', composition('comp-1', 'task-1', 10, 2, 0)),
      ],
    };

    const firstRevision = contractAdditive(project, 'aditivo-1', 'Administrador');
    expect(firstRevision.budgetItems?.[0]).toMatchObject({
      quantity: 12,
      baseContract: { quantity: 10, totalWithBDI: 160_693.7 },
    });
    expect(firstRevision.contractRevisions).toHaveLength(1);
    expect(firstRevision.contractRevisions?.[0]).toMatchObject({
      number: 1,
      status: 'contracted',
      effectiveDate: '2026-08-01',
      changes: [{ budgetItemId: 'budget-1', quantityDelta: 2, revisedQuantity: 12 }],
    });

    const withSecondAdditive: Project = {
      ...firstRevision,
      additives: [
        ...(firstRevision.additives ?? []),
        additive('aditivo-2', '2026-09-01', composition('comp-2', 'task-1', 12, 0, 3)),
      ],
    };
    const secondRevision = contractAdditive(withSecondAdditive, 'aditivo-2', 'Administrador');
    expect(secondRevision.budgetItems?.[0]).toMatchObject({
      quantity: 9,
      baseContract: { quantity: 10, totalWithBDI: 160_693.7 },
    });
    expect(secondRevision.contractRevisions).toHaveLength(2);
    expect(secondRevision.phases[0].tasks[0].additiveHistory).toHaveLength(2);

    const revisedPriceComposition = composition('comp-3', 'task-1', 9, 0, 0);
    revisedPriceComposition.changeKind = 'sem_alteracao';
    revisedPriceComposition.unitPriceNoBDI = 13_325;
    revisedPriceComposition.unitPriceWithBDI = 17_000;
    const withPriceRevision: Project = {
      ...secondRevision,
      additives: [
        ...(secondRevision.additives ?? []),
        additive('aditivo-3', '2026-10-01', revisedPriceComposition),
      ],
    };
    const thirdRevision = contractAdditive(withPriceRevision, 'aditivo-3', 'Administrador');
    expect(thirdRevision.budgetItems?.[0]).toMatchObject({
      quantity: 9,
      unitPriceWithBDI: 17_000,
      totalWithBDI: 153_000,
      baseContract: { quantity: 10, unitPriceWithBDI: 16_069.37 },
    });
    expect(thirdRevision.contractRevisions?.[2].changes[0]).toMatchObject({
      type: 'price_change',
      previousUnitPriceWithBDI: 16_069.37,
      revisedUnitPriceWithBDI: 17_000,
    });
  });

  it('bloqueia contratacao sem data de vigencia', () => {
    const project: Project = {
      id: 'project-2',
      name: 'Obra',
      startDate: '2026-07-30',
      endDate: '2027-07-30',
      totalBudget: 0,
      phases: [],
      additives: [{
        ...additive('aditivo-sem-data', '2026-08-01', composition('comp', 'task', 0, 1, 0)),
        effectiveDate: undefined,
      }],
    };
    expect(() => contractAdditive(project, 'aditivo-sem-data')).toThrow(/data de vigencia/i);
  });
});
