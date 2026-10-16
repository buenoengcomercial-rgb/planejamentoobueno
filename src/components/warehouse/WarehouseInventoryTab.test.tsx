import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('mantém a base de outra contagem pendente após confirmar a primeira linha', async () => {
    const project = projectWithOpenInventory(2);
    const commit = vi.fn(async (next: Project, _domain: string, _base?: Project) => next);
    const view = render(<WarehouseInventoryTab project={project} onProjectChange={vi.fn()} onCommitWarehouseScoped={commit} />);
    const inputs = screen.getAllByRole('spinbutton');
    // Desktop has one input per line; mobile duplicates the same records later.
    fireEvent.change(inputs[0], { target: { value: '8' } });
    fireEvent.change(inputs[1], { target: { value: '7' } });
    fireEvent.blur(inputs[0]);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const accepted = commit.mock.calls[0][0];
    view.rerender(<WarehouseInventoryTab project={accepted} onProjectChange={vi.fn()} onCommitWarehouseScoped={commit} />);
    fireEvent.blur(screen.getAllByRole('spinbutton')[1]);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit.mock.calls[1][2]).toBe(project);
  });
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

  it('abre conferência pontual somente para o material escolhido e registra o motivo', async () => {
    const onProjectChange = vi.fn();
    render(<WarehouseInventoryTab project={projectWithOpenInventory(2)} onProjectChange={onProjectChange} auditActor={{ userId: 'almoxarife-1', userName: 'Almoxarife' }} />);
    fireEvent.change(screen.getByPlaceholderText('Código ou descrição'), { target: { value: 'INV-001' } });
    fireEvent.click(screen.getByRole('button', { name: /Material final pesquisável.*Adicionar/ }));
    fireEvent.change(screen.getByPlaceholderText('Ex.: devolução sem requisição identificada'), { target: { value: 'Conferência física após devolução sem origem' } });
    fireEvent.click(screen.getByRole('button', { name: 'Abrir conferência pontual' }));
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(1));
    const next = onProjectChange.mock.calls[0][0] as Project;
    const spot = next.warehouse!.inventorySessions!.find(session => session.kind === 'spot');
    expect(spot).toMatchObject({ justification: 'Conferência física após devolução sem origem' });
    expect(spot?.lines.map(line => line.itemKey)).toEqual(['inventory-material-1']);
  });
});
