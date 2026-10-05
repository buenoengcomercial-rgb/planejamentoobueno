import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlanCanvas from './PlanCanvas';
import type { TakeoffPlan } from '@/lib/planTakeoff';

const plan: TakeoffPlan = { id: 'plan-1', name: 'Planta.png', floor: 'Térreo', kind: 'image', file: new Blob(['image']), scales: {}, measures: [] };
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 1000; naturalHeight = 600; decode = async () => {}; });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:planta') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  Object.defineProperty(SVGElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL });
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL });
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('gestos no desenho', () => {
  it('mostra pontos sem linha na contagem, desloca com botão central e conclui com direito', async () => {
    const onPoint = vi.fn();
    const onFinish = vi.fn();
    const { unmount } = render(<PlanCanvas plan={plan} page={1} draft={[{ x: 10, y: 20 }, { x: 30, y: 40 }]} draftKind="count" drawing selected="" readOnly={false} onPoint={onPoint} onSelect={vi.fn()} onMove={vi.fn()} onPages={vi.fn()} onFinish={onFinish} />);
    await waitFor(() => expect(screen.queryByText('Carregando planta…')).not.toBeInTheDocument());
    const drawing = screen.getByLabelText('Planta e marcações');
    expect(drawing.querySelector('[data-draft-line]')).toBeNull();
    expect(drawing.querySelectorAll('[data-draft-point]')).toHaveLength(2);

    const pointer = (type: string, button: number, x: number, y: number, pointerId: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: x, clientY: y });
      Object.defineProperty(event, 'pointerId', { value: pointerId });
      fireEvent(drawing, event);
    };
    const before = drawing.getAttribute('viewBox');
    pointer('pointerdown', 1, 100, 100, 1);
    pointer('pointermove', 1, 180, 100, 1);
    pointer('pointerup', 1, 180, 100, 1);
    expect(drawing.getAttribute('viewBox')).not.toBe(before);
    expect(onPoint).not.toHaveBeenCalled();

    pointer('pointerdown', 2, 180, 100, 2);
    pointer('pointerup', 2, 180, 100, 2);
    fireEvent.contextMenu(drawing);
    expect(onPoint).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
    unmount();
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:planta'));
  });
});
