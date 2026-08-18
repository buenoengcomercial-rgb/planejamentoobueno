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
    teams: [{ code: 'alpha', label: 'Alpha', active: true }],
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
