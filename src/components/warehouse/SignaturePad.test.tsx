import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignaturePad from './SignaturePad';

const context = {
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  clearRect: vi.fn(),
  setTransform: vi.fn(),
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
  });

  it('desenha exatamente na posição do ponteiro mesmo com o canvas redimensionado', () => {
    const onChange = vi.fn();
    render(<SignaturePad label="Assinatura de teste" onChange={onChange} />);
    const canvas = screen.getByLabelText('Assinatura de teste');

    const pointerEvent = (type: string, clientX: number, clientY: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        clientX: { value: clientX },
        clientY: { value: clientY },
        pointerId: { value: 1 },
      });
      fireEvent(canvas, event);
    };
    pointerEvent('pointerdown', 150, 50);
    pointerEvent('pointermove', 180, 80);
    pointerEvent('pointerup', 180, 80);

    expect(context.moveTo).toHaveBeenCalledWith(50, 30);
    expect(context.lineTo).toHaveBeenCalledWith(80, 60);
    expect(onChange).toHaveBeenCalledWith('data:image/png;base64,assinatura');
  });
});
