import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import Warehouse from './Warehouse';

vi.mock('./WarehousePanel', () => ({ default: () => <div>Conteúdo do painel</div> }));
vi.mock('./WarehouseStockTab', () => ({ default: () => <div>Conteúdo de materiais</div> }));
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

describe('controle de acesso à limpeza do almoxarifado', () => {
  it('abre no Painel e mantém a mesma ordem no desktop e no seletor móvel', () => {
    render(<Warehouse project={project} onProjectChange={vi.fn()} />);

    expect(screen.getByText('Conteúdo do painel')).toBeInTheDocument();

    const expectedLabels = ['Painel', 'Entrada', 'Retiradas', 'Equipamentos', 'Materiais', 'Movimentações', 'Inventário'];
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
      ['equipamentos', 'Conteúdo de equipamentos'],
      ['estoque', 'Conteúdo de materiais'],
      ['movimentos', 'Conteúdo de movimentações'],
      ['inventario', 'Conteúdo do inventário'],
      ['painel', 'Conteúdo do painel'],
    ];

    for (const [value, content] of areas) {
      fireEvent.change(select, { target: { value } });
      expect(screen.getByText(content)).toBeInTheDocument();
    }
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

    expect(await screen.findByText('Equipamentos serão preservados')).toBeInTheDocument();
    expect(screen.getByText(/Cadastro, código, patrimônio, fotos e identificação não serão apagados/i)).toBeInTheDocument();
    expect(screen.getByText(/Equipamentos em cautelas de teste voltarão para Disponível/i)).toBeInTheDocument();

    const password = await screen.findByLabelText('Confirme a senha da sua conta');
    fireEvent.change(password, { target: { value: 'senha-segura' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e limpar' }));

    await waitFor(() => expect(onClearWarehouse).toHaveBeenCalledWith('senha-segura'));
    await waitFor(() => expect(screen.queryByText('Limpeza dos dados de teste')).not.toBeInTheDocument());
  });
});
