import { useState, type MouseEvent } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdditiveComposition, Project } from '@/types/project';
import AdditiveCompositionRow from './AdditiveCompositionRow';
import type { AdditiveDetailSelection } from './AdditiveDetailFooter';
import { shouldDismissAdditiveDetail } from './additiveDetailInteraction';

const composition: AdditiveComposition = {
  id: 'comp-1', item: '1.1.1', itemNumber: '1.1.1', code: 'ADM04', bank: 'PRÓPRIO',
  description: 'Administração de Obra', quantity: 6, originalQuantity: 6, unit: 'MÊS',
  unitPriceNoBDI: 12595.53, unitPriceWithBDI: 16069.37, total: 96416.22,
  inputs: [{ id: 'i1', code: 'MO1', bank: 'PRÓPRIO', description: 'Engenheiro', unit: 'H', coefficient: 1, unitPrice: 1, total: 1 }],
};

const project = { analyticCompositions: [], budgetItems: [] } as unknown as Project;

function renderRow(options: { mode?: 'memory' | 'analytic'; isOpen: boolean; composition?: AdditiveComposition; isLocked?: boolean; globalDiscount?: number }) {
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
        globalDiscount={options.globalDiscount ?? 0}
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
        selectedDetail={options.mode ? { compositionId: current.id, mode: options.mode } : null}
        onSelectDetail={onSelectDetail}
      />
    </tbody></table>,
  );
  return { onToggleExpand, onSelectDetail, onReorderComposition };
}

function DetailInteractionHarness() {
  const [selectedDetail, setSelectedDetail] = useState<AdditiveDetailSelection | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (shouldDismissAdditiveDetail(event.target)) setSelectedDetail(null);
  };

  return (
    <div onClickCapture={handleClickCapture}>
      <button type="button">Fora da composição</button>
      <table><tbody>
        <AdditiveCompositionRow
          project={project}
          c={composition}
          bdi={27.58}
          globalDiscount={0}
          isLocked={false}
          isOpen={isOpen}
          isMemoryOpen={selectedDetail?.compositionId === composition.id && selectedDetail.mode === 'memory'}
          showAnalytic
          onToggleExpand={() => setIsOpen(value => !value)}
          onUpdateComposition={vi.fn()}
          onReorderComposition={vi.fn()}
          onUpdateQuantity={vi.fn()}
          onRemoveComposition={vi.fn()}
          onChangeMemory={vi.fn()}
          selectedDetail={selectedDetail}
          onSelectDetail={setSelectedDetail}
        />
      </tbody></table>
    </div>
  );
}

describe('AdditiveCompositionRow detail selection', () => {
  it('mostra referência s/ BDI e valor final oficial no novo serviço', () => {
    renderRow({
      isOpen: false,
      globalDiscount: 6,
      composition: {
        ...composition,
        isNewService: true,
        quantity: 0,
        originalQuantity: 0,
        addedQuantity: 12,
        total: 0,
        totalWithBDI: 0,
        analyticReferenceUnitPriceNoBDI: 2775.03,
        inputs: [{
          id: 'abhi', code: 'ABHI', bank: 'PRÓPRIO', description: 'Composição ABHI_3',
          unit: 'UN', coefficient: 1, unitPrice: 2775.03, total: 2775.03,
        }],
      },
    });

    expect(screen.getByText('R$ 2.775,03')).toBeInTheDocument();
    expect(screen.getByText('R$ 3.327,95')).toBeInTheDocument();
    expect(screen.getAllByText('R$ 39.935,40').length).toBeGreaterThan(0);
    expect(screen.queryByText('R$ 2.608,52')).not.toBeInTheDocument();
  });

  it('mostra a FIXA_2 truncada em R$ 31,37 e total de R$ 33.032,61', () => {
    renderRow({
      isOpen: false,
      globalDiscount: 6,
      composition: {
        ...composition,
        code: 'FIXA_2',
        isNewService: true,
        quantity: 0,
        originalQuantity: 0,
        addedQuantity: 1053,
        total: 0,
        totalWithBDI: 0,
        analyticReferenceUnitPriceNoBDI: 26.19,
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
      },
    });

    expect(screen.getByText('R$ 26,17')).toBeInTheDocument();
    expect(screen.getByText('R$ 31,37')).toBeInTheDocument();
    expect(screen.getAllByText('R$ 33.032,61').length).toBeGreaterThan(0);
  });

  it('fecha a Memória pelo clique na composição sem o capture global abrir a Analítica', () => {
    const { container } = render(<DetailInteractionHarness />);
    const addedQuantity = container.querySelector<HTMLInputElement>('input.border-emerald-200');
    expect(addedQuantity).not.toBeNull();

    fireEvent.click(addedQuantity!);
    expect(screen.getByText('Memória de cálculo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('cell', { name: /^ADM04$/ }));
    expect(screen.queryByText('Memória de cálculo')).not.toBeInTheDocument();
    expect(screen.queryByText('Engenheiro')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('cell', { name: /^ADM04$/ }));
    expect(screen.getByText('Engenheiro')).toBeInTheDocument();
  });

  it('continua fechando a Memória quando o clique ocorre fora da composição', () => {
    const { container } = render(<DetailInteractionHarness />);
    const addedQuantity = container.querySelector<HTMLInputElement>('input.border-emerald-200');
    fireEvent.click(addedQuantity!);
    expect(screen.getByText('Memória de cálculo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fora da composição' }));
    expect(screen.queryByText('Memória de cálculo')).not.toBeInTheDocument();
  });

  it('fecha somente a Memória ao clicar novamente na composição', () => {
    const { onToggleExpand, onSelectDetail } = renderRow({ mode: 'memory', isOpen: false });
    const mainRow = screen.getAllByText('ADM04')[0].closest('tr');
    expect(mainRow).not.toBeNull();
    fireEvent.click(mainRow!);
    expect(onSelectDetail).toHaveBeenCalledWith(null);
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it('fecha somente a Memória ao clicar na seta sem abrir a Analítica', () => {
    const { onToggleExpand, onSelectDetail } = renderRow({ mode: 'memory', isOpen: false });
    fireEvent.click(screen.getByRole('button', { name: 'Recolher memória' }));
    expect(onSelectDetail).toHaveBeenCalledWith(null);
    expect(onSelectDetail).toHaveBeenCalledTimes(1);
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it('fecha somente a Analítica já aberta ao clicar novamente na composição', () => {
    const { onToggleExpand, onSelectDetail } = renderRow({ mode: 'analytic', isOpen: true });
    const mainRow = screen.getAllByText('ADM04')[0].closest('tr');
    fireEvent.click(mainRow!);
    expect(onToggleExpand).toHaveBeenCalledWith('comp-1');
    expect(onSelectDetail).toHaveBeenCalledWith(null);
  });

  it('fecha a Analítica pela seta', () => {
    const opened = renderRow({ mode: 'analytic', isOpen: true });
    fireEvent.click(screen.getByRole('button', { name: 'Recolher analítica' }));
    expect(opened.onToggleExpand).toHaveBeenCalledWith('comp-1');
    expect(opened.onSelectDetail).toHaveBeenCalledWith(null);
  });

  it('abre a Analítica pela seta quando não há detalhe ativo', () => {
    const { onToggleExpand, onSelectDetail } = renderRow({ isOpen: false });
    fireEvent.click(screen.getByRole('button', { name: 'Expandir analítica' }));
    expect(onSelectDetail).toHaveBeenCalledWith({ compositionId: 'comp-1', mode: 'analytic', qtyType: undefined });
    expect(onToggleExpand).toHaveBeenCalledWith('comp-1');
  });

  it('abre a Analítica ao clicar na composição quando não há detalhe ativo', () => {
    const { onToggleExpand, onSelectDetail } = renderRow({ isOpen: false });
    const mainRow = screen.getAllByText('ADM04')[0].closest('tr');
    fireEvent.click(mainRow!);
    expect(onSelectDetail).toHaveBeenCalledWith({ compositionId: 'comp-1', mode: 'analytic', qtyType: undefined });
    expect(onToggleExpand).toHaveBeenCalledWith('comp-1');
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
