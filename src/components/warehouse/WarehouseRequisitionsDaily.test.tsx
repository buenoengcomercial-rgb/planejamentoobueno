import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, WarehouseRequisition } from '@/types/project';
import { emptyWarehouse, warehouseOperationalDate } from '@/lib/warehouse';
import WarehouseRequisitionsTab from './WarehouseRequisitionsTab';

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
    },
    {
      id: 'req-legacy', number: 'REQ-2026-0003', date: '2026-09-30', status: 'entregue',
      receiverName: 'Eva', createdAt: '2026-09-30T12:00:00.000Z', items: [item('Abraçadeira', 1)],
    },
  ];
  return {
    id: 'daily-withdrawals', name: 'Obra teste', startDate: '2026-09-01', endDate: '2026-12-31', totalBudget: 0,
    phases: [
      { id: 'building-a', name: 'Prédio A', color: '#000', tasks: [] },
      { id: 'front-a', parentId: 'building-a', name: 'Frente A', color: '#000', tasks: [] },
      { id: 'front-b', parentId: 'building-a', name: 'Frente B', color: '#000', tasks: [] },
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });

  it('abre no dia local atual e agrupa retirada, complemento e devolução somente pelo prédio raiz', () => {
    render(<WarehouseRequisitionsTab project={makeProject()} onProjectChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Movimentações do dia' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByLabelText('Data das movimentações')).toHaveValue(warehouseOperationalDate());

    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    const buildings = screen.getAllByTestId('daily-building-group');
    expect(buildings).toHaveLength(2);
    const known = buildings.find(building => building.textContent?.includes('Prédio A'))!;
    const missing = buildings.find(building => building.textContent?.includes('Prédio não informado'))!;
    expect(within(known).getAllByTestId('daily-activity')).toHaveLength(3);
    expect(within(known).getByText('REQ-2026-0002')).toBeInTheDocument();
    expect(within(known).getAllByText('REQ-2026-0001')).toHaveLength(2);
    expect(within(known).getByText('DEV-2026-0001')).toBeInTheDocument();
    expect(within(known).getByText(/Devolvido por Carlos/i)).toBeInTheDocument();
    expect(within(known).getByText(/Recebedor: Bia/i)).toBeInTheDocument();
    expect(within(known).getAllByText('2 UN')).toHaveLength(2);
    expect(within(known).getByText('1 UN')).toBeInTheDocument();
    expect(within(missing).getByText('REQ-2026-0003')).toBeInTheDocument();
    expect(screen.queryByText('5 UN')).not.toBeInTheDocument();
  });

  it('mostra devoluções na data delas e conserva o histórico completo e PDFs', () => {
    render(<WarehouseRequisitionsTab project={makeProject()} onProjectChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-28' } });
    expect(screen.getByText('Tubo')).toBeInTheDocument();
    expect(screen.queryByText('DEV-2026-0001')).not.toBeInTheDocument();

    switchView('Histórico completo');
    expect(screen.getByText('Histórico de retiradas e devoluções')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ativas' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Canceladas' })).toBeInTheDocument();
    const olderDate = screen.getAllByTestId('withdrawal-date-group').find(group => group.textContent?.includes('28/09/2026'))!;
    fireEvent.click(within(olderDate).getByRole('button', { name: /expandir requisições/i }));
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0001/i }));
    expect(screen.getAllByRole('button', { name: 'PDF' })).toHaveLength(2);
    expect(screen.getAllByText('DEV-2026-0001').length).toBeGreaterThan(0);
  });

  it('identifica operações estornadas sem apagar seus materiais do dia', () => {
    const project = makeProject();
    const supplement = project.warehouse!.requisitions[0].supplements![0];
    supplement.status = 'cancelled';
    supplement.cancelledItems = supplement.items;
    supplement.items = [];
    project.warehouse!.movements.find(movement => movement.id === 'return-1')!.reversedById = 'reversal-1';
    project.warehouse!.movements.find(movement => movement.id === 'return-2')!.reversedById = 'reversal-2';

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    const activities = screen.getAllByTestId('daily-activity');
    const cancelledSupplement = activities.find(activity => activity.textContent?.includes('Complemento'))!;
    const reversedReturn = activities.find(activity => activity.textContent?.includes('Devolução'))!;
    expect(cancelledSupplement).toHaveTextContent('Estornado');
    expect(cancelledSupplement).toHaveTextContent('Conexão');
    expect(cancelledSupplement).toHaveTextContent('3 UN');
    expect(reversedReturn).toHaveTextContent('Estornada');
    expect(reversedReturn).toHaveTextContent('Tubo');
  });

  it('não grava na nuvem ao escolher data, abrir prédio e trocar de subaba', () => {
    const onProjectChange = vi.fn();
    const onCommitCloudOperation = vi.fn();
    render(<WarehouseRequisitionsTab project={makeProject()} onProjectChange={onProjectChange} onCommitCloudOperation={onCommitCloudOperation} />);
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: /Prédio A/i }));
    fireEvent.click(screen.getByRole('button', { name: /Prédio A/i }));
    switchView('Histórico completo');
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
