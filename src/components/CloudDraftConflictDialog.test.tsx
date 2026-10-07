import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CloudDraftConflictDialog from './CloudDraftConflictDialog';

describe('cópia local pendente', () => {
  it('permite continuar no Diário sem descartar a cópia e exige solicitar backup antes do descarte', () => {
    const onDownload = vi.fn(() => true);
    const onDiscard = vi.fn(async () => undefined);
    const onContinueDailyReport = vi.fn();
    render(<CloudDraftConflictDialog open resolving={false} onDownload={onDownload} onDiscard={onDiscard} onContinueDailyReport={onContinueDailyReport} />);

    const discard = screen.getByRole('button', { name: 'Descartar cópia e usar nuvem' });
    expect(discard).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar no Diário' }));
    expect(onContinueDailyReport).toHaveBeenCalledOnce();
    expect(onDiscard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Baixar cópia local' }));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(discard).toBeEnabled();
  });
});
