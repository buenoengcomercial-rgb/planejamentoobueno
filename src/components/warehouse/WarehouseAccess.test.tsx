import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import Warehouse from './Warehouse';

vi.mock('./WarehousePanel', () => ({ default: () => <div>Conteúdo do painel</div> }));
vi.mock('./WarehouseStockTab', () => ({ default: () => <div>Conteúdo de materiais</div> }));
vi.mock('./WarehouseBudgetMaterialsTab', () => ({ default: () => <div>Conteúdo de materiais do orçamento</div> }));
vi.mock('./WarehouseWithdrawnMaterialsTab', () => ({ default: () => <div>Conteúdo de materiais retirados</div> }));
vi.mock('./WarehouseMovementsTab', () => ({ default: () => <div>Conteúdo de movimentações</div> }));
vi.mock('./WarehouseRequisitionsTab', () => ({ default: () => <div>Conteúdo de retiradas</div> }));
vi.mock('./WarehouseEquipmentsTab', () => ({ default: () => <div>Conteúdo de equipamentos</div> }));
vi.mock('./WarehouseInventoryTab', () => ({ default: () => <div>Conteúdo do inventário</div> }));
vi.mock('./WarehouseFiscalNotesTab', () => ({ default: () => <div>Conteúdo de entrada</div> }));

const project: Project = {
  id: 'project-owner-test',
  name: 'Obra teste',
  startDate: '2026-08-01',
  endDate: '2026-12-31',
  totalBudget: 0,
  phases: [],
  warehouse: emptyWarehouse(),
};

describe('controle de acesso do almoxarifado', () => {
  it('abre no Painel e mantém a mesma ordem no desktop e no seletor móvel', () => {
    render(<Warehouse project={project} onProjectChange={vi.fn()} />);

    expect(screen.getByText('Conteúdo do painel')).toBeInTheDocument();

    const expectedLabels = ['Painel', 'Entrada', 'Retiradas e devoluções', 'Materiais retirados', 'Materiais do orçamento', 'Materiais', 'Equipamentos', 'Movimentações', 'Inventário'];
    const desktopLabels = screen.getAllByRole('tab').map(tab => tab.textContent?.trim());
    const mobileSelect = screen.getByLabelText('Área do almoxarifado') as HTMLSelectElement;
    const mobileLabels = Array.from(mobileSelect.options).map(option => option.textContent);

    expect(desktopLabels).toEqual(expectedLabels);
    expect(mobileLabels).toEqual(expectedLabels);
    expect(mobileSelect).toHaveValue('painel');
    expect(screen.queryByText('Relatórios')).not.toBeInTheDocument();
  });

  it('permite acessar todas as áreas pelo seletor móvel', () => {
    render(<Warehouse project={project} onProjectChange={vi.fn()} />);

    const select = screen.getByLabelText('Área do almoxarifado');
    const areas = [
      ['notas', 'Conteúdo de entrada'],
      ['requisicoes', 'Conteúdo de retiradas'],
      ['materiais-retirados', 'Conteúdo de materiais retirados'],
      ['equipamentos', 'Conteúdo de equipamentos'],
      ['estoque', 'Conteúdo de materiais'],
      ['materiais-orcamento', 'Conteúdo de materiais do orçamento'],
      ['movimentos', 'Conteúdo de movimentações'],
      ['inventario', 'Conteúdo do inventário'],
      ['painel', 'Conteúdo do painel'],
    ];

    for (const [value, content] of areas) {
      fireEvent.change(select, { target: { value } });
      expect(screen.getByText(content)).toBeInTheDocument();
    }
  });

  it('oculta o Painel para o Almoxarife e abre diretamente em Entrada', () => {
    render(<Warehouse project={project} onProjectChange={vi.fn()} canViewPanel={false} />);

    expect(screen.queryByText('Conteúdo do painel')).not.toBeInTheDocument();
    expect(screen.getByText('Conteúdo de entrada')).toBeInTheDocument();

    const expectedLabels = ['Entrada', 'Retiradas e devoluções', 'Materiais retirados', 'Materiais do orçamento', 'Materiais', 'Equipamentos', 'Movimentações', 'Inventário'];
    const desktopLabels = screen.getAllByRole('tab').map(tab => tab.textContent?.trim());
    const mobileSelect = screen.getByLabelText('Área do almoxarifado') as HTMLSelectElement;
    const mobileLabels = Array.from(mobileSelect.options).map(option => option.textContent);

    expect(desktopLabels).toEqual(expectedLabels);
    expect(mobileLabels).toEqual(expectedLabels);
    expect(mobileSelect).toHaveValue('notas');
  });

  it('remove um Painel já aberto quando a permissão é retirada', async () => {
    const onProjectChange = vi.fn();
    const { rerender } = render(<Warehouse project={project} onProjectChange={onProjectChange} />);

    expect(screen.getByText('Conteúdo do painel')).toBeInTheDocument();

    rerender(<Warehouse project={project} onProjectChange={onProjectChange} canViewPanel={false} />);

    await waitFor(() => expect(screen.queryByText('Conteúdo do painel')).not.toBeInTheDocument());
    expect(screen.getByText('Conteúdo de entrada')).toBeInTheDocument();
    expect(screen.getByLabelText('Área do almoxarifado')).toHaveValue('notas');
  });

  it('remove a Administração global inclusive para o proprietário', () => {
    render(<Warehouse project={project} onProjectChange={vi.fn()} canDeleteWarehouseRecords canEditPostedWarehouseRecords />);
    expect(screen.queryByRole('button', { name: /Administração/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Limpeza dos dados de teste')).not.toBeInTheDocument();
  });
});
