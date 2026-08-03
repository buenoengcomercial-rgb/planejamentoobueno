import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Additive, AdditiveComposition, Project } from '@/types/project';
import type { AdditiveStateApi } from './useAdditiveState';
import { useAdditiveActions } from './useAdditiveActions';
import { upsertAdditiveCompositionTemplate } from '@/lib/additiveCompositionCatalog';

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));

const source: AdditiveComposition = {
  id: 'source', item: '5.10.3', itemNumber: '5.10.3', code: 'FIXA_1', bank: 'PRÓPRIO',
  description: 'FIXAÇÃO DE TUBO VERTICAL', quantity: 0, originalQuantity: 0, unit: 'un',
  unitPriceNoBDI: 12.81, unitPriceNoBDIInformed: 12.81, unitPriceWithBDI: 16.34, total: 0,
  inputs: [{ id: 'old-input', code: '88248', bank: 'SINAPI', description: 'Auxiliar', unit: 'H', coefficient: 0.056, unitPrice: 25.91, total: 1.45 }],
  phaseId: 'phase-5-10', phaseChain: '5.10 SERVIÇOS - ITENS NOVOS', isNewService: true,
};

const target: AdditiveComposition = {
  id: 'target', item: '6.9.3', itemNumber: '6.9.3', code: '', bank: '',
  description: 'Novo serviço', quantity: 0, originalQuantity: 0, unit: 'un',
  unitPriceNoBDI: 0, unitPriceNoBDIInformed: 0, unitPriceWithBDI: 0, total: 0, inputs: [],
  addedQuantity: 7, calculationMemory: [{ id: 'memory', type: 'acrescida', partial: 7 }],
  phaseId: 'phase-6-9', phaseChain: '6.9 SERVIÇOS - ITENS NOVOS', isNewService: true,
};

function additiveWith(compositions: AdditiveComposition[]): Additive {
  return {
    id: 'additive-1', name: 'Aditivo', status: 'rascunho', compositions,
    importedAt: '2026-08-03T00:00:00.000Z', bdiPercent: 27.58,
  } as Additive;
}

describe('useAdditiveActions catálogo atual da obra', () => {
  it('restaura pelo estado atual mesmo quando a propriedade renderizada está atrasada', () => {
    const additive = additiveWith([target]);
    const staleProject = {
      id: 'project-1', phases: [], additives: [additive], additiveCompositionCatalog: [],
    } as unknown as Project;
    let currentProject: Project = {
      ...staleProject,
      additiveCompositionCatalog: upsertAdditiveCompositionTemplate([], source, additive.id),
    };
    const onProjectChange = vi.fn((next: Project | ((prev: Project) => Project)) => {
      currentProject = typeof next === 'function' ? next(currentProject) : next;
    });
    const state = {
      active: additive,
      activeId: additive.id,
      isLocked: false,
    } as unknown as AdditiveStateApi;

    const { result } = renderHook(() => useAdditiveActions({
      project: staleProject,
      onProjectChange,
      state,
    }));

    act(() => result.current.updateComposition(target.id, { code: 'FIXA1' }));

    const restored = currentProject.additives?.[0].compositions.find(candidate => candidate.id === target.id);
    expect(restored).toMatchObject({
      code: 'FIXA1', bank: 'PRÓPRIO', description: 'FIXAÇÃO DE TUBO VERTICAL',
      unitPriceNoBDIInformed: 12.81, addedQuantity: 7,
      calculationMemory: [{ id: 'memory', type: 'acrescida', partial: 7 }],
      phaseId: 'phase-6-9', itemNumber: '6.9.3',
    });
    expect(restored?.inputs).toHaveLength(1);
    expect(restored?.inputs[0].id).not.toBe('old-input');
    expect(currentProject.additiveCompositionCatalog).toHaveLength(1);
  });

  it('repara automaticamente uma linha existente que ficou somente com o código', () => {
    const incomplete = { ...target, code: 'PINT02' };
    const additive = additiveWith([incomplete]);
    const templateSource = { ...source, code: 'PINT_02', description: 'PINTURA DE IDENTIFICAÇÃO' };
    const staleProject = {
      id: 'project-1', phases: [], additives: [additive], additiveCompositionCatalog: [],
    } as unknown as Project;
    let currentProject: Project = {
      ...staleProject,
      additiveCompositionCatalog: upsertAdditiveCompositionTemplate([], templateSource, additive.id),
    };
    const onProjectChange = vi.fn((next: Project | ((prev: Project) => Project)) => {
      currentProject = typeof next === 'function' ? next(currentProject) : next;
    });
    const state = { active: additive, activeId: additive.id, isLocked: false } as unknown as AdditiveStateApi;

    renderHook(() => useAdditiveActions({ project: staleProject, onProjectChange, state }));

    const restored = currentProject.additives?.[0].compositions[0];
    expect(restored).toMatchObject({
      code: 'PINT02', bank: 'PRÓPRIO', description: 'PINTURA DE IDENTIFICAÇÃO',
      itemNumber: '6.9.3', phaseId: 'phase-6-9', addedQuantity: 7,
    });
    expect(restored?.inputs).toHaveLength(1);
    expect(currentProject.auditLogs?.at(-1)?.title).toBe('Composições incompletas restauradas pelo catálogo da obra');
  });

  it('consolida versões legadas e repara o FIXA_1 vazio pela completa mais recente', () => {
    const incomplete = { ...target, code: 'FIXA_1', item: '6.9.25', itemNumber: '6.9.25' };
    const additive = additiveWith([incomplete]);
    const older = upsertAdditiveCompositionTemplate(
      [], { ...source, bank: 'ORSE', description: 'VERSÃO ANTIGA' }, additive.id, '2026-08-01T00:00:00.000Z',
    )[0];
    const latest = upsertAdditiveCompositionTemplate(
      [], source, additive.id, '2026-08-03T00:00:00.000Z',
    )[0];
    const staleProject = {
      id: 'project-1', phases: [], additives: [additive], additiveCompositionCatalog: [],
    } as unknown as Project;
    let currentProject: Project = {
      ...staleProject,
      additiveCompositionCatalog: [older, latest],
    };
    const onProjectChange = vi.fn((next: Project | ((prev: Project) => Project)) => {
      currentProject = typeof next === 'function' ? next(currentProject) : next;
    });
    const state = { active: additive, activeId: additive.id, isLocked: false } as unknown as AdditiveStateApi;

    renderHook(() => useAdditiveActions({ project: staleProject, onProjectChange, state }));

    const restored = currentProject.additives?.[0].compositions[0];
    expect(restored).toMatchObject({
      code: 'FIXA_1', bank: 'PRÓPRIO', description: 'FIXAÇÃO DE TUBO VERTICAL',
      itemNumber: '6.9.25', phaseId: 'phase-6-9', addedQuantity: 7,
      calculationMemory: [{ id: 'memory', type: 'acrescida', partial: 7 }],
    });
    expect(currentProject.additiveCompositionCatalog).toHaveLength(1);
    expect(currentProject.additiveCompositionCatalog?.[0].id).toBe('additive-template:FIXA1');
    expect(currentProject.auditLogs?.map(log => log.title)).toEqual(expect.arrayContaining([
      'Catálogo de composições consolidado por código',
      'Composições incompletas restauradas pelo catálogo da obra',
    ]));
  });
});
