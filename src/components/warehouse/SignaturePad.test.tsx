import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignaturePad from './SignaturePad';

const context = {
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  clearRect: vi.fn(),
  setTransform: vi.fn(),
  drawImage: vi.fn(),
  lineWidth: 0,
  lineCap: '',
  lineJoin: '',
  strokeStyle: '',
};

describe('SignaturePad', () => {
  beforeEach(() => {
    Object.values(context).forEach(value => { if (typeof value === 'function' && 'mockClear' in value) value.mockClear(); });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,assinatura');
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 20, left: 100, top: 20, right: 300, bottom: 140, width: 200, height: 120, toJSON: () => ({}),
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  });

  it('abre o editor, desenha na posição do ponteiro e confirma apenas ao usar a assinatura', async () => {
    const onChange = vi.fn();
    render(<SignaturePad label="Assinatura de teste" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Focar assinatura' }));
    const canvas = await screen.findByLabelText('Assinatura de teste — editor');

    await waitFor(() => expect(canvas).toHaveFocus());
    const pointerEvent = (type: string, clientX: number, clientY: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        clientX: { value: clientX }, clientY: { value: clientY }, pointerId: { value: 1 },
      });
      fireEvent(canvas, event);
    };
    pointerEvent('pointerdown', 150, 50);
    pointerEvent('pointermove', 180, 80);
    pointerEvent('pointerup', 180, 80);

    expect(context.moveTo).toHaveBeenCalledWith(50, 30);
    expect(context.lineTo).toHaveBeenCalledWith(80, 60);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Usar assinatura' }));
    expect(onChange).toHaveBeenCalledWith('data:image/png;base64,assinatura');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('mantém uma única prévia sem canvas sobreposto e cancelar preserva a assinatura atual', async () => {
    const onChange = vi.fn();
    render(<SignaturePad label="Assinatura de teste" value="data:image/png;base64,anterior" onChange={onChange} />);

    expect(screen.getAllByRole('img', { name: 'Assinatura registrada' })).toHaveLength(1);
    expect(screen.queryByLabelText('Assinatura de teste — editor')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Focar assinatura' }));
    const canvas = await screen.findByLabelText('Assinatura de teste — editor');
    expect(canvas).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole('img', { name: 'Assinatura registrada' })).toHaveLength(1);
  });

  it('limpa a assinatura confirmada pelo botão principal', () => {
    const onChange = vi.fn();
    render(<SignaturePad value="data:image/png;base64,anterior" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
