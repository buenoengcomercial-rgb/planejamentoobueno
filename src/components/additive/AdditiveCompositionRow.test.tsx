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

function renderRow(options: { mode: 'memory' | 'analytic'; isOpen: boolean; composition?: AdditiveComposition; isLocked?: boolean }) {
  const onToggleExpand = vi.fn();
  const onSelectDetail = vi.fn();
  const onReorderComposition = vi.fn();
  const current = options.composition ?? composition;
  render(
    <table><tbody>
      <AdditiveCompositionRow
        project={project}
        c={current}
        bdi={27.58}
        globalDiscount={0}
        isLocked={options.isLocked ?? false}
        isOpen={options.isOpen}
        isMemoryOpen={options.mode === 'memory'}
        showAnalytic
        onToggleExpand={onToggleExpand}
        onUpdateComposition={vi.fn()}
        onReorderComposition={onReorderComposition}
        onUpdateQuantity={vi.fn()}
        onRemoveComposition={vi.fn()}
        onChangeMemory={vi.fn()}
        selectedDetail={{ compositionId: current.id, mode: options.mode }}
        onSelectDetail={onSelectDetail}
      />
    </tbody></table>,
  );
  return { onToggleExpand, onSelectDetail, onReorderComposition };
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

  it('permite editar o Item somente no novo serviço desbloqueado', () => {
    const newComposition = { ...composition, isNewService: true };
    const { onReorderComposition } = renderRow({ mode: 'analytic', isOpen: false, composition: newComposition });
    const item = screen.getByPlaceholderText('Item');
    fireEvent.focus(item);
    fireEvent.change(item, { target: { value: '1' } });
    fireEvent.blur(item);
    expect(onReorderComposition).toHaveBeenCalledWith('comp-1', '1');
  });

  it('mantém o Item somente leitura quando o aditivo está bloqueado', () => {
    renderRow({ mode: 'analytic', isOpen: false, composition: { ...composition, isNewService: true }, isLocked: true });
    expect(screen.queryByPlaceholderText('Item')).not.toBeInTheDocument();
    expect(screen.getByText('1.1.1')).toBeInTheDocument();
  });

  it('colore a identificação em azul para acréscimo e centraliza as colunas numéricas', () => {
    renderRow({ mode: 'analytic', isOpen: false, composition: { ...composition, addedQuantity: 2 } });
    const row = screen.getAllByText('ADM04')[0].closest('tr')!;
    const cells = Array.from(row.querySelectorAll(':scope > td'));
    cells.slice(1, 6).forEach(cell => expect(cell).toHaveClass('text-blue-700'));
    cells.slice(6).forEach(cell => expect(cell).toHaveClass('text-center'));
  });

  it('colore a identificação em vermelho para supressão e deixa dado misto neutro', () => {
    const { unmount } = render(
      <table><tbody>
        <AdditiveCompositionRow
          project={project} c={{ ...composition, suppressedQuantity: 2 }} bdi={27.58} globalDiscount={0}
          isLocked isOpen={false} isMemoryOpen={false} showAnalytic={false}
          onToggleExpand={vi.fn()} onUpdateComposition={vi.fn()} onReorderComposition={vi.fn()}
          onUpdateQuantity={vi.fn()} onRemoveComposition={vi.fn()} onChangeMemory={vi.fn()}
        />
      </tbody></table>,
    );
    let row = screen.getAllByText('ADM04')[0].closest('tr')!;
    Array.from(row.querySelectorAll(':scope > td')).slice(1, 6)
      .forEach(cell => expect(cell).toHaveClass('text-rose-700'));
    unmount();

    renderRow({ mode: 'analytic', isOpen: false, composition: { ...composition, addedQuantity: 2, suppressedQuantity: 1 } });
    row = screen.getAllByText('ADM04')[0].closest('tr')!;
    Array.from(row.querySelectorAll(':scope > td')).slice(1, 6).forEach(cell => {
      expect(cell).not.toHaveClass('text-blue-700');
      expect(cell).not.toHaveClass('text-rose-700');
    });
  });
});
