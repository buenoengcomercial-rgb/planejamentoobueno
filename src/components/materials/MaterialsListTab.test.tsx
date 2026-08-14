import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdditiveComposition, MaterialComparison, Project } from '@/types/project';
import MaterialsListTab from './MaterialsListTab';

const newService: AdditiveComposition = {
  id: 'new-service',
  item: '2.9.1',
  code: 'NEW',
  bank: 'SINAPI',
  description: 'Novo serviço',
  quantity: 0,
  addedQuantity: 3,
  originalQuantity: 0,
  isNewService: true,
  unit: 'UN',
  unitPriceNoBDI: 0,
  unitPriceWithBDI: 0,
  total: 0,
  inputs: [{
    id: 'pending-input',
    code: 'MAT-PENDING',
    bank: 'SINAPI',
    description: 'Material ainda não contratado',
    unit: 'UN',
    coefficient: 2,
    unitPrice: 10,
    total: 20,
  }],
};

const comparison: MaterialComparison = {
  id: 'comparison',
  name: 'Compra',
  status: 'rascunho',
  suppliers: [],
  items: [],
  createdAt: '2026-08-14',
  updatedAt: '2026-08-14',
};

describe('MaterialsListTab', () => {
  it('mostra as três quantidades e bloqueia compra de item exclusivamente proposto', () => {
    const project = {
      id: 'project',
      name: 'Obra',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      totalBudget: 0,
      phases: [],
      additives: [{
        id: 'additive',
        name: 'Aditivo',
        importedAt: '2026-08-14',
        status: 'em_analise',
        compositions: [newService],
      }],
      materialComparisons: [comparison],
    } as Project;

    render(
      <MaterialsListTab
        project={project}
        comparison={comparison}
        onApply={vi.fn()}
        onProjectChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Qtd. contratada')).toBeInTheDocument();
    expect(screen.getByText('Qtd. aditivo')).toBeInTheDocument();
    expect(screen.getByText('Qtd. total')).toBeInTheDocument();
    expect(screen.getByText('Material ainda não contratado')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').at(-1)).toBeDisabled();
    expect(screen.getAllByTitle('Sem saldo liberado para compra após as supressões em andamento')).toHaveLength(2);
    expect(screen.getAllByTitle('Sem saldo liberado para compra após as supressões em andamento')[1]).toBeDisabled();
  });
});
