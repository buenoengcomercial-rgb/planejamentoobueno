import { describe, expect, it } from 'vitest';
import type { AdditiveComposition, Project } from '@/types/project';
import {
  ANALYTIC_LINK_SCHEMA_VERSION,
  normalizeAnalyticCode,
  repairProjectAnalyticLinks,
  resolveAnalyticComposition,
} from '@/lib/analyticLinks';
import { buildAdditiveFromSyntheticBudgetItems } from '@/lib/additiveImport';
import { syncAdditiveProductivity } from '@/lib/additiveProductivity';
import { buildRealCostAnalysis } from '@/lib/realCost';

const input = {
  id: 'input-labor',
  code: '88309',
  bank: 'SINAPI',
  description: 'Pedreiro com encargos complementares',
  unit: 'H',
  coefficient: 0.0681,
  unitPrice: 28.9,
  total: 1.96,
};

function baseComposition(): AdditiveComposition {
  return {
    id: 'analytic-adm04',
    item: '1.1.1',
    code: 'ADM04',
    bank: 'PROPRIO',
    description: 'Administracao de obra',
    quantity: 6,
    unit: 'MES',
    unitPriceNoBDI: 12595.53,
    unitPriceWithBDI: 16069.37,
    total: 96416.22,
    inputs: [input],
    taskId: 'task-adm04',
  };
}

function projectFixture(additiveComposition?: AdditiveComposition): Project {
  return {
    id: 'project-1',
    name: 'CPA OBRA',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    totalBudget: 5815613.52,
    phases: [{
      id: 'phase-1',
      name: 'SERVICOS PRELIMINARES',
      color: '#000000',
      tasks: [{
        id: 'task-adm04',
        name: 'Administracao de obra',
        itemCode: 'ADM04',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        duration: 1,
        progress: 0,
        dependencies: [],
        status: 'not-started',
        quantity: 6,
        unit: 'MES',
      }],
    }],
    budgetItems: [{
      id: 'budget-adm04',
      item: '1.1.1',
      code: 'ADM04',
      bank: 'PROPRIO',
      description: 'Administracao de obra',
      unit: 'MES',
      quantity: 6,
      unitPriceNoBDI: 12595.53,
      unitPriceWithBDI: 16069.37,
      totalNoBDI: 75573.18,
      totalWithBDI: 96416.22,
      source: 'sintetica',
      taskId: 'task-adm04',
    }],
    analyticCompositions: [baseComposition()],
    additives: additiveComposition ? [{
      id: 'additive-1',
      name: 'Primeiro aditivo',
      importedAt: '2026-01-01',
      compositions: [additiveComposition],
      issues: [],
      status: 'rascunho',
    }] : [],
  } as Project;
}

function emptyAdditive(): AdditiveComposition {
  return {
    ...baseComposition(),
    id: 'additive-adm04',
    inputs: [],
    total: 96416.22,
  };
}

describe('central analytic links', () => {
  it('normalizes equivalent codes used only during initial recovery', () => {
    expect(normalizeAnalyticCode('ADM04')).toBe('ADM4');
    expect(normalizeAnalyticCode('C0002')).toBe('C2');
  });

  it('does not let an empty additive composition hide the base analytic', () => {
    const additive = emptyAdditive();
    const project = projectFixture(additive);
    const resolved = resolveAnalyticComposition(project, additive);
    expect(resolved.composition?.id).toBe('analytic-adm04');
    expect(resolved.composition?.inputs).toHaveLength(1);
    expect(resolved.inherited).toBe(true);

    const production = syncAdditiveProductivity(project);
    expect(production.project.phases[0].tasks[0].laborCompositions).toHaveLength(1);
    const costRow = buildRealCostAnalysis(project).compositions.find(row => row.code === 'ADM04');
    expect(costRow?.hasAnalytic).toBe(true);
    expect(costRow?.inputs).toHaveLength(1);
    expect(costRow?.laborCost).toBeGreaterThan(0);
  });

  it('prefers an additive own analytic only inside that additive', () => {
    const additive = { ...emptyAdditive(), inputs: [{ ...input, id: 'override', coefficient: 2 }] };
    const project = projectFixture(additive);
    const resolved = resolveAnalyticComposition(project, additive);
    expect(resolved.source).toBe('own');
    expect(resolved.composition?.inputs[0].coefficient).toBe(2);
    expect(project.analyticCompositions?.[0].inputs[0].coefficient).toBe(0.0681);
  });

  it('requires a proper analytic for a genuinely new additive service', () => {
    const additive = { ...emptyAdditive(), item: '1.1.99', code: 'NOVO1', taskId: undefined, isNewService: true };
    expect(resolveAnalyticComposition(projectFixture(additive), additive).source).toBe('none');
  });

  it('repairs identifiers once without changing contract values', () => {
    const original = projectFixture(emptyAdditive());
    const financialBefore = JSON.stringify({
      totalBudget: original.totalBudget,
      budgetItems: original.budgetItems,
      composition: original.additives?.[0].compositions[0],
    });
    const repaired = repairProjectAnalyticLinks(original);
    const composition = repaired.project.additives?.[0].compositions[0];
    expect(repaired.changed).toBe(true);
    expect(repaired.project.analyticLinkSchemaVersion).toBe(ANALYTIC_LINK_SCHEMA_VERSION);
    expect(composition?.baseBudgetItemId).toBe('budget-adm04');
    expect(composition?.baseAnalyticCompositionId).toBe('analytic-adm04');
    expect(composition?.baseTaskId).toBe('task-adm04');
    expect(composition?.total).toBe(96416.22);
    expect(repairProjectAnalyticLinks(repaired.project).changed).toBe(false);
    expect(financialBefore).toContain('5815613.52');
  });

  it('creates a synthetic additive with persistent base identifiers and no copied inputs', () => {
    const project = projectFixture();
    const additive = buildAdditiveFromSyntheticBudgetItems(project);
    expect(additive?.compositions).toHaveLength(1);
    expect(additive?.compositions[0].inputs).toEqual([]);
    expect(additive?.compositions[0].baseBudgetItemId).toBe('budget-adm04');
    expect(additive?.compositions[0].baseAnalyticCompositionId).toBe('analytic-adm04');
    expect(additive?.compositions[0].totalWithBDI).toBe(96416.22);
  });
});
