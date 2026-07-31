import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdditiveComposition, Project } from '@/types/project';
import AdditiveCompositionRow from './AdditiveCompositionRow';

const composition: AdditiveComposition = {
  id: 'comp-1', item: '1.1.1', itemNumber: '1.1.1', code: 'ADM04', bank: 'PRÓPRIO',
  description: 'Administração de Obra', quantity: 6, originalQuantity: 6, unit: 'MÊS',
  unitPriceNoBDI: 12595.53, unitPriceWithBDI: 16069.37, total: 96416.22,
  inputs: [{ id: 'i1', code: 'MO1', bank: 'PRÓPRIO', description: 'Engenheiro', unit: 'H', coefficient: 1, unitPrice: 1, total: 1 }],
};

const project = { analyticCompositions: [], budgetItems: [] } as unknown as Project;

function renderRow(options: { mode: 'memory' | 'analytic'; isOpen: boolean }) {
  const onToggleExpand = vi.fn();
  const onSelectDetail = vi.fn();
  render(
    <table><tbody>
      <AdditiveCompositionRow
        project={project}
        c={composition}
        bdi={27.58}
        globalDiscount={0}
        isLocked={false}
        isOpen={options.isOpen}
        isMemoryOpen={options.mode === 'memory'}
        showAnalytic
        onToggleExpand={onToggleExpand}
        onUpdateComposition={vi.fn()}
        onUpdateQuantity={vi.fn()}
        onRemoveComposition={vi.fn()}
        onChangeMemory={vi.fn()}
        selectedDetail={{ compositionId: composition.id, mode: options.mode }}
        onSelectDetail={onSelectDetail}
      />
    </tbody></table>,
  );
  return { onToggleExpand, onSelectDetail };
}

describe('AdditiveCompositionRow detail selection', () => {
  it('fecha somente a Memória ao clicar novamente na composição', () => {
    const { onToggleExpand, onSelectDetail } = renderRow({ mode: 'memory', isOpen: false });
    const mainRow = screen.getAllByText('ADM04')[0].closest('tr');
    expect(mainRow).not.toBeNull();
    fireEvent.click(mainRow!);
    expect(onSelectDetail).toHaveBeenCalledWith(null);
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it('fecha somente a Analítica já aberta ao clicar novamente na composição', () => {
    const { onToggleExpand, onSelectDetail } = renderRow({ mode: 'analytic', isOpen: true });
    const mainRow = screen.getAllByText('ADM04')[0].closest('tr');
    fireEvent.click(mainRow!);
    expect(onToggleExpand).toHaveBeenCalledWith('comp-1');
    expect(onSelectDetail).toHaveBeenCalledWith(null);
  });
});
