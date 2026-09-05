import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { warehouseBudgetMaterialsByChapter } from './warehouseBudgetMaterials';

const input = (id: string, coefficient: number) => ({ id, code: '123', bank: 'SINAPI', description: 'Tubo de aço', unit: 'm', coefficient, unitPrice: 10, total: 10, type: 'material' as const });
const composition = (id: string, quantity: number, phaseId = 'sub-2') => ({ id, item: '2.1.1', code: '999', bank: 'SINAPI', description: 'Rede', quantity, unit: 'm', unitPriceNoBDI: 1, unitPriceWithBDI: 1, total: 1, inputs: [input(`input-${id}`, 2)], phaseId });

describe('warehouseBudgetMaterialsByChapter', () => {
  it('consolida subcapítulos no capítulo principal e não inclui acréscimo ainda não contratado', () => {
    const project = {
      phases: [{ id: 'chapter-2', name: 'Hidrantes', color: '#000', tasks: [] }, { id: 'sub-2', name: 'Tubulação', color: '#000', tasks: [], parentId: 'chapter-2' }],
      analyticCompositions: [composition('base', 10)],
      additives: [{ id: 'a1', name: 'Aditivo 1', importedAt: '', status: 'em_analise', compositions: [{ ...composition('add', 3), addedQuantity: 3, originalQuantity: 0, isNewService: true }] }],
    } as unknown as Project;

    const [chapter] = warehouseBudgetMaterialsByChapter(project);
    expect(chapter).toMatchObject({ id: 'chapter-2', name: 'Hidrantes' });
    expect(chapter.rows).toHaveLength(1);
    expect(chapter.rows[0]).toMatchObject({ contractedQuantity: 20, withdrawnQuantity: 0 });
  });

  it('reduz o contratado por supressão ativa e oculta o material 100% suprimido, mesmo se houve retirada', () => {
    const project = {
      phases: [{ id: 'chapter-2', name: 'Hidrantes', color: '#000', tasks: [] }],
      analyticCompositions: [composition('base', 5, 'chapter-2')],
      additives: [
        { id: 'a1', name: 'Supressão', importedAt: '', status: 'rascunho', compositions: [{ ...composition('remove', 5, 'chapter-2'), changeKind: 'suprimido' }] },
        { id: 'a2', name: 'Cancelado', importedAt: '', status: 'cancelado', compositions: [{ ...composition('cancelled', 4, 'chapter-2'), changeKind: 'acrescido' }] },
      ],
      warehouse: {
        materialLinks: [{ id: 'link-1', warehouseItemKey: 'fisico-tubo', projectMaterialCode: '123', projectMaterialDescription: 'Tubo de aço', projectMaterialUnit: 'm', conversionFactor: 1 }],
        requisitions: [{ id: 'req-1', number: 'REQ-1', date: '2026-09-05', status: 'entregue', chapterId: 'chapter-2', items: [], createdAt: '2026-09-05T10:00:00.000Z' }],
        movements: [{ id: 'mov-1', type: 'retirada', date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 7 }],
      },
    } as unknown as Project;

    expect(warehouseBudgetMaterialsByChapter(project)).toEqual([]);
  });

  it('inclui acréscimo no contratado somente após a contratação formal do aditivo', () => {
    const project = {
      phases: [{ id: 'phase-2', customNumber: '2', name: 'Incêndio', color: '#000', tasks: [] }],
      budgetItems: [{ id: 'budget-1', item: '2.1.1', code: '999', chapterCode: '2', chapterName: 'Incêndio', unit: 'm', quantity: 10 }],
      analyticCompositions: [{ ...composition('base', 10, undefined), baseBudgetItemId: 'budget-1' }],
      additives: [{ id: 'a1', name: 'Aditivo 1', importedAt: '', status: 'contratado', compositions: [{ ...composition('add', 3, 'phase-2'), addedQuantity: 3, originalQuantity: 0, isNewService: true }] }],
    } as unknown as Project;

    const [chapter] = warehouseBudgetMaterialsByChapter(project);
    expect(chapter).toMatchObject({ id: 'chapter:2', number: '2', name: 'Incêndio' });
    expect(chapter.rows[0]).toMatchObject({ contractedQuantity: 26, withdrawnQuantity: 0 });
  });

  it('soma retiradas pela requisição entregue vinculada ao capítulo', () => {
    const project = {
      phases: [{ id: 'chapter-2', customNumber: '2', name: 'Incêndio', color: '#000', tasks: [] }],
      analyticCompositions: [composition('base', 10, 'chapter-2')],
      warehouse: {
        materialLinks: [{ id: 'link-1', warehouseItemKey: 'fisico-tubo', projectMaterialCode: '123', projectMaterialDescription: 'Tubo de aço', projectMaterialUnit: 'm', conversionFactor: 1 }],
        requisitions: [{ id: 'req-1', number: 'REQ-1', date: '2026-09-05', status: 'entregue', chapterId: 'chapter-2', items: [], createdAt: '2026-09-05T10:00:00.000Z' }],
        movements: [{ id: 'mov-1', type: 'retirada', date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 7 }],
      },
    } as unknown as Project;

    const [chapter] = warehouseBudgetMaterialsByChapter(project);
    expect(chapter.rows[0]).toMatchObject({ contractedQuantity: 20, withdrawnQuantity: 7 });
  });

  it('desconta devolução parcial vinculada à mesma requisição e material', () => {
    const project = {
      phases: [{ id: 'chapter-2', customNumber: '2', name: 'Incêndio', color: '#000', tasks: [] }],
      analyticCompositions: [composition('base', 10, 'chapter-2')],
      warehouse: {
        materialLinks: [{ id: 'link-1', warehouseItemKey: 'fisico-tubo', projectMaterialCode: '123', projectMaterialDescription: 'Tubo de aço', projectMaterialUnit: 'm', conversionFactor: 1 }],
        requisitions: [{ id: 'req-1', number: 'REQ-1', date: '2026-09-05', status: 'entregue', chapterId: 'chapter-2', items: [], createdAt: '2026-09-05T10:00:00.000Z' }],
        movements: [
          { id: 'mov-1', type: 'retirada', date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 7 },
          { id: 'dev-1', type: 'devolucao', originType: 'return', date: '2026-09-05', createdAt: '2026-09-05T12:00:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 2 },
        ],
      },
    } as unknown as Project;

    const [chapter] = warehouseBudgetMaterialsByChapter(project);
    expect(chapter.rows[0]).toMatchObject({ contractedQuantity: 20, withdrawnQuantity: 5 });
  });

  it('limita o retirado líquido a zero quando a devolução vinculada é integral', () => {
    const project = {
      phases: [{ id: 'chapter-2', customNumber: '2', name: 'Incêndio', color: '#000', tasks: [] }],
      analyticCompositions: [composition('base', 10, 'chapter-2')],
      warehouse: {
        materialLinks: [{ id: 'link-1', warehouseItemKey: 'fisico-tubo', projectMaterialCode: '123', projectMaterialDescription: 'Tubo de aço', projectMaterialUnit: 'm', conversionFactor: 1 }],
        requisitions: [{ id: 'req-1', number: 'REQ-1', date: '2026-09-05', status: 'entregue', chapterId: 'chapter-2', items: [], createdAt: '2026-09-05T10:00:00.000Z' }],
        movements: [
          { id: 'mov-1', type: 'retirada', date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 7 },
          { id: 'dev-1', type: 'devolucao', originType: 'return', date: '2026-09-05', createdAt: '2026-09-05T12:00:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 7 },
        ],
      },
    } as unknown as Project;

    const [chapter] = warehouseBudgetMaterialsByChapter(project);
    expect(chapter.rows[0]).toMatchObject({ withdrawnQuantity: 0 });
  });

  it('não desconta devolução registrada em outra requisição ou capítulo', () => {
    const project = {
      phases: [
        { id: 'chapter-2', customNumber: '2', name: 'Incêndio', color: '#000', tasks: [] },
        { id: 'chapter-3', customNumber: '3', name: 'Elétrica', color: '#000', tasks: [] },
      ],
      analyticCompositions: [composition('base', 10, 'chapter-2')],
      warehouse: {
        materialLinks: [{ id: 'link-1', warehouseItemKey: 'fisico-tubo', projectMaterialCode: '123', projectMaterialDescription: 'Tubo de aço', projectMaterialUnit: 'm', conversionFactor: 1 }],
        requisitions: [
          { id: 'req-1', number: 'REQ-1', date: '2026-09-05', status: 'entregue', chapterId: 'chapter-2', items: [], createdAt: '2026-09-05T10:00:00.000Z' },
          { id: 'req-2', number: 'REQ-2', date: '2026-09-05', status: 'entregue', chapterId: 'chapter-3', items: [], createdAt: '2026-09-05T10:00:00.000Z' },
        ],
        movements: [
          { id: 'mov-1', type: 'retirada', date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 7 },
          { id: 'dev-1', type: 'devolucao', originType: 'return', date: '2026-09-05', createdAt: '2026-09-05T12:00:00.000Z', requisitionId: 'req-2', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 7 },
        ],
      },
    } as unknown as Project;

    const [chapter] = warehouseBudgetMaterialsByChapter(project);
    expect(chapter.rows[0]).toMatchObject({ withdrawnQuantity: 7 });
  });

  it('só contabiliza a sirene retirada após o vínculo do material físico ao insumo analítico', () => {
    const project = {
      phases: [{ id: 'chapter-3', customNumber: '3', name: 'INCÊNDIO - CURVO 02', color: '#000', tasks: [] }],
      analyticCompositions: [{
        ...composition('sirene', 9, 'chapter-3'),
        inputs: [{ id: 'input-sirene', code: 'ORSE-123', bank: 'ORSE', description: 'Sirene audiovisual endereçável sobrepor SAVQ-E', unit: 'UN', coefficient: 1, unitPrice: 10, total: 10, type: 'material' as const }],
      }],
      warehouse: {
        materialLinks: [],
        requisitions: [{ id: 'req-1', number: 'REQ-2026-0055', date: '2026-09-04', status: 'entregue', chapterId: 'chapter-3', items: [], createdAt: '2026-09-04T08:15:00.000Z' }],
        movements: [{ id: 'mov-sirene', type: 'retirada', date: '2026-09-04', createdAt: '2026-09-04T08:15:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-sirene', itemCode: '0020011', itemDescription: 'SIRENE AUDIOVISUAL ENDERECAVEL SOBREPOR SAVQ-E', itemUnit: 'UN', quantity: 9 }],
      },
    } as unknown as Project;

    expect(warehouseBudgetMaterialsByChapter(project)[0].rows[0]).toMatchObject({ withdrawnQuantity: 0 });

    project.warehouse!.materialLinks = [{
      id: 'link-sirene', warehouseItemKey: 'fisico-sirene', projectMaterialKey: 'input-sirene', projectMaterialCode: 'ORSE-123', projectMaterialDescription: 'Sirene audiovisual endereçável sobrepor SAVQ-E', projectMaterialUnit: 'UN', conversionFactor: 1, source: 'manual', createdAt: '2026-09-04T08:15:00.000Z', updatedAt: '2026-09-04T08:15:00.000Z',
    }];

    expect(warehouseBudgetMaterialsByChapter(project)[0].rows[0]).toMatchObject({ withdrawnQuantity: 9 });
  });

  it('não soma retirada de requisição sem capítulo ou vinculada a outro capítulo', () => {
    const project = {
      phases: [
        { id: 'chapter-2', customNumber: '2', name: 'Incêndio', color: '#000', tasks: [] },
        { id: 'chapter-3', customNumber: '3', name: 'Elétrica', color: '#000', tasks: [] },
      ],
      analyticCompositions: [composition('base', 10, 'chapter-2')],
      warehouse: {
        materialLinks: [{ id: 'link-1', warehouseItemKey: 'fisico-tubo', projectMaterialCode: '123', projectMaterialDescription: 'Tubo de aço', projectMaterialUnit: 'm', conversionFactor: 1 }],
        requisitions: [
          { id: 'req-sem-capitulo', number: 'REQ-1', date: '2026-09-05', status: 'entregue', items: [], createdAt: '2026-09-05T10:00:00.000Z' },
          { id: 'req-outro-capitulo', number: 'REQ-2', date: '2026-09-05', status: 'entregue', chapterId: 'chapter-3', items: [], createdAt: '2026-09-05T10:00:00.000Z' },
        ],
        movements: [
          { id: 'mov-1', type: 'retirada', date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z', requisitionId: 'req-sem-capitulo', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 4 },
          { id: 'mov-2', type: 'retirada', date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z', requisitionId: 'req-outro-capitulo', itemKey: 'fisico-tubo', itemDescription: 'Tubo físico', itemUnit: 'm', quantity: 3 },
        ],
      },
    } as unknown as Project;

    const [chapter] = warehouseBudgetMaterialsByChapter(project);
    expect(chapter.rows[0]).toMatchObject({ contractedQuantity: 20, withdrawnQuantity: 0 });
  });
});
