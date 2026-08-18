import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import Warehouse from './Warehouse';

vi.mock('./WarehousePanel', () => ({ default: () => null }));
vi.mock('./WarehouseStockTab', () => ({ default: () => null }));
vi.mock('./WarehouseMovementsTab', () => ({ default: () => null }));
vi.mock('./WarehouseRequisitionsTab', () => ({ default: () => null }));
vi.mock('./WarehouseEquipmentsTab', () => ({ default: () => null }));
vi.mock('./WarehouseInventoryTab', () => ({ default: () => <div>Conteúdo do inventário</div> }));
vi.mock('./WarehouseReportsTab', () => ({ default: () => null }));
vi.mock('./WarehouseFiscalNotesTab', () => ({ default: () => null }));

const project: Project = {
  id: 'project-owner-test',
  name: 'Obra teste',
  startDate: '2026-08-01',
  endDate: '2026-12-31',
  totalBudget: 0,
  phases: [],
  warehouse: emptyWarehouse(),
};

describe('controle de acesso à limpeza do almoxarifado', () => {
  it('permite acessar todas as áreas pelo seletor móvel', () => {
    render(<Warehouse project={project} onProjectChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Área do almoxarifado'), { target: { value: 'inventario' } });

    expect(screen.getByText('Conteúdo do inventário')).toBeInTheDocument();
  });

  it('não mostra Administração para usuários sem permissão de proprietário', () => {
    render(<Warehouse project={project} onProjectChange={vi.fn()} canClearWarehouse={false} />);
    expect(screen.queryByRole('button', { name: /Administração/i })).not.toBeInTheDocument();
  });

  it('exige senha do proprietário antes de solicitar a limpeza', async () => {
    const onClearWarehouse = vi.fn().mockResolvedValue(undefined);
    render(
      <Warehouse
        project={project}
        onProjectChange={vi.fn()}
        canClearWarehouse
        onClearWarehouse={onClearWarehouse}
      />,
    );

    const administration = screen.getByRole('button', { name: /Administração/i });
    administration.focus();
    fireEvent.keyDown(administration, { key: 'Enter', code: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Limpar almoxarifado/i }));

    const password = await screen.findByLabelText('Confirme a senha da sua conta');
    fireEvent.change(password, { target: { value: 'senha-segura' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e limpar' }));

    await waitFor(() => expect(onClearWarehouse).toHaveBeenCalledWith('senha-segura'));
    await waitFor(() => expect(screen.queryByText('Acesso exclusivo do proprietário')).not.toBeInTheDocument());
  });
});
