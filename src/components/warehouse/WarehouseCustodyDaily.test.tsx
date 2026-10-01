import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustodyTerm, Project } from '@/types/project';
import { emptyWarehouse, warehouseOperationalDate } from '@/lib/warehouse';
import WarehouseCustodyTab from './WarehouseCustodyTab';
import { generateCustodyTermPdf } from './pdf';

vi.mock('./pdf', () => ({ generateCustodyTermPdf: vi.fn(async () => undefined) }));

function makeProject(): Project {
  const terms: CustodyTerm[] = [
    { id: 'old', number: 'TC-2026-0001', issuedAt: '2026-09-28', createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-30T20:00:00.000Z', equipmentId: 'eq-old', equipmentName: 'Furadeira', workerName: 'Ana', chapterId: 'front-a', status: 'devolvido', returnedAt: '2026-09-30' },
    { id: 'front-a', number: 'TC-2026-0002', issuedAt: '2026-09-30', createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T12:00:00.000Z', equipmentId: 'eq-a', equipmentName: 'Perfurador de concreto de grande porte com maleta e acessórios completos', workerName: 'Bia', chapterId: 'front-a', status: 'devolvido', returnedAt: '2026-10-01' },
    { id: 'front-b', number: 'TC-2026-0003', issuedAt: '2026-09-30', createdAt: '2026-09-30T11:00:00.000Z', equipmentId: 'eq-b', equipmentName: 'Parafusadeira', workerName: 'Caio', chapterId: 'front-b', status: 'em_uso' },
    { id: 'building-b', number: 'TC-2026-0004', issuedAt: '2026-09-30', createdAt: '2026-09-30T13:00:00.000Z', equipmentId: 'eq-c', equipmentName: 'Esmerilhadeira', workerName: 'Davi', chapterId: 'building-b', status: 'em_uso' },
    { id: 'missing', number: 'TC-2026-0005', issuedAt: '2026-09-30', createdAt: '2026-09-30T14:00:00.000Z', equipmentId: 'eq-d', equipmentName: 'Andaime', workerName: 'Eva', status: 'em_uso' },
  ];
  return {
    id: 'custody-daily', name: 'Obra teste', startDate: '2026-09-01', endDate: '2026-12-31', totalBudget: 0,
    phases: [
      { id: 'building-a', name: 'Prédio A', color: '#000', tasks: [] },
      { id: 'front-a', parentId: 'building-a', name: 'Frente A', color: '#000', tasks: [] },
      { id: 'front-b', parentId: 'building-a', name: 'Frente B', color: '#000', tasks: [] },
      { id: 'building-b', name: 'Prédio B', color: '#000', tasks: [] },
    ],
    warehouse: { ...emptyWarehouse(), custodyTerms: terms },
  };
}

function switchView(name: 'Histórico completo' | 'Movimentações do dia') {
  const tab = screen.getByRole('tab', { name });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

describe('movimentações diárias de cautelas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });

  it('abre no dia atual e mostra termos de todos os capítulos em uma tabela ordenada pelo último registro', () => {
    render(<WarehouseCustodyTab project={makeProject()} onProjectChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Movimentações do dia' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByLabelText('Data das movimentações')).toHaveValue(warehouseOperationalDate());
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    const table = screen.getByRole('table', { name: 'Cautelas da data selecionada' });
    const rows = within(table).getAllByTestId('custody-history-row');
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual([
      'Cautela TC-2026-0005', 'Cautela TC-2026-0004', 'Cautela TC-2026-0002', 'Cautela TC-2026-0003',
    ]);
    for (const heading of ['Nº', 'Data da operação', 'Último registro', 'Recebedor', 'Destino', 'Equipamentos', 'Status', 'Incluído / alterado por']) {
      expect(within(table).getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    expect(rows[0]).toHaveTextContent('Prédio não informado');
    expect(rows[2]).toHaveTextContent('Frente A');
    expect(rows[3]).toHaveTextContent('Frente B');
    expect(screen.queryByTestId('custody-building-group')).not.toBeInTheDocument();
    expect(within(table).queryByText('TC-2026-0001')).not.toBeInTheDocument();
  });

  it('mantém nome completo e devolução dentro do detalhe do termo original', () => {
    render(<WarehouseCustodyTab project={makeProject()} onProjectChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('row', { name: 'Cautela TC-2026-0002' }));
    const details = screen.getByTestId('custody-history-details');
    expect(details.querySelector(':scope > td')).toHaveAttribute('colspan', '9');
    expect(details).toHaveTextContent('Perfurador de concreto de grande porte com maleta e acessórios completos');
    expect(details).toHaveTextContent('2026-10-01');
    expect(screen.getAllByTestId('custody-history-row')).toHaveLength(4);
  });

  it('gera um PDF por cautela da data selecionada', async () => {
    const project = makeProject();
    render(<WarehouseCustodyTab project={project} onProjectChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar PDFs' }));
    await vi.waitFor(() => expect(generateCustodyTermPdf).toHaveBeenCalledTimes(4));
    expect(vi.mocked(generateCustodyTermPdf).mock.calls.map(([, term]) => term.id)).toEqual(['missing', 'building-b', 'front-a', 'front-b']);
  });

  it('preserva o histórico e não grava ao mudar data, expandir ou trocar subaba', () => {
    const onProjectChange = vi.fn();
    const onCommitWarehouseScoped = vi.fn();
    render(<WarehouseCustodyTab project={makeProject()} onProjectChange={onProjectChange} onCommitWarehouseScoped={onCommitWarehouseScoped} />);
    fireEvent.change(screen.getByLabelText('Data das movimentações'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('row', { name: 'Cautela TC-2026-0002' }));
    switchView('Histórico completo');
    expect(screen.getByText('Histórico de cautelas')).toBeInTheDocument();
    expect(screen.getAllByTestId('custody-building-group')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /Expandir cautelas de 28\/09\/2026/i }));
    switchView('Movimentações do dia');
    expect(screen.getByLabelText('Data das movimentações')).toHaveValue('2026-09-30');
    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    expect(screen.getByLabelText('Data das movimentações')).toHaveValue(warehouseOperationalDate());
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(onCommitWarehouseScoped).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Nova cautela/i })).toBeInTheDocument();
  });
});
