import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommitOnBlurInput, CommitOnBlurTextarea } from './CommitOnBlurField';

describe('CommitOnBlurField', () => {
  it('mantém todas as teclas localmente e confirma apenas uma vez no blur', () => {
    const onCommit = vi.fn();
    render(<CommitOnBlurInput value="" onCommit={onCommit} aria-label="Responsável" />);

    const input = screen.getByLabelText('Responsável');
    fireEvent.change(input, { target: { value: 'E' } });
    fireEvent.change(input, { target: { value: 'En' } });
    fireEvent.change(input, { target: { value: 'Eng. Kelper Bueno' } });

    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue('Eng. Kelper Bueno');

    fireEvent.blur(input);
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Eng. Kelper Bueno');
  });

  it('confirma edição pendente ao desmontar o campo', () => {
    const onCommit = vi.fn();
    const { unmount } = render(<CommitOnBlurTextarea value="" onCommit={onCommit} aria-label="Legenda" />);

    fireEvent.change(screen.getByLabelText('Legenda'), { target: { value: 'Foto da concretagem' } });
    expect(onCommit).not.toHaveBeenCalled();

    unmount();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Foto da concretagem');
  });
});
