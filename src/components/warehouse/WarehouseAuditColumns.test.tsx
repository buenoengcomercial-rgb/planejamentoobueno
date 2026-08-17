import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import WarehouseMovementsTab from './WarehouseMovementsTab';
import WarehouseRequisitionsTab from './WarehouseRequisitionsTab';

function auditProject(): Project {
  const project: Project = {
    id: 'warehouse-audit-ui', name: 'Obra teste', startDate: '2026-08-01', endDate: '2026-12-31', totalBudget: 0, phases: [], warehouse: emptyWarehouse(),
  };
  project.warehouse!.movements = [{
    id: 'movement-1', createdAt: '2026-08-17T08:00:00.000Z', type: 'entrada', date: '2026-08-17', itemKey: 'material-1',
    itemDescription: 'Material teste', itemUnit: 'UN', quantity: 2,
    createdBy: { userName: 'Alice' }, updatedBy: { userName: 'Bruno' },
  }];
  project.warehouse!.requisitions = [{
    id: 'req-1', number: 'REQ-2026-0001', date: '2026-08-17', status: 'rascunho', items: [], createdAt: '2026-08-17T08:00:00.000Z',
    createdBy: { userName: 'Carla' }, updatedBy: { userName: 'Diego' },
  }];
  return project;
}

describe('colunas de auditoria do almoxarifado', () => {
  it('exibe criador e último alterador em Movimentações', () => {
    render(<WarehouseMovementsTab project={auditProject()} onProjectChange={vi.fn()} />);
    expect(screen.getByRole('columnheader', { name: 'Incluído / alterado por' })).toBeInTheDocument();
    expect(screen.getAllByText(/Alice/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Bruno/).length).toBeGreaterThan(0);
  });

  it('exibe criador e último alterador em Requisições', () => {
    render(<WarehouseRequisitionsTab project={auditProject()} onProjectChange={vi.fn()} />);
    expect(screen.getByRole('columnheader', { name: 'Incluído / alterado por' })).toBeInTheDocument();
    expect(screen.getAllByText(/Carla/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Diego/).length).toBeGreaterThan(0);
  });
});
