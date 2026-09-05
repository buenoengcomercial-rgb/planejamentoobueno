import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import WarehouseBudgetMaterialsTab from './WarehouseBudgetMaterialsTab';

const composition = (id: string, description: string, quantity: number) => ({
  id, item: `2.1.${id}`, code: id, description, quantity, unit: 'un', unitPriceNoBDI: 1, unitPriceWithBDI: 1, total: quantity,
  inputs: [{ id: `input-${id}`, code: id, description, unit: 'un', coefficient: 1, unitPrice: 1, total: 1, type: 'material' as const }], phaseId: 'chapter-2',
});

describe('WarehouseBudgetMaterialsTab', () => {
  it('usa retirado como ordem hierárquica padrão e mantém os cabeçalhos ordenáveis', () => {
    const project = {
      phases: [{ id: 'chapter-2', customNumber: '2', name: 'Incêndio', color: '#000', tasks: [] }],
      analyticCompositions: [composition('2', 'Zinco', 3), composition('1', 'Alumínio', 5)],
      warehouse: {
        materialLinks: [
          { id: 'link-zinco', warehouseItemKey: 'fisico-zinco', projectMaterialCode: '2', projectMaterialDescription: 'Zinco', projectMaterialUnit: 'un', conversionFactor: 1 },
          { id: 'link-aluminio', warehouseItemKey: 'fisico-aluminio', projectMaterialCode: '1', projectMaterialDescription: 'Alumínio', projectMaterialUnit: 'un', conversionFactor: 1 },
        ],
        requisitions: [{ id: 'req-1', number: 'REQ-1', date: '2026-09-05', status: 'entregue', chapterId: 'chapter-2', items: [], createdAt: '2026-09-05T10:00:00.000Z' }],
        movements: [
          { id: 'mov-zinco', type: 'retirada', date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-zinco', itemDescription: 'Zinco físico', itemUnit: 'un', quantity: 3 },
          { id: 'mov-aluminio', type: 'retirada', date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z', requisitionId: 'req-1', itemKey: 'fisico-aluminio', itemDescription: 'Alumínio físico', itemUnit: 'un', quantity: 1 },
        ],
      },
    } as unknown as Project;
    const view = render(<WarehouseBudgetMaterialsTab project={project} />);
    const materialHeader = screen.getByRole('button', { name: 'Material' });
    const withdrawnHeader = screen.getByRole('button', { name: 'Retirado (hierarquia)' });

    expect(screen.getByRole('button', { name: 'Contratado' })).toBeInTheDocument();
    expect(withdrawnHeader).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aditivo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Total planejado' })).not.toBeInTheDocument();
    expect(screen.getByText(/Ordem hierárquica: maior quantidade retirada primeiro/i)).toBeInTheDocument();
    expect(withdrawnHeader.closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(view.container.querySelector('tbody tr')?.textContent).toContain('Zinco');

    fireEvent.click(materialHeader);
    expect(materialHeader.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(view.container.querySelector('tbody tr')?.textContent).toContain('Alumínio');
  });
});
