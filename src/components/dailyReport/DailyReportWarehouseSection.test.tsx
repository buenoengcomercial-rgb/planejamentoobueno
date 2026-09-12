import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { warehouseWithdrawalsForDate } from '@/lib/dailyReportWarehouse';

describe('retiradas do Diário derivadas do Almoxarifado', () => {
  it('exibe somente movimentos confirmados, ativos e da data escolhida', () => {
    const project = {
      id: 'p', name: 'Obra', phases: [], totalBudget: 0,
      warehouse: {
        locations: [], items: [], equipments: [], equipmentGroups: [], custodyTerms: [],
        requisitions: [{
          id: 'req-1', number: 'REQ-2026-0001', date: '2026-09-12', status: 'entregue',
          chapterName: 'Prédio 1', receiverName: 'CANANDA', requesterName: 'CANANDA',
          items: [{ itemKey: 'placa', description: 'Placa', unit: 'UN', quantity: 4 }],
          createdAt: '2026-09-12T10:00:00.000Z',
        }],
        movements: [
          { id: 'm1', type: 'retirada', date: '2026-09-12', itemKey: 'placa', itemDescription: 'Placa', itemUnit: 'UN', quantity: 4, requisitionId: 'req-1', createdAt: '2026-09-12T10:00:00.000Z' },
          { id: 'm2', type: 'retirada', date: '2026-09-12', itemKey: 'placa', itemDescription: 'Placa antiga', itemUnit: 'UN', quantity: 1, requisitionId: 'req-1', reversedById: 'e1', createdAt: '2026-09-12T09:00:00.000Z' },
          { id: 'm3', type: 'retirada', date: '2026-09-11', itemKey: 'placa', itemDescription: 'Outro dia', itemUnit: 'UN', quantity: 2, requisitionId: 'req-1', createdAt: '2026-09-11T10:00:00.000Z' },
        ],
      },
    } as Project;

    expect(warehouseWithdrawalsForDate(project, '2026-09-12')).toEqual([
      expect.objectContaining({ requisitionNumber: 'REQ-2026-0001', receiverName: 'CANANDA', description: 'Placa', quantity: 4 }),
    ]);
  });
});
