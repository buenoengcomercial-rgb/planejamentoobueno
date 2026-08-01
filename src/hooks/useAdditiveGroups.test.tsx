import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createNewServiceComposition } from '@/lib/additiveImport';
import type { Additive, AdditiveComposition, Project } from '@/types/project';
import { useAdditiveGroups } from './useAdditiveGroups';

const project = {
  phases: [
    { id: 'chapter-2', name: 'INCÊNDIO', color: '#123456', tasks: [], order: 0 },
    { id: 'chapter-2-1', name: 'HIDRANTES', color: '#123456', tasks: [], parentId: 'chapter-2', order: 0 },
    { id: 'chapter-2-2', name: 'NOVO SISTEMA', color: '#123456', tasks: [], parentId: 'chapter-2', order: 1 },
  ],
} as unknown as Project;

const composition = {
  id: 'comp-1',
  item: '1.1.1',
  itemNumber: '1.1.1',
  phaseId: 'chapter-2-1',
  code: 'C001',
  bank: 'PRÓPRIO',
  description: 'Serviço existente',
  quantity: 1,
  originalQuantity: 1,
  addedQuantity: 0,
  suppressedQuantity: 0,
  unit: 'un',
  unitPriceNoBDI: 1,
  unitPriceWithBDI: 1,
  total: 1,
  inputs: [],
} as AdditiveComposition;

const additive = {
  id: 'add-1',
  name: 'Aditivo 1',
  importedAt: '2026-01-01T00:00:00.000Z',
  compositions: [composition],
  visiblePhaseIds: ['chapter-2-2'],
} as Additive;

describe('useAdditiveGroups', () => {
  it('mantém o subcapítulo vazio explicitamente criado visível na árvore', () => {
    const { result } = renderHook(() => useAdditiveGroups(project, additive, '', 'all'));

    expect(result.current.groupTree).toHaveLength(1);
    expect(result.current.groupTree[0].children.map(group => group.number)).toEqual(['1.1', '1.2']);
    expect(result.current.groupTree[0].children[1]).toMatchObject({
      phaseId: 'chapter-2-2',
      name: 'NOVO SISTEMA',
      rows: [],
    });
  });

  it('continua exibindo o subcapítulo vazio quando o filtro não retorna composições', () => {
    const { result } = renderHook(() => useAdditiveGroups(project, additive, 'inexistente', 'all'));

    expect(result.current.filteredComps).toHaveLength(0);
    expect(result.current.groupTree[0].children).toHaveLength(1);
    expect(result.current.groupTree[0].children[0].number).toBe('1.2');
  });

  it('numera o primeiro serviço do novo subcapítulo a partir de .1', () => {
    const newService = createNewServiceComposition(
      { ...additive, compositions: [] },
      'chapter-2-2',
      '2.9 NOVO SISTEMA',
      '2.9',
    );

    expect(newService.itemNumber).toBe('2.9.1');
  });
});
