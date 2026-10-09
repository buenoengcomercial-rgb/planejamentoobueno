import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlanCanvas, { type PlanCanvasHandle } from './PlanCanvas';
import type { TakeoffPlan } from '@/lib/planTakeoff';

const plan: TakeoffPlan = { id: 'plan-1', name: 'Planta.png', floor: 'Térreo', kind: 'image', file: new Blob(['image']), scales: {}, measures: [] };
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
vi.mock('dxf-viewer', () => ({ DxfViewer: class {
  async Load() {} Destroy() {} Render() {} SetClearColor() {} SetSize() {} SetView() {} ShowLayer() {}
  GetBounds() { return { minX: 0, maxX: 10, minY: 0, maxY: 10 }; }
  GetOrigin() { return { x: 0, y: 0 }; }
  GetCamera() { return { position: { clone: () => ({ set: () => ({}) }) } }; }
  GetLayers() { return [{ name: 'PAREDES' }]; }
  GetDxf() { return { entities: [{ type: 'LINE', layer: 'PAREDES', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }] }; }
} }));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 1000; naturalHeight = 600; decode = async () => {}; });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:planta') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  Object.defineProperty(SVGElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
});

afterEach(async () => {
  cleanup();
  await act(async () => {});
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL });
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL });
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('gestos no desenho', () => {
  it('mostra captura perpendicular e envia a coordenada ajustada no clique, independentemente do rastreamento', async () => {
    const onPoint = vi.fn();
    render(<PlanCanvas plan={{ ...plan, kind: 'dxf' }} page={1} draft={[{ x: 3, y: -4 }]} draftKind="length" drawing selected="" readOnly={false} onPoint={onPoint} onSelect={vi.fn()} onMove={vi.fn()} onPages={vi.fn()} capturesEnabled captureKinds={['perpendicular']} />);
    await waitFor(() => expect(screen.queryByText('Carregando planta…')).not.toBeInTheDocument());
    const svg = screen.getByLabelText('Planta e marcações');
    const [x, y, w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const clientX = (3.1 - x) / w * 800, clientY = (-.1 - y) / h * 500;
    fireEvent(svg, new MouseEvent('pointermove', { bubbles: true, clientX, clientY }));
    expect(svg.querySelector('[data-capture-kind="perpendicular"]')).not.toBeNull();
    fireEvent(svg, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX, clientY }));
    fireEvent(svg, new MouseEvent('pointerup', { bubbles: true, button: 0, clientX, clientY }));
    expect(onPoint).toHaveBeenCalledWith({ x: 3, y: 0 });
    expect(svg.querySelector('[data-capture-guide]')).toBeNull();
  });

  it('mantém o ponto adquirido após renderização e desenha a guia de rastreamento até o clique', async () => {
    const onPoint = vi.fn();
    const props = { plan: { ...plan, kind: 'dxf' as const }, page: 1, draft: [], draftKind: 'length' as const, drawing: true, selected: '', readOnly: false, onPoint, onSelect: vi.fn(), onMove: vi.fn(), onPages: vi.fn(), capturesEnabled: true, trackingEnabled: true };
    const { rerender } = render(<PlanCanvas {...props} captureKinds={['endpoint']} />);
    await waitFor(() => expect(screen.queryByText('Carregando planta…')).not.toBeInTheDocument());
    const svg = screen.getByLabelText('Planta e marcações');
    const [x, y, w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const pointer = (type: string, px: number, py: number) => fireEvent(svg, new MouseEvent(type, { bubbles: true, button: 0, clientX: (px - x) / w * 800, clientY: (py - y) / h * 500 }));
    pointer('pointermove', .1, -.1);
    expect(svg.querySelector('[data-capture-kind="endpoint"]')).not.toBeNull();
    rerender(<PlanCanvas {...props} captureKinds={['endpoint']} />);
    pointer('pointermove', .1, -4);
    expect(screen.getByText('Rastreamento vertical')).toBeInTheDocument();
    expect(svg.querySelector('[data-tracking-guide]')).not.toBeNull();
    pointer('pointerdown', .1, -4); pointer('pointerup', .1, -4);
    // Browser pointer coordinates round to screen pixels; only the captured axis is exact.
    expect(onPoint).toHaveBeenCalledWith({ x: 0, y: expect.closeTo(-4, 1) });
  });
  it('move por dois cliques sem deslocar a vista e cancela a seleção com Escape', async () => {
    const onMove = vi.fn();
    render(<PlanCanvas plan={{ ...plan, measures: [{ id: 'm', name: 'Percurso', kind: 'length', page: 1, points: [{ x: 0, y: 0 }, { x: 3, y: 4 }] }] }} page={1} draft={[]} drawing={false} selected="m" editMode="movePoint" readOnly={false} onPoint={vi.fn()} onSelect={vi.fn()} onMove={onMove} onPages={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('Carregando planta…')).not.toBeInTheDocument());
    const svg = screen.getByLabelText('Planta e marcações');
    const vertex = svg.querySelector('[data-measure-point="m:0"]')!;
    const pointer = (target: Element, type: string, x: number, y: number) => fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    const before = svg.getAttribute('viewBox');
    pointer(vertex, 'pointerdown', 100, 100); pointer(svg, 'pointerup', 100, 100);
    expect(onMove).not.toHaveBeenCalled();
    pointer(svg, 'pointermove', 150, 150);
    pointer(svg, 'pointerdown', 150, 150); pointer(svg, 'pointerup', 150, 150);
    expect(onMove).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledWith('m', 0, expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
    expect(svg.getAttribute('viewBox')).toBe(before);
    pointer(vertex, 'pointerdown', 100, 100); pointer(svg, 'pointerup', 100, 100);
    fireEvent.keyDown(svg, { key: 'Escape' });
    pointer(svg, 'pointerdown', 200, 200); pointer(svg, 'pointerup', 200, 200);
    expect(onMove).toHaveBeenCalledOnce();
  });
  it('mostra total e segmentos, mantém tamanho no zoom e oculta só os valores', async () => {
    const data = { ...plan, scales: { 1: 1 }, measures: [{ id: 'm', name: 'Percurso', kind: 'length' as const, page: 1, points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }] }] };
    const props = { plan: data, page: 1, draft: [], drawing: false, selected: '', readOnly: false, onPoint: vi.fn(), onSelect: vi.fn(), onMove: vi.fn(), onPages: vi.fn() };
    const { rerender } = render(<PlanCanvas {...props} />);
    await waitFor(() => expect(screen.queryByText('Carregando planta…')).not.toBeInTheDocument());
    const svg = screen.getByLabelText('Planta e marcações');
    expect(screen.getByText('7 m')).toBeInTheDocument();
    expect(screen.getByText('3 m')).toBeInTheDocument();
    expect(screen.getByText('4 m')).toBeInTheDocument();
    const width = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
    const font = Number(screen.getByText('7 m').getAttribute('font-size'));
    fireEvent.wheel(svg, { deltaY: -100 });
    expect(Number(screen.getByText('7 m').getAttribute('font-size')) / Number(svg.getAttribute('viewBox')!.split(' ')[2])).toBeCloseTo(font / width);
    rerender(<PlanCanvas {...props} showMeasureValues={false} />);
    expect(screen.queryByText('7 m')).not.toBeInTheDocument();
    expect(svg.querySelector('polyline')).not.toBeNull();
  });
  it('enquadra por dois cantos e retorna à vista anterior sem alterar pontos', async () => {
    const ref = createRef<PlanCanvasHandle>();
    const onPoint = vi.fn();
    render(<PlanCanvas ref={ref} plan={plan} page={1} draft={[]} drawing={false} selected="" editMode="zoomWindow" readOnly={false} onPoint={onPoint} onSelect={vi.fn()} onMove={vi.fn()} onPages={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('Carregando planta…')).not.toBeInTheDocument());
    const svg = screen.getByLabelText('Planta e marcações');
    const before = svg.getAttribute('viewBox');
    for (const [x, y] of [[100, 100], [300, 250]]) {
      fireEvent(svg, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }));
      fireEvent(svg, new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: x, clientY: y }));
    }
    expect(svg.getAttribute('viewBox')).not.toBe(before);
    expect(onPoint).not.toHaveBeenCalled();
    act(() => ref.current!.previousView());
    await waitFor(() => expect(svg.getAttribute('viewBox')).toBe(before));
  });
  it('enquadra no duplo clique central sem lançar pontos', async () => {
    const onPoint = vi.fn();
    render(<PlanCanvas plan={plan} page={1} draft={[]} draftKind="count" drawing selected="" readOnly={false} onPoint={onPoint} onSelect={vi.fn()} onMove={vi.fn()} onPages={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('Carregando planta…')).not.toBeInTheDocument());
    const svg = screen.getByLabelText('Planta e marcações');
    const fitted = svg.getAttribute('viewBox');
    fireEvent.wheel(svg, { deltaY: -100 });
    expect(svg.getAttribute('viewBox')).not.toBe(fitted);
    for (let i = 0; i < 2; i++) {
      fireEvent(svg, new MouseEvent('pointerdown', { bubbles: true, button: 1, clientX: 100, clientY: 100 }));
      fireEvent(svg, new MouseEvent('pointerup', { bubbles: true, button: 1, clientX: 100, clientY: 100 }));
    }
    expect(svg.getAttribute('viewBox')).toBe(fitted);
    expect(onPoint).not.toHaveBeenCalled();
  });
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
