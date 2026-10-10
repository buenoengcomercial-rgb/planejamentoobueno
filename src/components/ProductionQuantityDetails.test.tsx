import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProductionQuantityDetail } from '@/types/project';
import { makeQuantityClipboard } from '@/lib/productionQuantityReferences';
import ProductionQuantityDetails from './ProductionQuantityDetails';

describe('barra do detalhe de quantitativos', () => {
  it('usa a célula selecionada para a planta e diferencia colar de colar referência', () => {
    const row: ProductionQuantityDetail = { id: 'row-29', location: '', comment: 'Placas', formula: 'STANDARD', multiplier: 0, measuredQuantity: 29, dimensionC: 0, dimensionD: 0 };
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    const onOpenPlan = vi.fn();
    const props = { rows: [row], unit: 'UND', dailyQuantity: 29, applied: true, readOnly: false, canOpenPlan: true, onCreate: vi.fn(() => 'new'), onEdit: vi.fn(() => true), onDelete: vi.fn(), onOpenPlan, onApply: vi.fn(), onCopy, onPaste };
    const view = render(<ProductionQuantityDetails {...props} />);
    expect(screen.getByRole('button', { name: 'Planta DXF' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copiar' })).toBeDisabled();
    fireEvent.focus(screen.getByRole('spinbutton', { name: 'Medida da linha 1' }));
    expect(screen.getByRole('button', { name: 'Planta DXF' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Planta DXF' }));
    expect(onOpenPlan).toHaveBeenCalledWith('row-29', 'measuredQuantity');
    fireEvent.click(screen.getByRole('button', { name: 'Copiar' }));
    expect(onCopy).toHaveBeenCalledWith('copy', row);
    const address = { taskId: 'task-a', logId: 'day-a', rowId: row.id };
    view.rerender(<ProductionQuantityDetails {...props} clipboard={makeQuantityClipboard('project', 'copy', address, 'UND', row)} />);
    expect(screen.getByRole('button', { name: 'Colar' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Colar referência' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Colar' }));
    expect(onPaste).toHaveBeenCalledWith('row-29');
    fireEvent.click(screen.getByRole('button', { name: 'Copiar referência' }));
    expect(onCopy).toHaveBeenCalledWith('reference', row);
    view.rerender(<ProductionQuantityDetails {...props} clipboard={makeQuantityClipboard('project', 'reference', address, 'UND', row)} />);
    expect(screen.getByRole('button', { name: 'Colar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Colar referência' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Colar referência' }));
    expect(onPaste).toHaveBeenLastCalledWith('row-29');
  });

  it('mostra as tarefas de uma linha vinculada e bloqueia ações para consulta', () => {
    const row: ProductionQuantityDetail = { id: 'shared', sharedRecordId: 'record', location: '', comment: 'Placas', formula: 'STANDARD', multiplier: 0, measuredQuantity: 29 };
    render(<ProductionQuantityDetails rows={[row]} unit="UND" dailyQuantity={29} applied readOnly canOpenPlan onCreate={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onOpenPlan={vi.fn()} onApply={vi.fn()} sharedTaskNames={() => ['Instalação', 'Conferência']} />);
    expect(screen.getByRole('button', { name: 'Vinculado: Instalação, Conferência' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Vinculado: Instalação, Conferência' }));
    expect(screen.getByText('Tarefas: Instalação · Conferência')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Planta DXF' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Recortar' })).toBeDisabled();
  });
  it('permite teclado e planta em A-D sem arredondar o registro ao apenas sair do campo', () => {
    const source = { planId: 'plan', planName: 'Térreo.dxf', page: 1, measureId: 'length', measureName: 'Trecho', kind: 'length' as const, resultUnit: 'u.d.', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
    const row: ProductionQuantityDetail = { id: 'row', location: '', comment: '', formula: 'STANDARD', multiplier: 0, measuredQuantity: 0.9001542986, dimensionC: 0, dimensionD: 0, source };
    const onEdit = vi.fn(() => true), onOpenPlan = vi.fn();
    render(<ProductionQuantityDetails rows={[row]} unit="UND" dailyQuantity={0.9001542986} applied readOnly={false} canOpenPlan onCreate={vi.fn()} onEdit={onEdit} onDelete={vi.fn()} onOpenPlan={onOpenPlan} onApply={vi.fn()} />);
    const b = screen.getByRole('spinbutton', { name: 'Medida da linha 1' });
    expect(b).toHaveValue(0.9002);
    expect(screen.getByText('u.d.')).toBeInTheDocument();
    fireEvent.focus(b); fireEvent.blur(b);
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Levantar coluna/ })).not.toBeInTheDocument();
    fireEvent.focus(screen.getByLabelText('Altura da linha 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Planta DXF' }));
    expect(onOpenPlan).toHaveBeenCalledWith('row', 'dimensionD');
    const d = screen.getByRole('spinbutton', { name: 'Altura da linha 1' });
    fireEvent.change(d, { target: { value: '2' } }); fireEvent.blur(d);
    expect(onEdit).toHaveBeenCalledWith('row', expect.objectContaining({ dimensionD: 2 }));
  });
  it('oculta os controles de incremento e não altera valores com setas ou roda do mouse', () => {
    const row: ProductionQuantityDetail = { id: 'row', location: '', comment: '', formula: 'STANDARD', multiplier: 1, measuredQuantity: 2, dimensionC: 3, dimensionD: 4 };
    const onEdit = vi.fn(() => true);
    render(<ProductionQuantityDetails rows={[row]} unit="UND" dailyQuantity={24} applied readOnly={false} canOpenPlan onCreate={vi.fn()} onEdit={onEdit} onDelete={vi.fn()} onOpenPlan={vi.fn()} onApply={vi.fn()} />);
    for (const label of ['Unidades', 'Medida', 'Largura', 'Altura']) {
      const input = screen.getByRole('spinbutton', { name: `${label} da linha 1` });
      expect(input).toHaveClass('no-spinner');
      expect(input).toHaveAttribute('inputmode', 'decimal');
      fireEvent.focus(input);
      expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(false);
      expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(false);
      fireEvent.wheel(input, { deltaY: -100 });
      expect(input).not.toHaveFocus();
    }
    expect(onEdit).not.toHaveBeenCalled();
  });
});
