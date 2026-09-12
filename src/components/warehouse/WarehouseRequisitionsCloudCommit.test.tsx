import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { addMovement, emptyWarehouse } from '@/lib/warehouse';
import WarehouseRequisitionsTab from '@/components/warehouse/WarehouseRequisitionsTab';

const { commitMock } = vi.hoisted(() => ({ commitMock: vi.fn() }));

vi.mock('@/lib/warehouseCloudCommit', () => ({ commitWarehouseOperation: commitMock }));
vi.mock('@/components/warehouse/SignaturePad', () => ({
  default: ({ value, onChange }: { value?: string; onChange: (value: string) => void }) => (
    <>
      <button type="button" onClick={() => onChange('assinatura')}>Assinar teste</button>
      {value && <img alt="Assinatura registrada" src={value} />}
    </>
  ),
}));

function projectWithStock(): Project {
  const project: Project = {
    id: 'p', name: 'Obra', startDate: '2026-09-01', endDate: '2026-12-31', totalBudget: 0,
    phases: [{ id: 'chapter-1', name: 'Prédio 1', color: '#000', tasks: [] }],
    warehouse: { ...emptyWarehouse(), receivers: [{ name: 'CANANDA' }] },
  };
  return addMovement(project, {
    type: 'entrada', date: '2026-09-12', itemKey: 'placa', itemCode: 'PL-01',
    itemDescription: 'Placa de sinalização', itemUnit: 'UN', quantity: 10,
  });
}

describe('confirmação visual da retirada', () => {
  it('não publica a linha nem libera PDF enquanto o servidor não confirmou', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
    let confirmServer: (() => void) | undefined;
    commitMock.mockImplementation((_before: Project, after: Project) => new Promise<Project>(resolve => {
      confirmServer = () => resolve(after);
    }));
    const onProjectChange = vi.fn();
    render(<WarehouseRequisitionsTab project={projectWithStock()} onProjectChange={onProjectChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(onProjectChange).not.toHaveBeenCalled();
    const pendingButton = screen.getByRole('button', { name: 'Registrando...' });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'PDF' })).not.toBeInTheDocument();

    await act(async () => confirmServer?.());
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(1));
  });

  it('preserva o formulário e não libera PDF quando a transação é rejeitada', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
    commitMock.mockRejectedValue(new Error('A auditoria desta operação não pôde ser validada.'));
    const onProjectChange = vi.fn();
    render(<WarehouseRequisitionsTab project={projectWithStock()} onProjectChange={onProjectChange} />);

    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    fireEvent.change(document.getElementById('withdrawal-chapter')!, { target: { value: 'chapter-1' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Quem recebeu' }));
    fireEvent.click(screen.getByText('CANANDA'));
    fireEvent.click(within(screen.getByLabelText('Materiais disponíveis')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Assinar teste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entregar e baixar estoque' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Entregar e baixar estoque' })).toBeEnabled());
    expect(onProjectChange).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Nova retirada de materiais' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Quem recebeu' })).toHaveTextContent('CANANDA');
    expect(within(dialog).getByText('Materiais selecionados')).toBeInTheDocument();
    expect(within(dialog).getByText('1 item(ns)')).toBeInTheDocument();
    expect(screen.getByAltText('Assinatura registrada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PDF' })).not.toBeInTheDocument();
  });
});
