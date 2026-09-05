import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import WarehouseWithdrawnMaterialsTab from './WarehouseWithdrawnMaterialsTab';

const project = {
  phases: [{ id: 'chapter-3', customNumber: '3', name: 'INCÊNDIO - CURVO 02', color: '#000', tasks: [] }],
  materialSuppliers: [{ id: 'supplier-a', name: 'Fornecedor A' }, { id: 'supplier-b', name: 'Fornecedor B' }],
  warehouse: {
    items: [
      { key: 'sirene', description: 'Sirene', unit: 'UN', supplierId: 'supplier-a' },
      { key: 'luminaria', description: 'Luminária', unit: 'UN', supplierId: 'supplier-b' },
    ],
    requisitions: [{ id: 'req-1', number: 'REQ-1', date: '2026-09-04', status: 'entregue', chapterId: 'chapter-3', items: [], createdAt: '2026-09-04T08:15:00.000Z' }],
    movements: [
      { id: 'sirene-ret', type: 'retirada', date: '2026-09-04', createdAt: '2026-09-04T08:15:00.000Z', requisitionId: 'req-1', itemKey: 'sirene', itemCode: '001', itemDescription: 'Sirene audiovisual', itemUnit: 'UN', quantity: 9 },
      { id: 'lum-ret', type: 'retirada', date: '2026-09-04', createdAt: '2026-09-04T08:15:00.000Z', requisitionId: 'req-1', itemKey: 'luminaria', itemCode: '002', itemDescription: 'Luminária de emergência', itemUnit: 'UN', quantity: 3 },
    ],
    locations: [], equipments: [], equipmentGroups: [], custodyTerms: [],
  },
} as unknown as Project;

describe('WarehouseWithdrawnMaterialsTab', () => {
  it('filtra os materiais retirados por fornecedor e busca', () => {
    render(<WarehouseWithdrawnMaterialsTab project={project} />);

    expect(screen.getByRole('button', { name: 'Retirado líquido (hierarquia)' })).toBeInTheDocument();
    expect(screen.getByText(/maior quantidade líquida retirada primeiro/i)).toBeInTheDocument();
    expect(screen.getAllByText('Sirene audiovisual')).not.toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Fornecedor'), { target: { value: 'Fornecedor B' } });
    expect(screen.queryAllByText('Sirene audiovisual')).toHaveLength(0);
    expect(screen.getAllByText('Luminária de emergência')).not.toHaveLength(0);

    fireEvent.change(screen.getByPlaceholderText('Código ou descrição'), { target: { value: 'sirene' } });
    expect(screen.queryAllByText('Luminária de emergência')).toHaveLength(0);
    expect(screen.getByText(/Nenhum material encontrado/i)).toBeInTheDocument();
  });
});
