import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import WarehouseBudgetMaterialsTab from './WarehouseBudgetMaterialsTab';

const composition = (id: string, description: string, quantity: number) => ({
  id, item: `2.1.${id}`, code: id, description, quantity, unit: 'un', unitPriceNoBDI: 1, unitPriceWithBDI: 1, total: quantity,
  inputs: [{ id: `input-${id}`, code: id, description, unit: 'un', coefficient: 1, unitPrice: 1, total: 1, type: 'material' as const }], phaseId: 'chapter-2',
});

describe('WarehouseBudgetMaterialsTab', () => {
  it('ordena materiais pelo cabeçalho em ordem alfabética crescente e decrescente', () => {
    const project = {
      phases: [{ id: 'chapter-2', customNumber: '2', name: 'Incêndio', color: '#000', tasks: [] }],
      analyticCompositions: [composition('2', 'Zinco', 3), composition('1', 'Alumínio', 5)],
    } as unknown as Project;
    const view = render(<WarehouseBudgetMaterialsTab project={project} />);
    const materialHeader = screen.getByRole('button', { name: 'Material' });

    expect(screen.getByRole('button', { name: 'Contratado' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retirado' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aditivo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Total planejado' })).not.toBeInTheDocument();
    expect(materialHeader.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(view.container.querySelector('tbody tr')?.textContent).toContain('Alumínio');

    fireEvent.click(materialHeader);
    expect(materialHeader.closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(view.container.querySelector('tbody tr')?.textContent).toContain('Zinco');
  });
});
