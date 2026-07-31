import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdditiveComposition } from '@/types/project';
import { requestMemoryFocus } from '@/lib/additiveMemoryFocus';
import AdditiveCalculationMemory from './AdditiveCalculationMemory';

const composition = (patch: Partial<AdditiveComposition> = {}): AdditiveComposition => ({
  id: 'comp-1',
  item: '1.1.1',
  itemNumber: '1.1.1',
  code: 'ADM04',
  bank: 'PRÓPRIO',
  description: 'Administração de Obra',
  quantity: 6,
  unit: 'MÊS',
  unitPriceNoBDI: 12595.53,
  unitPriceWithBDI: 16069.37,
  total: 96416.22,
  inputs: [],
  ...patch,
});

beforeAll(() => {
  // O navegador real fornece offsetParent; o jsdom não calcula layout.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return document.body; },
  });
});

describe('AdditiveCalculationMemory', () => {
  it('confirma o comentário no Enter, mantém um único rascunho e avança para Fórmula', async () => {
    const onChange = vi.fn();
    render(<AdditiveCalculationMemory c={composition()} isLocked={false} onChange={onChange} />);

    const comment = screen.getByPlaceholderText('Comentário da nova linha');
    await waitFor(() => expect(document.activeElement).toBe(comment));
    fireEvent.change(comment, { target: { value: 'Parede norte' } });
    fireEvent.keyDown(comment, { key: 'Enter' });

    await waitFor(() => expect(screen.getAllByPlaceholderText(/Justificativa|Comentário da nova linha/)).toHaveLength(2));
    const formula = screen.getAllByPlaceholderText('UND*Comprim.*Largura*Altura')[0];
    expect(document.activeElement).toBe(formula);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ comment: 'Parede norte', type: 'acrescida' }),
    ]);

    // O blur disparado depois do Enter não pode acrescentar outro rascunho.
    fireEvent.blur(comment, { relatedTarget: formula });
    await waitFor(() => expect(screen.getAllByPlaceholderText(/Justificativa|Comentário da nova linha/)).toHaveLength(2));
    expect(screen.getByText('Nova linha')).toBeInTheDocument();
  });

  it('confirma ao sair do comentário para outra célula e persiste somente a linha preenchida', async () => {
    const onChange = vi.fn();
    render(<AdditiveCalculationMemory c={composition()} isLocked={false} onChange={onChange} />);

    const comment = screen.getByPlaceholderText('Comentário da nova linha');
    const formula = screen.getByPlaceholderText('UND*Comprim.*Largura*Altura');
    fireEvent.change(comment, { target: { value: 'Trecho A' } });
    fireEvent.blur(comment, { relatedTarget: formula });

    await waitFor(() => expect(screen.getAllByPlaceholderText(/Justificativa|Comentário da nova linha/)).toHaveLength(2));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const persisted = onChange.mock.calls.at(-1)?.[0];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(expect.objectContaining({ comment: 'Trecho A' }));
  });

  it('herda o tipo solicitado e mantém Minimizar disponível quando a memória está bloqueada', async () => {
    requestMemoryFocus('comp-1', 'suprimida');
    const onClose = vi.fn();
    const { rerender } = render(
      <AdditiveCalculationMemory c={composition()} isLocked={false} onChange={vi.fn()} onClose={onClose} />,
    );

    await waitFor(() => expect(screen.getByDisplayValue('Suprimida')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Minimizar/i }));
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <AdditiveCalculationMemory
        c={composition({
          calculationMemory: [{ id: 'm1', type: 'suprimida', comment: 'Contrato', formula: '', a: 1, partial: 1 }],
        })}
        isLocked
        onChange={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.getByText('Memória bloqueada para edição')).toBeInTheDocument();
    expect(screen.queryByText('Nova linha')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Minimizar/i })).toBeEnabled();
  });
});
