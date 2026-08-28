import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { warehouseBudgetMaterialsByChapter } from './warehouseBudgetMaterials';

const input = (id: string, coefficient: number) => ({ id, code: '123', bank: 'SINAPI', description: 'Tubo de aço', unit: 'm', coefficient, unitPrice: 10, total: 10, type: 'material' as const });
const composition = (id: string, quantity: number, phaseId = 'sub-2') => ({ id, item: '2.1.1', code: '999', bank: 'SINAPI', description: 'Rede', quantity, unit: 'm', unitPriceNoBDI: 1, unitPriceWithBDI: 1, total: 1, inputs: [input(`input-${id}`, 2)], phaseId });

describe('warehouseBudgetMaterialsByChapter', () => {
  it('consolida subcapítulos no capítulo principal e mantém contratado e aditivo separados', () => {
    const project = {
      phases: [{ id: 'chapter-2', name: 'Hidrantes', color: '#000', tasks: [] }, { id: 'sub-2', name: 'Tubulação', color: '#000', tasks: [], parentId: 'chapter-2' }],
      analyticCompositions: [composition('base', 10)],
      additives: [{ id: 'a1', name: 'Aditivo 1', importedAt: '', status: 'em_analise', compositions: [{ ...composition('add', 3), addedQuantity: 3, originalQuantity: 0, isNewService: true }] }],
    } as unknown as Project;

    const [chapter] = warehouseBudgetMaterialsByChapter(project);
    expect(chapter).toMatchObject({ id: 'chapter-2', name: 'Hidrantes' });
    expect(chapter.rows).toHaveLength(1);
    expect(chapter.rows[0]).toMatchObject({ contractedQuantity: 20, additiveQuantity: 6, totalQuantity: 26, additiveStatuses: ['Em análise'] });
  });

  it('não mostra material totalmente suprimido nem aditivo cancelado', () => {
    const project = {
      phases: [{ id: 'chapter-2', name: 'Hidrantes', color: '#000', tasks: [] }],
      analyticCompositions: [composition('base', 5, 'chapter-2')],
      additives: [
        { id: 'a1', name: 'Supressão', importedAt: '', status: 'aprovado', compositions: [{ ...composition('remove', 5, 'chapter-2'), changeKind: 'suprimido' }] },
        { id: 'a2', name: 'Cancelado', importedAt: '', status: 'cancelado', compositions: [{ ...composition('cancelled', 4, 'chapter-2'), changeKind: 'acrescido' }] },
      ],
    } as unknown as Project;

    expect(warehouseBudgetMaterialsByChapter(project)).toEqual([]);
  });
});
