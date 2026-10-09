import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PlanCaptureDialog from './PlanCaptureDialog';

describe('capturas geométricas', () => {
  it('só habilita geometria reconhecida e desmarcar todas preserva a ativação', () => {
    const accept = vi.fn();
    render(<PlanCaptureDialog available={['endpoint', 'midpoint']} enabled tracking={false} kinds={['endpoint']} onClose={vi.fn()} onAccept={accept} />);
    expect(screen.getByRole('checkbox', { name: 'Extremo' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Centro' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Desmarcar todas' }));
    expect(screen.getByRole('checkbox', { name: 'Ativar capturas' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ponto médio' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(accept).toHaveBeenCalledWith(true, false, ['midpoint']);
  });
  it('cancelar não altera as preferências confirmadas', () => {
    const accept = vi.fn(), close = vi.fn();
    render(<PlanCaptureDialog available={['endpoint']} enabled tracking kinds={['endpoint']} onClose={close} onAccept={accept} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desmarcar todas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(close).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
  });
});
