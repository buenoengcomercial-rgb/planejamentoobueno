import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project, WarehouseFiscalNote } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import WarehouseFiscalNotesTab from './WarehouseFiscalNotesTab';

function projectWithPostedNote(): Project {
  const fiscalNote: WarehouseFiscalNote = {
    id: 'posted-note', createdAt: '2026-08-15T10:00:00.000Z', updatedAt: '2026-08-15T10:00:00.000Z',
    createdBy: { userId: 'user-a', userName: 'Alice', userEmail: 'alice@teste.com' },
    updatedBy: { userId: 'user-b', userName: 'Bruno', userEmail: 'bruno@teste.com' },
    status: 'aprovada', origin: 'upload', sourceFileName: 'whatsapp-image.jpg',
    supplierName: 'FREITAS & CIA LTDA', supplierCnpj: '02.179.328/0001-42', invoiceNumber: '1.301.412',
    issueDate: '2026-08-14', totalAmount: 85.63,
    items: [{
      id: 'posted-item', itemKey: 'warehouse-nf|material-1', productCode: '7563',
      description: 'FITA CREPE 24MM X 50M', quantity: 2, unit: 'UN', unitPrice: 42.815, totalPrice: 85.63,
    }],
  };
  const project: Project = {
    id: 'project-ui', name: 'Obra teste', startDate: '2026-08-01', endDate: '2026-12-31',
    totalBudget: 0, phases: [], warehouse: emptyWarehouse(),
    materialComparisons: [{ id: 'group-1', name: 'Ferramentas' }] as Project['materialComparisons'],
  };
  project.warehouse!.fiscalNotes = [fiscalNote];
  project.warehouse!.items = [{ key: 'warehouse-nf|material-1', description: 'FITA CREPE 24MM X 50M', unit: 'UN', manualItem: true }];
  return project;
}

describe('WarehouseFiscalNotesTab - lançamento simplificado', () => {
  it('mostra somente lançadas/arquivadas e restaura as colunas sem Arquivo', () => {
    render(<WarehouseFiscalNotesTab project={projectWithPostedNote()} onProjectChange={vi.fn()} canManage />);
    expect(screen.queryByText(/Para conferir/i)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Lançadas no estoque \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Arquivadas \(0\)/i })).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader').map(header => header.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Fornecedor', 'Nº', 'CNPJ', 'Nota', 'Data', 'Itens', 'Valor', 'Status', 'Incluído / alterado por', 'Ações']));
    expect(headers).not.toContain('Arquivo');
    expect(screen.getAllByText(/Incluído por:/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Alice/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Bruno/i).length).toBeGreaterThan(0);
  });

  it('não mostra classificação não fiscal e exibe cabeçalhos e grupo de compra', () => {
    render(<WarehouseFiscalNotesTab project={projectWithPostedNote()} onProjectChange={vi.fn()} canManage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Visualizar dados e grupos' })[0]);
    expect(screen.queryByText(/Documento não fiscal/i)).not.toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    const headers = within(dialog).getAllByRole('columnheader').map(header => header.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Cód. prod.', 'Descrição', 'Qtd', 'Un', 'V. unit. NF', 'V. unit. global', 'V. total', 'Grupo de compra']));
    expect(within(dialog).getAllByRole('combobox')).not.toHaveLength(0);
    within(dialog).getAllByRole('combobox').forEach(combobox => expect(combobox).toBeEnabled());
  });
});
