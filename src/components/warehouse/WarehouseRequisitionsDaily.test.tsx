import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, WarehouseRequisition } from '@/types/project';
import { emptyWarehouse, warehouseOperationalDate } from '@/lib/warehouse';
import WarehouseRequisitionsTab from './WarehouseRequisitionsTab';
import { generateDailyWithdrawalConfirmationPdfs } from './pdf';

vi.mock('./pdf', () => ({ generateDailyWithdrawalConfirmationPdfs: vi.fn(async () => 1) }));

const item = (description: string, quantity: number) => ({ itemKey: description, description, unit: 'UN', quantity });

function makeProject(): Project {
  const requisitions: WarehouseRequisition[] = [
    {
      id: 'req-old', number: 'REQ-2026-0001', date: '2026-09-28', status: 'entregue', chapterId: 'front-a',
      receiverName: 'Ana', createdAt: '2026-09-28T10:00:00.000Z', items: [item('Tubo', 5)],
      supplements: [{
        id: 'supp-1', date: '2026-09-30', receiverName: 'Bia', signatureReceiver: 'assinatura',
        idempotencyKey: 'supp-key', createdAt: '2026-09-30T11:00:00.000Z', items: [item('Conexão', 3)],
      }],
    },
    {
      id: 'req-today', number: 'REQ-2026-0002', date: '2026-09-30', status: 'entregue', chapterId: 'front-b',
      receiverName: 'Daniel', createdAt: '2026-09-30T09:00:00.000Z', items: [item('Registro', 2)],
      supplements: [{
        id: 'supp-today', date: '2026-09-30', receiverName: 'Daniel', signatureReceiver: 'assinatura',
        idempotencyKey: 'supp-today-key', createdAt: '2026-09-30T11:00:00.000Z', items: [item('Conexão nova', 3)],
      }],
    },
    {
      id: 'req-legacy', number: 'REQ-2026-0003', date: '2026-09-30', status: 'entregue',
      receiverName: 'Eva', createdAt: '2026-09-30T12:00:00.000Z', items: [item('Abraçadeira', 1)],
    },
    { id: 'req-building-b', number: 'REQ-2026-0004', date: '2026-09-30', status: 'cancelada', chapterId: 'building-b', receiverName: 'Bruno', createdAt: '2026-09-30T13:00:00.000Z', items: [item('Cabo', 1)] },
    { id: 'req-front-a', number: 'REQ-2026-0005', date: '2026-09-30', status: 'entregue', chapterId: 'front-a', receiverName: 'Alice', createdAt: '2026-09-30T15:00:00.000Z', items: [item('Curva', 1)] },
  ];
  return {
    id: 'daily-withdrawals', name: 'Obra teste', startDate: '2026-09-01', endDate: '2026-12-31', totalBudget: 0,
    phases: [
      { id: 'building-a', name: 'Prédio A', color: '#000', tasks: [] },
      { id: 'front-a', parentId: 'building-a', name: 'Frente A', color: '#000', tasks: [] },
      { id: 'front-b', parentId: 'building-a', name: 'Frente B', color: '#000', tasks: [] },
      { id: 'building-b', name: 'Prédio B', color: '#000', tasks: [] },
    ],
    warehouse: {
      ...emptyWarehouse(), requisitions,
      movements: [
        { id: 'return-1', type: 'devolucao', originType: 'return', originId: 'return-key', requisitionId: 'req-old',
          returnNumber: 'DEV-2026-0001', returnerName: 'Carlos', date: '2026-09-30', createdAt: '2026-09-30T14:00:00.000Z',
          itemKey: 'Tubo', itemDescription: 'Tubo', itemUnit: 'UN', quantity: 2 },
        { id: 'return-2', type: 'devolucao', originType: 'return', originId: 'return-key', requisitionId: 'req-old',
          returnNumber: 'DEV-2026-0001', returnerName: 'Carlos', date: '2026-09-30', createdAt: '2026-09-30T14:00:00.000Z',
          itemKey: 'Conexão', itemDescription: 'Conexão', itemUnit: 'UN', quantity: 1 },
        { id: 'return-today', type: 'devolucao', originType: 'return', originId: 'return-today-key', requisitionId: 'req-today',
          returnNumber: 'DEV-2026-0002', returnerName: 'Daniel', date: '2026-09-30', createdAt: '2026-09-30T14:00:00.000Z',
          itemKey: 'Registro', itemDescription: 'Registro', itemUnit: 'UN', quantity: 1 },
      ],
    },
  };
}

function switchView(name: 'Histórico completo' | 'Movimentações do dia') {
  const tab = screen.getByRole('tab', { name });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

describe('movimentações diárias de materiais', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });

  it('abre no dia local atual e mostra as requisições da data em uma tabela única', () => {
    render(<WarehouseRequisitionsTab project={makeProject()} onProjectChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Movimentações do dia' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByLabelText('Data das movimentações')).toHaveValue(warehouseOperationalDate());

    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    const table = screen.getByRole('table', { name: 'Requisições da data selecionada' });
    const rows = within(table).getAllByTestId('withdrawal-history-row');
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual([
      'Retirada REQ-2026-0005', 'Retirada REQ-2026-0002', 'Retirada REQ-2026-0004', 'Retirada REQ-2026-0003',
    ]);
    for (const heading of ['Nº', 'Data da operação', 'Último registro', 'Recebedor', 'Destino', 'Itens', 'Status', 'Incluído / alterado por']) {
      expect(within(table).getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    expect(rows[1]).toHaveTextContent('Frente B');
    expect(rows[3]).toHaveTextContent('Prédio não informado');
    expect(within(table).queryByText('REQ-2026-0001')).not.toBeInTheDocument();
    expect(screen.queryByTestId('daily-building-group')).not.toBeInTheDocument();
    expect(screen.queryByText('Prédio A')).not.toBeInTheDocument();
    expect(screen.queryByText('Prédio B')).not.toBeInTheDocument();
    expect(within(rows[2]).getByText('Cancelada')).toBeInTheDocument();
  });

  it('mantém materiais, complementos, devoluções e destino no detalhe da requisição original', () => {
    render(<WarehouseRequisitionsTab project={makeProject()} onProjectChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('row', { name: 'Retirada REQ-2026-0002' }));
    const details = screen.getByTestId('withdrawal-history-details');
    expect(details.querySelector(':scope > td')).toHaveAttribute('colspan', '9');
    expect(details).toHaveTextContent('Prédio A');
    expect(details).toHaveTextContent('Frente B');
    expect(details).toHaveTextContent('Registro');
    expect(details).toHaveTextContent('Conexão nova');
    expect(details).toHaveTextContent('DEV-2026-0002');
    expect(details).toHaveTextContent('Complemento adicionado');
    expect(screen.getAllByTestId('withdrawal-history-row')).toHaveLength(4);

    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-28' } });
    expect(screen.getAllByTestId('withdrawal-history-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('row', { name: 'Retirada REQ-2026-0001' }));
    expect(screen.getByTestId('withdrawal-history-details')).toHaveTextContent('DEV-2026-0001');
  });

  it('gera os PDFs da data escolhida, mantendo cada prédio identificado no documento', async () => {
    render(<WarehouseRequisitionsTab project={makeProject()} onProjectChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar PDFs' }));
    await vi.waitFor(() => expect(generateDailyWithdrawalConfirmationPdfs).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(generateDailyWithdrawalConfirmationPdfs).mock.calls.map(([, options]) => options);
    expect(calls.map(options => options.requisitions.map(requisition => requisition.id))).toEqual([['req-front-a', 'req-today'], ['req-legacy']]);
    expect(calls[0].buildingLabel).toContain('Prédio A');
    expect(calls[1].buildingLabel).toBe('Prédio não informado');
  });

  it('preserva o histórico completo e não grava ao mudar data, expandir linha ou trocar subaba', () => {
    const onProjectChange = vi.fn();
    const onCommitCloudOperation = vi.fn();
    render(<WarehouseRequisitionsTab project={makeProject()} onProjectChange={onProjectChange} onCommitCloudOperation={onCommitCloudOperation} />);
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('row', { name: 'Retirada REQ-2026-0002' }));
    fireEvent.click(screen.getByRole('row', { name: 'Retirada REQ-2026-0002' }));
    switchView('Histórico completo');
    expect(screen.getByText('Histórico de retiradas e devoluções')).toBeInTheDocument();
    expect(screen.getAllByTestId('withdrawal-building-group')).toHaveLength(2);
    const historyDate = screen.getAllByTestId('withdrawal-date-group')[0];
    fireEvent.click(within(historyDate).getByRole('button', { name: /requisições/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Canceladas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ativas' }));
    switchView('Movimentações do dia');
    expect(screen.getByRole('tab', { name: 'Movimentações do dia' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByLabelText('Data das movimentações')).toHaveValue('2026-09-30');
    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    expect(screen.getByLabelText('Data das movimentações')).toHaveValue(warehouseOperationalDate());
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(onCommitCloudOperation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Nova retirada/i })).toBeInTheDocument();
  });
});
