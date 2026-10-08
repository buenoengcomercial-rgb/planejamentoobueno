import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DxfViewer } from 'dxf-viewer';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { measureCategory, type MeasureKind, type Point, type TakeoffPlan, type TakeoffMeasure } from '@/lib/planTakeoff';
import { dwfSheets, openDwfSheets, type DwfSheet } from '@/lib/dwfTakeoff';
import { CAPTURE_LABELS, extractDxfGeometry, snapDxf, type CaptureKind, type DxfGeometry, type SnapHit } from '@/lib/dxfSnap';

export type CanvasEditMode = 'select' | 'pan' | 'deleteMeasure' | 'addPoint' | 'deletePoint' | 'movePoint';
export type CanvasBackground = 'white' | 'gray' | 'black';

interface Props {
  plan: TakeoffPlan; page: number; draft: Point[]; draftKind?: MeasureKind | 'calibrate' | null; drawing: boolean; selected: string;
  readOnly: boolean; onPoint: (point: Point) => void; onSelect: (id: string) => void;
  onFinish?: () => void;
  onMove: (id: string, index: number, point: Point) => void; onPages: (count: number) => void;
  onCursor?: (point: Point | null) => void;
  onLayers?: (layers: string[], hidden: string[]) => void;
  onSheets?: (sheets: DwfSheet[]) => void;
  onCaptureAvailable?: (kinds: CaptureKind[]) => void;
  onReady?: (ready: boolean) => void;
  background?: CanvasBackground; ortho?: boolean; capturesEnabled?: boolean; trackingEnabled?: boolean;
  captureKinds?: CaptureKind[]; editMode?: CanvasEditMode; visible?: boolean;
  onDeleteMeasure?: (id: string) => void;
  onAddPoint?: (id: string, point: Point) => void;
  onDeletePoint?: (id: string, index: number) => void;
  executedMeasureIds?: string[];
}
export interface PlanCanvasHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  toggleLayer: (name: string, visible: boolean) => void;
}
type View = { x: number; y: number; width: number };
const PlanCanvas = forwardRef<PlanCanvasHandle, Props>(function PlanCanvas({ plan, page, draft, draftKind, drawing, selected, readOnly, onPoint, onSelect, onMove, onPages, onCursor, onLayers, onSheets, onCaptureAvailable, onReady, background = 'white', ortho = false, capturesEnabled = false, trackingEnabled = false, captureKinds = [], editMode = 'select', visible = true, onDeleteMeasure, onAddPoint, onDeletePoint, onFinish, executedMeasureIds = [] }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const cadHost = useRef<HTMLDivElement>(null);
  const cad = useRef<DxfViewer>();
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [view, setView] = useState<View>({ x: 0, y: 0, width: 1000 });
  const fit = useRef<View>(view);
  const [raster, setRaster] = useState<{ url: string; width: number; height: number }>();
  const [layers, setLayers] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [status, setStatus] = useState('Carregando planta…');
  const [geometry, setGeometry] = useState<DxfGeometry>();
  const [snapHit, setSnapHit] = useState<SnapHit | null>(null);
  const drag = useRef<{ start: Point; view: View; id?: string; index?: number; moved: boolean; panning: boolean; primary: boolean }>();
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
    setStatus('Carregando planta…'); onReady?.(false); setRaster(undefined); setLayers([]); setHidden([]); setGeometry(undefined); onSheets?.([]);
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
          viewer = new DxfViewer(cadHost.current, { autoResize: false, retainParsedDxf: true, canvasWidth: host.current?.clientWidth || 800, canvasHeight: host.current?.clientHeight || 500 });
          viewer.SetClearColor(backgroundRef.current === 'black' ? '#111827' : backgroundRef.current === 'gray' ? '#d1d5db' : '#ffffff');
          await viewer.Load({ url, fonts: [`${import.meta.env.BASE_URL}fonts/NotoSans-Regular.ttf`] });
          if (disposed) return;
          const b = viewer.GetBounds();
          if (!b || ![b.minX, b.maxX, b.minY, b.maxY].every(Number.isFinite)) throw new Error('DXF sem geometria 2D válida.');
          cad.current = viewer;
          setGeometry(extractDxfGeometry(viewer.GetDxf()));
          setLayers(Array.from(viewer.GetLayers(), l => l.name));
          frame(b.minX, -b.maxY, b.maxX - b.minX, b.maxY - b.minY); onPages(1);
        } else if (plan.kind === 'dwf') {
          const dwfDocument = await openDwfSheets(plan.file);
          if (disposed) return;
          const sheets = dwfSheets(dwfDocument);
          onPages(sheets.length);
          onSheets?.(sheets);
          const sheet = sheets[page - 1];
          if (!sheet) throw new Error('Folha DWF não encontrada.');
          if (!sheet.supported) throw new Error(sheet.reason);
          const canvas = document.createElement('canvas');
          const width = Math.min(3200, Math.max(1200, sheet.width));
          canvas.width = Math.round(width);
          canvas.height = Math.max(1, Math.round(width * sheet.height / sheet.width));
          const { PageRenderer } = await import('dwf-viewer');
          const renderer = new PageRenderer(dwfDocument);
          try {
            const stats = await renderer.render(page - 1, canvas, { preferWebgl: false, preferWasm: false, background: '#ffffff', lineWeightMode: 'adaptive' });
            if (stats.backend === 'unsupported' || stats.commands === 0) throw new Error('Esta folha DWF não produziu geometria visível.');
          } finally { renderer.dispose(); }
          if (disposed) return;
          setRaster({ url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height });
          frame(0, 0, canvas.width, canvas.height);
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
        if (!disposed) { setStatus(''); onReady?.(true); }
      } catch (error) { if (!disposed) { onReady?.(false); setStatus(`Não foi possível abrir esta planta: ${error instanceof Error ? error.message : 'verifique o arquivo e o formato'}`); } }
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
  }, [plan.id, plan.file, plan.kind, page, onPages, onSheets, onReady]);

  useEffect(() => { onCaptureAvailable?.(geometry?.available ?? []); }, [geometry, onCaptureAvailable]);
  useEffect(() => { cad.current?.SetClearColor(background === 'black' ? '#111827' : background === 'gray' ? '#d1d5db' : '#ffffff'); cad.current?.Render(); }, [background]);

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
  const resolvedPoint = (raw: Point, previous?: Point): Point => {
    if (capturesEnabled && geometry && captureKinds.length) {
      const hit = snapDxf(raw, geometry, new Set(captureKinds), unit * 12, new Set(hidden), previous, trackingEnabled);
      if (hit) { setSnapHit(hit); return hit.point; }
    }
    setSnapHit(null);
    if (ortho && previous) return Math.abs(raw.x - previous.x) >= Math.abs(raw.y - previous.y)
      ? { x: raw.x, y: previous.y } : { x: previous.x, y: raw.y };
    return raw;
  };
  const shape = (measure: TakeoffMeasure) => {
    const points = measure.points.map((p, i) => moving?.id === measure.id && moving.index === i ? moving.point : p);
    const color = executedMeasureIds.includes(measure.id) ? '#15803d' : selected === measure.id ? '#d97706' : '#0369a1';
    const circle = measure.kind === 'circlePerimeter' || measure.kind === 'circleArea';
    const rectangle = measure.kind === 'rectangleArea';
    const polygon = measure.kind === 'area' || measure.kind === 'polygonVolume';
    const area = measureCategory(measure.kind) === 'area' || measureCategory(measure.kind) === 'volume';
    return <g key={measure.id} onPointerDown={e => { if (!drawing && e.button === 0) { e.stopPropagation(); if (editMode === 'deleteMeasure' && !readOnly) onDeleteMeasure?.(measure.id); else onSelect(measure.id); } }}>
      {circle && points.length >= 2 && <circle cx={points[0].x} cy={points[0].y} r={Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)} stroke={color} strokeWidth={unit * 3} fill={area ? '#0284c714' : 'none'} style={{ cursor: 'pointer', pointerEvents: 'stroke' }} />}
      {rectangle && points.length >= 2 && <rect x={Math.min(points[0].x, points[1].x)} y={Math.min(points[0].y, points[1].y)} width={Math.abs(points[1].x - points[0].x)} height={Math.abs(points[1].y - points[0].y)} stroke={color} strokeWidth={unit * 3} fill="#0284c714" style={{ cursor: 'pointer', pointerEvents: 'stroke' }} />}
      {measure.kind !== 'count' && !circle && !rectangle && <polyline points={[...points, ...(polygon ? [points[0]] : [])].map(p => `${p.x},${p.y}`).join(' ')} stroke={color} strokeWidth={unit * 3} fill={polygon ? '#0284c714' : 'none'} style={{ cursor: 'pointer', pointerEvents: 'stroke' }} />}
      {points.map((p, i) => <g key={i}>
        <circle cx={p.x} cy={p.y} r={unit * 5} fill={color} stroke="white" strokeWidth={unit} style={{ cursor: !readOnly && selected === measure.id ? 'move' : 'pointer' }} onPointerDown={e => {
          if (drawing || e.button !== 0) return; e.stopPropagation();
          if (editMode === 'deleteMeasure' && !readOnly) { onDeleteMeasure?.(measure.id); return; }
          if (editMode === 'deletePoint' && !readOnly) { onDeletePoint?.(measure.id, i); return; }
          onSelect(measure.id);
          if (!readOnly && selected === measure.id && editMode === 'movePoint') { e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId); drag.current = { start: p, view, id: measure.id, index: i, moved: false, panning: false, primary: true }; }
        }} />
        {measure.kind === 'count' && <text x={p.x + unit * 8} y={p.y - unit * 7} fontSize={unit * 12} fontWeight="600" fill={color} stroke="white" strokeWidth={unit * 2.5} paintOrder="stroke" style={{ pointerEvents: 'none' }}>{i + 1}</text>}
      </g>)}
    </g>;
  };
  return <div className="min-w-0">
    <div ref={host} className="relative h-[58vh] min-h-[360px] overflow-hidden border border-slate-300 sm:h-[min(69vh,760px)]" style={{ touchAction: 'none', background: background === 'black' ? '#111827' : background === 'gray' ? '#d1d5db' : '#ffffff' }}>
      <div ref={cadHost} className="absolute inset-0" style={{ pointerEvents: 'none', visibility: visible ? 'visible' : 'hidden' }} />
      <svg aria-label="Planta e marcações" className="absolute inset-0 h-full w-full" viewBox={`${view.x - view.width / 2} ${view.y - height / 2} ${view.width} ${height}`} onWheel={e => setView(v => ({ ...v, width: Math.max(.00001, v.width * (e.deltaY > 0 ? 1.12 : 1 / 1.12)) }))}
        onMouseDown={e => { if (e.button === 1) e.preventDefault(); }} onAuxClick={e => { if (e.button === 1) e.preventDefault(); }}
        onContextMenu={e => { if (drawing && draftKind !== 'calibrate') { e.preventDefault(); onFinish?.(); } }}
        onPointerDown={e => { if (status || e.button !== 0 && e.button !== 1) return; if (e.button === 1) e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { start: point(e), view, moved: false, panning: e.button === 1 || !drawing && editMode !== 'addPoint', primary: e.button === 0 }; }}
        onPointerMove={e => {
          const raw = point(e);
          onCursor?.(drawing ? resolvedPoint(raw, draft.at(-1)) : raw);
          const d = drag.current; if (!d) return;
          const p = point(e);
          if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > unit * 3) d.moved = true;
          if (d.id !== undefined && d.index !== undefined) setMoving({ id: d.id, index: d.index, point: resolvedPoint(p) });
          else if (d.panning) setView({ ...view, x: view.x + d.start.x - p.x, y: view.y + d.start.y - p.y });
        }} onPointerLeave={() => onCursor?.(null)} onPointerUp={e => {
          const d = drag.current; drag.current = undefined;
          if (d?.id !== undefined && d.index !== undefined && d.moved) onMove(d.id, d.index, resolvedPoint(point(e)));
          else if (d?.primary && !d.moved && drawing) onPoint(resolvedPoint(point(e), draft.at(-1)));
          else if (d?.primary && !d.moved && editMode === 'addPoint' && selected && !readOnly) onAddPoint?.(selected, resolvedPoint(point(e)));
          setMoving(undefined);
        }} onPointerCancel={() => { drag.current = undefined; setMoving(undefined); }}>
        {visible && raster && <image href={raster.url} width={raster.width} height={raster.height} style={background === 'white' ? undefined : background === 'gray' ? { mixBlendMode: 'multiply' } : { filter: 'invert(1)', mixBlendMode: 'screen' }} />}
        {visible && plan.measures.filter(m => m.page === page).map(shape)}
        {draftKind !== 'count' && draft.length > 1 && (draftKind === 'circlePerimeter' || draftKind === 'circleArea' ?
          <circle data-draft-line cx={draft[0].x} cy={draft[0].y} r={Math.hypot(draft[1].x - draft[0].x, draft[1].y - draft[0].y)} fill={draftKind === 'circleArea' ? '#e11d4814' : 'none'} stroke="#e11d48" strokeWidth={unit * 2} pointerEvents="none" /> : draftKind === 'rectangleArea' ?
            <rect data-draft-line x={Math.min(draft[0].x, draft[1].x)} y={Math.min(draft[0].y, draft[1].y)} width={Math.abs(draft[1].x - draft[0].x)} height={Math.abs(draft[1].y - draft[0].y)} fill="#e11d4814" stroke="#e11d48" strokeWidth={unit * 2} pointerEvents="none" /> :
            <polyline data-draft-line points={draft.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#e11d48" strokeWidth={unit * 2} pointerEvents="none" />)}
        {draft.map((p, i) => <g key={i} pointerEvents="none"><circle data-draft-point cx={p.x} cy={p.y} r={unit * 4} fill="#e11d48" />{draftKind === 'count' && <text x={p.x + unit * 8} y={p.y - unit * 7} fontSize={unit * 12} fontWeight="600" fill="#e11d48" stroke="white" strokeWidth={unit * 2.5} paintOrder="stroke">{i + 1}</text>}</g>)}
        {snapHit && capturesEnabled && drawing && <g pointerEvents="none"><circle cx={snapHit.point.x} cy={snapHit.point.y} r={unit * 8} stroke="#e11d48" strokeWidth={unit * 1.5} fill="none" /><text x={snapHit.point.x + unit * 10} y={snapHit.point.y - unit * 8} fontSize={unit * 11} fill="#be123c" stroke="white" strokeWidth={unit * 2} paintOrder="stroke">{CAPTURE_LABELS[snapHit.kind]}</text></g>}
      </svg>
      {status && <div role="status" className="absolute inset-0 flex items-center justify-center bg-white/90 p-5 text-center text-slate-800">{status}</div>}
    </div>
  </div>;
});
export default PlanCanvas;
