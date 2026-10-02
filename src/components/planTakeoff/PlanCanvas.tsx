import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DxfViewer } from 'dxf-viewer';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Point, TakeoffPlan, TakeoffMeasure } from '@/lib/planTakeoff';

interface Props {
  plan: TakeoffPlan; page: number; draft: Point[]; drawing: boolean; selected: string;
  readOnly: boolean; onPoint: (point: Point) => void; onSelect: (id: string) => void;
  onMove: (id: string, index: number, point: Point) => void; onPages: (count: number) => void;
  onCursor?: (point: Point | null) => void;
  onLayers?: (layers: string[], hidden: string[]) => void;
  executedMeasureIds?: string[];
}
export interface PlanCanvasHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  toggleLayer: (name: string, visible: boolean) => void;
}
type View = { x: number; y: number; width: number };
const PlanCanvas = forwardRef<PlanCanvasHandle, Props>(function PlanCanvas({ plan, page, draft, drawing, selected, readOnly, onPoint, onSelect, onMove, onPages, onCursor, onLayers, executedMeasureIds = [] }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const cadHost = useRef<HTMLDivElement>(null);
  const cad = useRef<DxfViewer>();
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [view, setView] = useState<View>({ x: 0, y: 0, width: 1000 });
  const fit = useRef<View>(view);
  const [raster, setRaster] = useState<{ url: string; width: number; height: number }>();
  const [layers, setLayers] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [status, setStatus] = useState('Carregando planta…');
  const drag = useRef<{ start: Point; view: View; id?: string; index?: number; moved: boolean }>();
  const [moving, setMoving] = useState<{ id: string; index: number; point: Point }>();
  const height = view.width * size.height / size.width;
  const unit = view.width / size.width;

  useImperativeHandle(ref, () => ({
    zoomIn: () => setView(v => ({ ...v, width: v.width / 1.3 })),
    zoomOut: () => setView(v => ({ ...v, width: v.width * 1.3 })),
    fit: () => setView(fit.current),
    toggleLayer: (name, visible) => {
      cad.current?.ShowLayer(name, visible);
      cad.current?.Render();
      setHidden(previous => visible ? previous.filter(item => item !== name) : [...previous, name]);
    },
  }), []);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let viewer: DxfViewer | undefined;
    const container = cadHost.current;
    let destroyPdf: (() => void) | undefined;
    const url = URL.createObjectURL(plan.file);
    setStatus('Carregando planta…'); setRaster(undefined); setLayers([]); setHidden([]);
    const frame = (minX: number, minY: number, width: number, h: number) => {
      const aspect = (host.current?.clientWidth || 800) / (host.current?.clientHeight || 500);
      const next = { x: minX + width / 2, y: minY + h / 2, width: Math.max(width, h * aspect, .001) * 1.1 };
      fit.current = next; setView(next);
    };
    async function load() {
      try {
        if (plan.kind === 'dxf') {
          const { DxfViewer } = await import('dxf-viewer');
          if (disposed || !cadHost.current) return;
          viewer = new DxfViewer(cadHost.current, { autoResize: false, canvasWidth: host.current?.clientWidth || 800, canvasHeight: host.current?.clientHeight || 500 });
          viewer.SetClearColor('#ffffff');
          await viewer.Load({ url, fonts: [`${import.meta.env.BASE_URL}fonts/NotoSans-Regular.ttf`] });
          if (disposed) return;
          const b = viewer.GetBounds();
          if (!b || ![b.minX, b.maxX, b.minY, b.maxY].every(Number.isFinite)) throw new Error('DXF sem geometria 2D válida.');
          cad.current = viewer;
          setLayers(Array.from(viewer.GetLayers(), l => l.name));
          frame(b.minX, -b.maxY, b.maxX - b.minX, b.maxY - b.minY); onPages(1);
        } else if (plan.kind === 'pdf') {
          const pdfjs = await import('pdfjs-dist');
          pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
          const task = pdfjs.getDocument({ data: await plan.file.arrayBuffer() });
          destroyPdf = () => { void task.destroy(); };
          const pdf = await task.promise;
          if (disposed) return;
          const sheet = await pdf.getPage(page);
          const viewport = sheet.getViewport({ scale: 1 });
          const renderScale = Math.min(2, 3000 / Math.max(viewport.width, viewport.height));
          const canvas = document.createElement('canvas');
          const rendered = sheet.getViewport({ scale: renderScale });
          canvas.width = rendered.width; canvas.height = rendered.height;
          await sheet.render({ canvas, viewport: rendered }).promise;
          if (disposed) return;
          setRaster({ url: canvas.toDataURL(), width: viewport.width, height: viewport.height });
          frame(0, 0, viewport.width, viewport.height); onPages(pdf.numPages);
        } else {
          const img = new Image(); img.src = url; await img.decode();
          if (disposed) return;
          setRaster({ url, width: img.naturalWidth, height: img.naturalHeight });
          frame(0, 0, img.naturalWidth, img.naturalHeight); onPages(1);
        }
        if (!disposed) setStatus('');
      } catch (error) { if (!disposed) setStatus(`Não foi possível abrir esta planta: ${error instanceof Error ? error.message : 'verifique o arquivo e o formato'}`); }
    }
    const loading = load();
    return () => {
      disposed = true; cad.current = undefined; destroyPdf?.();
      // Load may still be pending: defer destruction until it has settled.
      void loading.finally(() => {
        if (viewer) { try { viewer.Destroy(); } catch { /* renderer already released */ } }
        URL.revokeObjectURL(url);
      });
      container?.replaceChildren();
    };
  }, [plan.id, plan.file, plan.kind, page, onPages]);

  useEffect(() => {
    const viewer = cad.current;
    if (!viewer || status) return;
    viewer.SetSize(size.width, size.height);
    const origin = viewer.GetOrigin();
    viewer.SetView(viewer.GetCamera().position.clone().set(view.x - origin.x, -view.y - origin.y, 1), view.width);
    viewer.Render();
  }, [view, size, status]);

  useEffect(() => { onLayers?.(layers, hidden); }, [layers, hidden, onLayers]);

  const point = (event: React.PointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: view.x - view.width / 2 + (event.clientX - rect.left) / rect.width * view.width,
      y: view.y - height / 2 + (event.clientY - rect.top) / rect.height * height };
  };
  const shape = (measure: TakeoffMeasure) => {
    const points = measure.points.map((p, i) => moving?.id === measure.id && moving.index === i ? moving.point : p);
    const color = executedMeasureIds.includes(measure.id) ? '#15803d' : selected === measure.id ? '#d97706' : '#0369a1';
    return <g key={measure.id} onPointerDown={e => { if (!drawing) { e.stopPropagation(); onSelect(measure.id); } }}>
      {measure.kind !== 'count' && <polyline points={[...points, ...(measure.kind === 'area' ? [points[0]] : [])].map(p => `${p.x},${p.y}`).join(' ')} stroke={color} strokeWidth={unit * 3} fill={measure.kind === 'area' ? '#0284c714' : 'none'} style={{ cursor: 'pointer', pointerEvents: 'stroke' }} />}
      {points.map((p, i) => <g key={i}>
        <circle cx={p.x} cy={p.y} r={unit * 5} fill={color} stroke="white" strokeWidth={unit} style={{ cursor: !readOnly && selected === measure.id ? 'move' : 'pointer' }} onPointerDown={e => {
          if (drawing) return; e.stopPropagation(); onSelect(measure.id);
          if (!readOnly && selected === measure.id) { e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId); drag.current = { start: p, view, id: measure.id, index: i, moved: false }; }
        }} />
        {measure.kind === 'count' && <text x={p.x + unit * 8} y={p.y - unit * 7} fontSize={unit * 12} fontWeight="600" fill={color} stroke="white" strokeWidth={unit * 2.5} paintOrder="stroke" style={{ pointerEvents: 'none' }}>{i + 1}</text>}
      </g>)}
    </g>;
  };
  return <div className="min-w-0">
    <div ref={host} className="relative h-[58vh] min-h-[360px] overflow-hidden border border-slate-300 bg-white sm:h-[min(69vh,760px)]" style={{ touchAction: 'none' }}>
      <div ref={cadHost} className="absolute inset-0" style={{ pointerEvents: 'none' }} />
      <svg aria-label="Planta e marcações" className="absolute inset-0 h-full w-full" viewBox={`${view.x - view.width / 2} ${view.y - height / 2} ${view.width} ${height}`} onWheel={e => setView(v => ({ ...v, width: Math.max(.00001, v.width * (e.deltaY > 0 ? 1.12 : 1 / 1.12)) }))}
        onPointerDown={e => { if (status) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { start: point(e), view, moved: false }; }}
        onPointerMove={e => {
          onCursor?.(point(e));
          const d = drag.current; if (!d) return;
          const p = point(e);
          if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > unit * 3) d.moved = true;
          if (d.id !== undefined && d.index !== undefined) setMoving({ id: d.id, index: d.index, point: p });
          else if (!drawing) setView({ ...view, x: view.x + d.start.x - p.x, y: view.y + d.start.y - p.y });
        }} onPointerLeave={() => onCursor?.(null)} onPointerUp={e => {
          const d = drag.current; drag.current = undefined;
          if (d?.id !== undefined && d.index !== undefined && d.moved) onMove(d.id, d.index, point(e));
          else if (d && !d.moved && drawing) onPoint(point(e));
          setMoving(undefined);
        }} onPointerCancel={() => { drag.current = undefined; setMoving(undefined); }}>
        {raster && <image href={raster.url} width={raster.width} height={raster.height} />}
        {plan.measures.filter(m => m.page === page).map(shape)}
        <polyline points={draft.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#e11d48" strokeWidth={unit * 2} pointerEvents="none" />
        {draft.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={unit * 4} fill="#e11d48" pointerEvents="none" />)}
      </svg>
      {status && <div role="status" className="absolute inset-0 flex items-center justify-center bg-white/90 p-5 text-center text-slate-800">{status}</div>}
    </div>
  </div>;
});
export default PlanCanvas;
