import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import WarehouseWithdrawnMaterialsTab from './WarehouseWithdrawnMaterialsTab';

const project = {
  phases: [{ id: 'chapter-3', customNumber: '3', name: 'INCÊNDIO - CURVO 02', color: '#000', tasks: [] }],
  warehouse: {
    items: [
      { key: 'sirene', description: 'Sirene', unit: 'UN' },
      { key: 'luminaria', description: 'Luminária', unit: 'UN' },
    ],
    requisitions: [
      { id: 'req-1', number: 'REQ-1', date: '2026-09-04', status: 'entregue', chapterId: 'chapter-3', receiverName: 'Felipe', items: [], createdAt: '2026-09-04T08:15:00.000Z' },
      { id: 'req-2', number: 'REQ-2', date: '2026-09-04', status: 'entregue', chapterId: 'chapter-3', receiverName: 'Gabriel', items: [], createdAt: '2026-09-04T08:15:00.000Z' },
    ],
    movements: [
      { id: 'sirene-ret', type: 'retirada', date: '2026-09-04', createdAt: '2026-09-04T08:15:00.000Z', requisitionId: 'req-1', itemKey: 'sirene', itemCode: '001', itemDescription: 'Sirene audiovisual', itemUnit: 'UN', quantity: 9 },
      { id: 'lum-ret', type: 'retirada', date: '2026-09-04', createdAt: '2026-09-04T08:15:00.000Z', requisitionId: 'req-2', itemKey: 'luminaria', itemCode: '002', itemDescription: 'Luminária de emergência', itemUnit: 'UN', quantity: 3 },
    ],
    locations: [], equipments: [], equipmentGroups: [], custodyTerms: [],
  },
} as unknown as Project;

describe('WarehouseWithdrawnMaterialsTab', () => {
  it('filtra os materiais retirados por recebedor e busca', () => {
    render(<WarehouseWithdrawnMaterialsTab project={project} onOpenRequisition={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Retirado líquido' })).toBeInTheDocument();
    expect(screen.queryByText(/maior quantidade líquida retirada primeiro/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Código: 001')).not.toBeInTheDocument();
    expect(screen.getAllByText('Sirene audiovisual')).not.toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Recebedor'), { target: { value: 'Gabriel' } });
    expect(screen.queryAllByText('Sirene audiovisual')).toHaveLength(0);
    expect(screen.getAllByText('Luminária de emergência')).not.toHaveLength(0);

    fireEvent.change(screen.getByPlaceholderText('Código ou descrição'), { target: { value: 'sirene' } });
    expect(screen.queryAllByText('Luminária de emergência')).toHaveLength(0);
    expect(screen.getByText(/Nenhum material encontrado/i)).toBeInTheDocument();
  });

  it('exibe o número da requisição ao lado do material e abre a retirada selecionada', () => {
    const onOpenRequisition = vi.fn();
    render(<WarehouseWithdrawnMaterialsTab project={project} onOpenRequisition={onOpenRequisition} />);

    const links = screen.getAllByRole('button', { name: /Abrir retirada REQ-1/i });
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]);
    expect(onOpenRequisition).toHaveBeenCalledExactlyOnceWith('req-1');
  });

  it('mostra no registro o líquido após devolução', () => {
    const withReturn = structuredClone(project);
    withReturn.warehouse!.movements.push({
      id: 'sirene-return', type: 'devolucao', originType: 'return', requisitionId: 'req-1',
      date: '2026-09-05', createdAt: '2026-09-05T08:00:00.000Z', itemKey: 'sirene',
      itemDescription: 'Sirene audiovisual', itemUnit: 'UN', quantity: 3,
    });
    render(<WarehouseWithdrawnMaterialsTab project={withReturn} onOpenRequisition={vi.fn()} />);

    expect(screen.getAllByText('devolução: 3 UN', { exact: false })).toHaveLength(2);
    expect(screen.getAllByText('Registrado 9 · Devolvido 3')).toHaveLength(2);
    expect(screen.getAllByText('6 UN')).not.toHaveLength(0);
  });
});
