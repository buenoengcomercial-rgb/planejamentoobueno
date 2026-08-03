import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdditiveComposition } from '@/types/project';
import AdditiveAnalyticRows from './AdditiveAnalyticRows';

const composition: AdditiveComposition = {
  id: 'comp-analytic', item: '3.10.1', code: 'TESTE', bank: 'PRÓPRIO', description: 'Teste',
  quantity: 0, addedQuantity: 1, unit: 'UN', unitPriceNoBDI: 10, unitPriceWithBDI: 12,
  total: 0, isNewService: true,
  inputs: [{ id: 'input-1', code: 'I1', bank: 'SINAPI', description: 'Insumo', unit: 'UN', coefficient: 2, unitPrice: 5, total: 10 }],
};

describe('AdditiveAnalyticRows layout', () => {
  it('centraliza cabeçalhos, valores e campos numéricos', () => {
    const { container } = render(
      <AdditiveAnalyticRows
        c={composition} bdi={20} globalDiscount={0} isLocked={false}
        cb={{ analyticUnitWithBDI: 12, totalAnalyticWithBDI: 12, diff: 0 }} onUpdateComposition={vi.fn()}
      />,
    );
    expect(screen.getByText('Coef.')).toHaveClass('text-center');
    expect(screen.getByText('V. Unit s/ BDI')).toHaveClass('text-center');
    const coefficientInput = container.querySelector<HTMLInputElement>('[data-col-index="4"]')!;
    expect(coefficientInput).toHaveClass('text-center');
    expect(coefficientInput.closest('td')).toHaveClass('text-center');
  });

  it('não desconta insumos e mostra o resumo agregado da Administração', () => {
    render(
      <AdditiveAnalyticRows
        c={{
          ...composition,
          inputs: [{
            id: 'input-abhi', code: 'ABHI', bank: 'PRÓPRIO', description: 'Composição ABHI_3',
            unit: 'UN', coefficient: 1, unitPrice: 2775.03, total: 2775.03,
          }],
        }}
        bdi={27.58} globalDiscount={6} isLocked={false}
        cb={{ analyticUnitWithBDI: 3540.38, totalAnalyticWithBDI: 3540.38, diff: 0 }}
        onUpdateComposition={vi.fn()}
      />,
    );

    expect(screen.queryByText('V. Unit c/ Desc.')).not.toBeInTheDocument();
    expect(screen.queryByText('Total c/ Desc.')).not.toBeInTheDocument();
    expect(screen.getByText('Analítica s/ BDI com desconto da licitação (6%) — informativo:')).toBeInTheDocument();
    expect(screen.getByText('Valor analítico unitário c/ BDI e desconto — critério Administração:')).toBeInTheDocument();
    expect(screen.getByText('R$ 2.608,52')).toBeInTheDocument();
    expect(screen.getByText('R$ 3.327,95')).toBeInTheDocument();
  });

  it('recalcula e trunca as linhas importadas da FIXA_2', () => {
    render(
      <AdditiveAnalyticRows
        c={{
          ...composition,
          code: 'FIXA_2',
          inputs: [
            { id: '1', code: '1', bank: 'ORSE', description: 'Servente', unit: 'H', coefficient: 0.25, unitPrice: 14.58, total: 3.65 },
            { id: '2', code: '2', bank: 'ORSE', description: 'Encargos', unit: 'H', coefficient: 0.25, unitPrice: 3.80, total: 0.95 },
            { id: '3', code: '3', bank: 'ORSE', description: 'Porca', unit: 'UN', coefficient: 3, unitPrice: 0.22, total: 0.66 },
            { id: '4', code: '4', bank: 'ORSE', description: 'Encanador', unit: 'H', coefficient: 0.25, unitPrice: 20.44, total: 5.11 },
            { id: '5', code: '5', bank: 'ORSE', description: 'Vergalhão', unit: 'M', coefficient: 1, unitPrice: 9.83, total: 9.83 },
            { id: '6', code: '6', bank: 'ORSE', description: 'Chumbador', unit: 'UN', coefficient: 1, unitPrice: 3.59, total: 3.59 },
            { id: '7', code: '7', bank: 'ORSE', description: 'Abraçadeira', unit: 'UN', coefficient: 1, unitPrice: 1.43, total: 1.43 },
            { id: '8', code: '8', bank: 'ORSE', description: 'Encargos servente', unit: 'H', coefficient: 0.25, unitPrice: 3.87, total: 0.97 },
          ],
        }}
        bdi={27.58} globalDiscount={6} isLocked={false}
        cb={{ analyticUnitWithBDI: 0, totalAnalyticWithBDI: 0, diff: 0 }}
        onUpdateComposition={vi.fn()}
      />,
    );

    expect(screen.getByText('R$ 3,64')).toBeInTheDocument();
    expect(screen.getByText('R$ 0,96')).toBeInTheDocument();
    expect(screen.getByText('R$ 26,17')).toBeInTheDocument();
    expect(screen.getByText('R$ 24,59')).toBeInTheDocument();
    expect(screen.getByText('R$ 31,37')).toBeInTheDocument();
    expect(screen.queryByText('R$ 3,65')).not.toBeInTheDocument();
    expect(screen.queryByText('R$ 0,97')).not.toBeInTheDocument();
  });
});
