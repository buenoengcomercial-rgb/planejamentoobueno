import { render, screen, within } from '@testing-library/react';
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
    const row = screen.getByText('Material ainda não contratado').closest('tr');
    expect(row).not.toBeNull();
    const cells = row!.querySelectorAll('td');
    expect(cells[7]).toHaveTextContent('0,00');
    expect(cells[8]).toHaveTextContent('6,00');
    expect(cells[9]).toHaveTextContent('6,00');
    expect(within(row!).getByRole('checkbox')).toBeDisabled();
    const blockedTitle = 'Sem quantidade liberada para compra; acréscimos pendentes são apenas informativos';
    expect(screen.getAllByTitle(blockedTitle)).toHaveLength(2);
    expect(screen.getAllByTitle(blockedTitle)[1]).toBeDisabled();
  });

  it('mantém o acréscimo formalizado na coluna aditivo e o libera para compra', () => {
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
        status: 'aditivo_contratado',
        isContracted: true,
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

    const row = screen.getByText('Material ainda não contratado').closest('tr');
    expect(row).not.toBeNull();
    const cells = row!.querySelectorAll('td');
    expect(cells[7]).toHaveTextContent('0,00');
    expect(cells[8]).toHaveTextContent('6,00');
    expect(cells[9]).toHaveTextContent('6,00');
    expect(within(row!).getByRole('checkbox')).toBeEnabled();
    expect(within(row!).getAllByRole('combobox').at(-1)).toBeEnabled();
  });
});
