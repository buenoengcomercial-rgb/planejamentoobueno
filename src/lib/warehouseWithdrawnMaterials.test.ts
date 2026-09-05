import { describe, expect, it } from 'vitest';
import type { Project, WarehouseMovement } from '@/types/project';
import { warehouseWithdrawnMaterialsByChapter } from './warehouseWithdrawnMaterials';

const withdrawal = (id: string, requisitionId: string, quantity: number): WarehouseMovement => ({
  id, type: 'retirada', date: '2026-09-04', createdAt: '2026-09-04T08:15:00.000Z', requisitionId,
  itemKey: 'fisico-sirene', itemCode: '0020011', itemDescription: 'SIRENE AUDIOVISUAL ENDERECAVEL SOBREPOR SAVQ-E', itemUnit: 'UN', quantity,
});

const returned = (id: string, requisitionId: string, quantity: number): WarehouseMovement => ({
  id, type: 'devolucao', originType: 'return', date: '2026-09-04', createdAt: '2026-09-04T12:00:00.000Z', requisitionId,
  itemKey: 'fisico-sirene', itemCode: '0020011', itemDescription: 'SIRENE AUDIOVISUAL ENDERECAVEL SOBREPOR SAVQ-E', itemUnit: 'UN', quantity,
});

function project(movements: WarehouseMovement[]): Project {
  return {
    phases: [
      { id: 'chapter-3', customNumber: '3', name: 'INCÊNDIO - CURVO 02', color: '#000', tasks: [] },
      { id: 'chapter-4', customNumber: '4', name: 'INCÊNDIO - RETO 01', color: '#000', tasks: [] },
    ],
    materialSuppliers: [{ id: 'supplier-config', name: 'Fornecedor configurado' }],
    warehouse: {
      items: [{ key: 'fisico-sirene', code: '0020011', description: 'SIRENE AUDIOVISUAL ENDERECAVEL SOBREPOR SAVQ-E', unit: 'UN', supplierId: 'supplier-config' }],
      requisitions: [
        { id: 'req-curvo', number: 'REQ-1', date: '2026-09-04', status: 'entregue', chapterId: 'chapter-3', items: [], createdAt: '2026-09-04T08:15:00.000Z' },
        { id: 'req-reto', number: 'REQ-2', date: '2026-09-04', status: 'entregue', chapterId: 'chapter-4', items: [], createdAt: '2026-09-04T08:15:00.000Z' },
      ],
      fiscalNotes: [{ id: 'nf-1', createdAt: '2026-09-03T08:00:00.000Z', updatedAt: '2026-09-03T08:00:00.000Z', supplierName: 'Fornecedor da última entrada', status: 'aprovada', origin: 'upload', sourceFileName: 'nf.pdf', totalAmount: 0, items: [] }],
      movements: [{ id: 'entry-1', type: 'entrada', originType: 'fiscal_note', date: '2026-09-03', createdAt: '2026-09-03T08:00:00.000Z', fiscalNoteId: 'nf-1', itemKey: 'fisico-sirene', itemCode: '0020011', itemDescription: 'SIRENE AUDIOVISUAL ENDERECAVEL SOBREPOR SAVQ-E', itemUnit: 'UN', quantity: 20 }, ...movements],
      locations: [], equipments: [], equipmentGroups: [], custodyTerms: [],
    },
  } as unknown as Project;
}

describe('warehouseWithdrawnMaterialsByChapter', () => {
  it('mostra material físico retirado, mesmo sem vínculo ao orçamento, no capítulo e fornecedor da última entrada', () => {
    const [chapter] = warehouseWithdrawnMaterialsByChapter(project([withdrawal('ret-1', 'req-curvo', 9)]));

    expect(chapter).toMatchObject({ id: 'chapter:3', number: '3', name: 'INCÊNDIO - CURVO 02' });
    expect(chapter.rows).toEqual([expect.objectContaining({ code: '0020011', supplierName: 'Fornecedor da última entrada', withdrawnQuantity: 9 })]);
  });

  it('desconta devolução parcial e oculta o material com devolução integral', () => {
    const partial = warehouseWithdrawnMaterialsByChapter(project([withdrawal('ret-1', 'req-curvo', 9), returned('dev-1', 'req-curvo', 4)]));
    const integral = warehouseWithdrawnMaterialsByChapter(project([withdrawal('ret-1', 'req-curvo', 9), returned('dev-1', 'req-curvo', 9)]));

    expect(partial[0].rows[0]).toMatchObject({ withdrawnQuantity: 5 });
    expect(integral).toEqual([]);
  });

  it('não deixa devolução de outra requisição reduzir o capítulo atual', () => {
    const [chapter] = warehouseWithdrawnMaterialsByChapter(project([withdrawal('ret-1', 'req-curvo', 9), returned('dev-1', 'req-reto', 9)]));

    expect(chapter.rows[0]).toMatchObject({ withdrawnQuantity: 9 });
  });

  it('ignora requisição sem capítulo ou ainda não entregue', () => {
    const current = project([withdrawal('ret-1', 'req-curvo', 9)]);
    current.warehouse!.requisitions.push(
      { id: 'req-sem-capitulo', number: 'REQ-3', date: '2026-09-04', status: 'entregue', items: [], createdAt: '2026-09-04T08:15:00.000Z' },
      { id: 'req-pendente', number: 'REQ-4', date: '2026-09-04', status: 'rascunho', chapterId: 'chapter-3', items: [], createdAt: '2026-09-04T08:15:00.000Z' },
    );
    current.warehouse!.movements.push(withdrawal('ret-2', 'req-sem-capitulo', 3), withdrawal('ret-3', 'req-pendente', 4));

    const [chapter] = warehouseWithdrawnMaterialsByChapter(current);
    expect(chapter.rows[0]).toMatchObject({ withdrawnQuantity: 9 });
  });
});
