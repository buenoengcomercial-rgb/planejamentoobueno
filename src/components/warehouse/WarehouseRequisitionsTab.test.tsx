import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { addMovement, emptyWarehouse } from '@/lib/warehouse';
import WarehouseRequisitionsTab from './WarehouseRequisitionsTab';

function projectWithMaterials(count = 15): Project {
  let current: Project = {
    id: 'withdrawals-project',
    name: 'Obra teste',
    startDate: '2026-08-01',
    endDate: '2026-12-31',
    totalBudget: 0,
    phases: [{ id: 'chapter-1', name: 'Prédio 1', color: '#000', tasks: [] }],
    teams: [{ code: 'alpha', label: 'Alpha', active: true, composition: 'Ajudante', bgColor: '#eee', textColor: '#111', borderColor: '#999', barColor: '#555' }],
    warehouse: emptyWarehouse(),
  };
  for (let index = 0; index < count; index += 1) {
    current = addMovement(current, {
      type: 'entrada',
      date: '2026-08-01',
      itemKey: `material-${index}`,
      itemCode: `MAT-${String(index).padStart(3, '0')}`,
      itemDescription: index === count - 1 ? 'Válvula de Aço Carbono' : `Material disponível ${index}`,
      itemUnit: 'UN',
      quantity: 10,
      unitPrice: 5,
    });
  }
  return current;
}

describe('WarehouseRequisitionsTab', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('mostra todos os materiais antes da busca e filtra palavras ignorando acentos', () => {
    render(<WarehouseRequisitionsTab project={projectWithMaterials()} onProjectChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Nova retirada/i }));
    const available = screen.getByLabelText('Materiais disponíveis');
    expect(within(available).getAllByRole('button')).toHaveLength(15);

    fireEvent.click(within(available).getAllByRole('button')[0]);
    expect(screen.getByText('Materiais selecionados')).toBeInTheDocument();
    expect(screen.getByText('1 item(ns)')).toBeInTheDocument();
    expect(within(available).getAllByRole('button')).toHaveLength(14);

    fireEvent.change(screen.getByPlaceholderText('Buscar por código, descrição ou unidade'), { target: { value: 'valvula aco' } });
    expect(within(available).getAllByRole('button')).toHaveLength(1);
    expect(within(available).getByText('Válvula de Aço Carbono')).toBeInTheDocument();
  });

  it('usa histórico em largura total com detalhes expansíveis', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [{
      id: 'req-1', number: 'REQ-2026-0001', date: '2026-08-18', status: 'entregue',
      chapterId: 'chapter-1', chapterName: '1 Prédio 1', teamId: 'alpha', teamName: 'Alpha',
      receiverName: 'João', requesterName: 'João', signatureReceiver: 'assinatura', createdAt: '2026-08-18T10:00:00.000Z',
      items: [{ itemKey: 'material-0', code: 'MAT-000', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
    }];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    expect(screen.queryByText('Comprovante')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0001/i }));
    expect(screen.getAllByRole('button', { name: 'PDF' })).toHaveLength(2);
    expect(screen.getAllByText('Material disponível 0').length).toBeGreaterThan(1);
    expect(screen.getAllByRole('columnheader', { name: 'Retirado' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('columnheader', { name: 'Devolvido' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('columnheader', { name: 'Em campo' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('columnheader', { name: 'Equipe' })).not.toBeInTheDocument();
  });

  it('mostra a correção de retirada somente quando recebe permissão de Proprietário', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [{
      id: 'req-owner', number: 'REQ-2026-0009', date: '2026-08-18', status: 'entregue', chapterId: 'chapter-1', receiverName: 'João', requesterName: 'João', signatureReceiver: 'assinatura', createdAt: '2026-08-18T10:00:00.000Z',
      items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
    }];
    const first = render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0009/i }));
    expect(screen.queryByRole('button', { name: /Corrigir retirada/i })).not.toBeInTheDocument();
    first.unmount();

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0009/i }));
    expect(screen.getAllByRole('button', { name: /Corrigir retirada/i }).length).toBeGreaterThan(0);
  });

  it('prioriza a devolução registrada mais recentemente e mostra data e hora do registro', () => {
    const project = projectWithMaterials(1);
    project.warehouse!.requisitions = [
      {
        id: 'req-older', number: 'REQ-2026-0001', date: '2026-08-20', status: 'entregue', chapterId: 'chapter-1', chapterName: 'Prédio 1',
        receiverName: 'João', requesterName: 'João', signatureReceiver: 'assinatura', createdAt: '2026-08-20T14:00:00.000Z',
        items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
      },
      {
        id: 'req-returned', number: 'REQ-2026-0002', date: '2026-08-20', status: 'entregue', chapterId: 'chapter-1', chapterName: 'Prédio 1',
        receiverName: 'Maria', requesterName: 'Maria', signatureReceiver: 'assinatura', createdAt: '2026-08-20T08:00:00.000Z',
        items: [{ itemKey: 'material-0', description: 'Material disponível 0', unit: 'UN', quantity: 2 }],
      },
    ];
    project.warehouse!.movements.push({
      id: 'return-latest', type: 'devolucao', originType: 'return', requisitionId: 'req-returned', date: '2026-08-20', createdAt: '2026-08-20T16:30:00.000Z',
      itemKey: 'material-0', itemDescription: 'Material disponível 0', itemUnit: 'UN', quantity: 1,
    });

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    const rows = screen.getAllByTestId('withdrawal-history-row');
    expect(rows[0]).toHaveTextContent('REQ-2026-0002');
    expect(screen.getByRole('columnheader', { name: 'Último registro' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /REQ-2026-0002/i }));
    expect(screen.getAllByText(/registro:/i).length).toBeGreaterThan(0);
  });

  it('agrupa o fechamento por data e prédio, deixando o destino ausente no final', () => {
    const project = projectWithMaterials(0);
    project.phases = [
      { id: 'building-a', name: 'Prédio A', color: '#000', tasks: [], order: 0 },
      { id: 'building-b', name: 'Prédio B', color: '#000', tasks: [], order: 1 },
    ];
    project.warehouse!.requisitions = [
      { id: 'req-a', number: 'REQ-2026-0001', date: '2026-08-21', status: 'entregue', chapterId: 'building-a', receiverName: 'Ana', createdAt: '2026-08-21T08:00:00.000Z', items: [{ itemKey: 'a', description: 'Item A', unit: 'UN', quantity: 1 }] },
      { id: 'req-b', number: 'REQ-2026-0002', date: '2026-08-21', status: 'entregue', chapterId: 'building-b', receiverName: 'Bia', createdAt: '2026-08-21T09:00:00.000Z', items: [{ itemKey: 'b', description: 'Item B', unit: 'UN', quantity: 2 }] },
      { id: 'req-legacy', number: 'REQ-2026-0003', date: '2026-08-21', status: 'entregue', receiverName: 'Caio', createdAt: '2026-08-21T10:00:00.000Z', items: [] },
      { id: 'req-old', number: 'REQ-2026-0004', date: '2026-08-20', status: 'entregue', chapterId: 'building-a', receiverName: 'Dani', createdAt: '2026-08-20T10:00:00.000Z', items: [] },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    const dateRows = screen.getAllByTestId('withdrawal-date-group').filter(element => element.tagName === 'TR');
    expect(dateRows[0]).toHaveTextContent('21/08/2026');
    expect(dateRows[1]).toHaveTextContent('20/08/2026');

    const destinationRows = screen.getAllByTestId('withdrawal-destination-group').filter(element => element.tagName === 'TR');
    expect(destinationRows[0]).toHaveTextContent('Prédio A');
    expect(destinationRows[1]).toHaveTextContent('Prédio B');
    expect(destinationRows[2]).toHaveTextContent('Destino não informado');
    expect(destinationRows[0]).toHaveTextContent('1 requisição(ões) · 1 item(ns)');
  });

  it('usa a hierarquia completa da EAP no destino e preserva o fallback legado', () => {
    const project = projectWithMaterials(0);
    project.phases = [
      { id: 'root', name: 'Prédio', color: '#000', tasks: [], order: 0 },
      { id: 'system', name: 'Incêndio', color: '#000', tasks: [], parentId: 'root', order: 0 },
      { id: 'service', name: 'Hidrantes', color: '#000', tasks: [], parentId: 'system', order: 0 },
    ];
    project.warehouse!.requisitions = [
      {
        id: 'req-hierarchy', number: 'REQ-2026-0003', date: '2026-08-18', status: 'entregue', chapterId: 'service',
        receiverName: 'Ana', requesterName: 'Ana', signatureReceiver: 'assinatura', createdAt: '2026-08-18T10:00:00.000Z', items: [],
      },
      {
        id: 'req-legacy', number: 'REQ-2026-0004', date: '2026-08-17', status: 'entregue', chapterName: 'Destino legado',
        receiverName: 'Bia', requesterName: 'Bia', signatureReceiver: 'assinatura', createdAt: '2026-08-17', items: [],
      },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);

    expect(screen.getAllByText('1.1.1 · Prédio > Incêndio > Hidrantes').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Registro legado: 17\/08\/2026/).length).toBeGreaterThan(0);
  });

  it('move cautelas para a subaba Equipamentos / Cautelas', () => {
    const project = projectWithMaterials(0);
    project.warehouse!.custodyTerms = [{
      id: 'term-legacy', number: 'TC-2025-0001', createdAt: '2025-01-01T10:00:00.000Z', issuedAt: '2025-01-01',
      equipmentId: 'legacy-equipment', equipmentName: 'Furadeira antiga', workerName: 'Maria', status: 'em_uso',
    }];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    const equipmentTab = screen.getByRole('tab', { name: /Equipamentos \/ Cautelas/i });
    fireEvent.mouseDown(equipmentTab, { button: 0, ctrlKey: false });
    fireEvent.click(equipmentTab);

    expect(screen.getByRole('button', { name: /Nova cautela/i })).toBeInTheDocument();
    expect(screen.getAllByText('TC-2025-0001').length).toBeGreaterThan(0);
  });

  it('permite selecionar vários equipamentos disponíveis na mesma cautela', () => {
    const project = projectWithMaterials(0);
    project.warehouse!.equipments = [
      { id: 'eq-1', name: 'Furadeira', description: 'Furadeira', internalCode: 'EQ-001', serial: 'SER-001', status: 'disponivel', createdAt: '2026-08-18T10:00:00.000Z' },
      { id: 'eq-2', name: 'Parafusadeira', description: 'Parafusadeira', internalCode: 'EQ-002', patrimony: 'PAT-002', status: 'disponivel', createdAt: '2026-08-18T10:00:00.000Z' },
    ];

    render(<WarehouseRequisitionsTab project={project} onProjectChange={vi.fn()} />);
    const equipmentTab = screen.getByRole('tab', { name: /Equipamentos \/ Cautelas/i });
    fireEvent.mouseDown(equipmentTab, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('button', { name: /Nova cautela/i }));
    const available = screen.getByLabelText('Equipamentos disponíveis');
    const equipmentButtons = within(available).getAllByRole('button');
    fireEvent.click(equipmentButtons[0]);
    fireEvent.click(within(available).getAllByRole('button')[0]);

    expect(screen.getAllByLabelText('Estado na entrega')).toHaveLength(2);
    expect(within(available).queryAllByRole('button')).toHaveLength(0);
  });
});
