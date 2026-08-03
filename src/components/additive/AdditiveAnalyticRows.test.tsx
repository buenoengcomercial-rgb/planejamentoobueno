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
});
