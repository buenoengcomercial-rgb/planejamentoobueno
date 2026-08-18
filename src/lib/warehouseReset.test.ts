import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { prepareWarehouseTestReset } from '@/lib/warehouseReset';

describe('prepareWarehouseTestReset', () => {
  it('remove os históricos e preserva o cadastro completo dos equipamentos', () => {
    const project: Project = {
      id: 'obra-1',
      name: 'Obra real',
      startDate: '2026-08-01',
      endDate: '2026-12-31',
      totalBudget: 0,
      phases: [],
      stockMovements: [{ id: 'legacy-1', itemKey: 'mat-1', type: 'entrada', quantity: 1, date: '2026-08-18' }],
      warehouse: {
        locations: [{ id: 'loc-1', name: 'Teste' }],
        items: [{ key: 'mat-1', description: 'Material teste', unit: 'UN' }],
        movements: [{ id: 'mov-1', type: 'entrada', date: '2026-08-18', createdAt: '2026-08-18', itemKey: 'mat-1', itemDescription: 'Material teste', itemUnit: 'UN', quantity: 1 }],
        requisitions: [{ id: 'req-1', number: 'REQ-1', date: '2026-08-18', status: 'entregue', chapterId: 'cap-1', chapterName: 'Capítulo', teamId: 'alpha', teamName: 'Alpha', receiverName: 'João', requesterName: 'João', signatureReceiver: 'assinatura', createdAt: '2026-08-18', items: [] }],
        custodyTerms: [{ id: 'term-1', number: 'TC-1', equipmentId: 'eq-use', equipmentName: 'Furadeira', issuedAt: '2026-08-18', workerName: 'João', status: 'em_uso', createdAt: '2026-08-18' }],
        fiscalNotes: [{ id: 'nf-1', number: '1', supplierName: 'Fornecedor', issueDate: '2026-08-18', status: 'aprovada', items: [], createdAt: '2026-08-18' }],
        materialLinks: [],
        inventorySessions: [{ id: 'inv-1', number: 'INV-1', month: '2026-08', status: 'em_contagem', startedAt: '2026-08-18', lines: [] }],
        valuationMethod: 'weighted_average',
        equipments: [
          { id: 'eq-use', name: 'Furadeira', internalCode: 'EQ-001', patrimony: 'PAT-1', status: 'em_uso', createdAt: '2026-08-18', photos: [{ id: 'photo-1', name: 'foto.jpg', mimeType: 'image/jpeg', uploadedAt: '2026-08-18', storagePath: 'eq/foto.jpg' }] },
          { id: 'eq-maintenance', name: 'Serra', status: 'em_manutencao', createdAt: '2026-08-18' },
          { id: 'eq-archived', name: 'Nível', status: 'arquivado', archivedAt: '2026-08-18', createdAt: '2026-08-18' },
        ],
      },
    };

    const result = prepareWarehouseTestReset(project, { userId: 'owner-1', userName: 'Proprietário' }, '2026-08-18T17:00:00.000Z');

    expect(result.project.warehouse).toMatchObject({
      locations: [], items: [], movements: [], requisitions: [], custodyTerms: [],
      fiscalNotes: [], materialLinks: [], inventorySessions: [],
    });
    expect(result.project.stockMovements).toEqual([]);
    expect(result.project.warehouse!.equipments).toHaveLength(3);
    expect(result.project.warehouse!.equipments[0]).toMatchObject({
      id: 'eq-use', internalCode: 'EQ-001', patrimony: 'PAT-1', status: 'disponivel',
      photos: [{ storagePath: 'eq/foto.jpg' }],
    });
    expect(result.project.warehouse!.equipments[1].status).toBe('em_manutencao');
    expect(result.project.warehouse!.equipments[2].status).toBe('arquivado');
    expect(result.summary).toMatchObject({ equipmentsPreserved: 3, equipmentsReleased: 1, custodyTerms: 1 });
    expect(result.project.auditLogs?.at(-1)).toMatchObject({ title: 'Dados de teste do almoxarifado removidos' });
  });
});
