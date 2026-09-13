import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { addMovement, createInventorySession, emptyWarehouse } from '@/lib/warehouse';
import WarehouseInventoryTab from './WarehouseInventoryTab';

function projectWithOpenInventory(count = 75): Project {
  let project: Project = {
    id: 'inventory-pagination-test',
    name: 'Obra teste',
    startDate: '2026-08-01',
    endDate: '2026-12-31',
    totalBudget: 0,
    phases: [],
    warehouse: emptyWarehouse(),
  };
  for (let index = 0; index < count; index += 1) {
    project = addMovement(project, {
      type: 'entrada',
      date: '2026-09-01',
      itemKey: `inventory-material-${index}`,
      itemCode: `INV-${String(index).padStart(3, '0')}`,
      itemDescription: index === count - 1 ? 'Material final pesquisável' : `Material de inventário ${index}`,
      itemUnit: 'UN',
      quantity: 10,
    });
  }
  return createInventorySession(project, '2026-09').project;
}

describe('WarehouseInventoryTab', () => {
  it('pagina a contagem sem alterar o total e permite localizar qualquer material', () => {
    render(<WarehouseInventoryTab project={projectWithOpenInventory()} onProjectChange={vi.fn()} />);

    expect(screen.getByText('0 de 75 materiais contados')).toBeInTheDocument();
    expect(screen.getAllByRole('spinbutton')).toHaveLength(50);
    expect(screen.getByText('Página 1 de 3')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar material no inventário' }), { target: { value: 'INV-074' } });
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
    expect(screen.getAllByText('Material final pesquisável')).toHaveLength(2);
    expect(screen.getByText('1 de 75 material(is)')).toBeInTheDocument();
  });
});
