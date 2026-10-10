import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import type { DxfViewer } from 'dxf-viewer';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { measureCategory, measureUnit, quantity, type MeasureKind, type Point, type TakeoffPlan, type TakeoffMeasure } from '@/lib/planTakeoff';
import { dwfSheets, openDwfSheets, type DwfSheet } from '@/lib/dwfTakeoff';
import { CAPTURE_LABELS, extractDxfGeometry, snapDxf, trackAlignment, type CaptureKind, type DxfGeometry, type SnapHit, type TrackingHit } from '@/lib/dxfSnap';

export type CanvasEditMode = 'select' | 'pan' | 'zoomWindow' | 'deleteMeasure' | 'addPoint' | 'deletePoint' | 'movePoint';
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
  showMeasureValues?: boolean; showHatching?: boolean;
  onViewHistory?: (available: boolean) => void;
}
export interface PlanCanvasHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  previousView: () => void;
  toggleLayer: (name: string, visible: boolean) => void;
}
type View = { x: number; y: number; width: number };
const PlanCanvas = forwardRef<PlanCanvasHandle, Props>(function PlanCanvas({ plan, page, draft, draftKind, drawing, selected, readOnly, onPoint, onSelect, onMove, onPages, onCursor, onLayers, onSheets, onCaptureAvailable, onReady, background = 'white', ortho = false, capturesEnabled = false, trackingEnabled = false, captureKinds = [], editMode = 'select', visible = true, onDeleteMeasure, onAddPoint, onDeletePoint, onFinish, executedMeasureIds = [], showMeasureValues = true, showHatching = true, onViewHistory }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const cadHost = useRef<HTMLDivElement>(null);
  const cad = useRef<DxfViewer>();
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [view, setView] = useState<View>({ x: 0, y: 0, width: 1000 });
  const viewHistory = useRef<View[]>([]);
  const currentView = useRef(view); currentView.current = view;
  const [windowCorner, setWindowCorner] = useState<Point>();
  const [pointerPosition, setPointerPosition] = useState<Point>();
  const hatchId = useId().replace(/:/g, '');
  const rememberView = () => {
    const previous = viewHistory.current.at(-1), next = currentView.current;
    if (!previous || previous.x !== next.x || previous.y !== next.y || previous.width !== next.width) {
      viewHistory.current = [...viewHistory.current.slice(-49), next];
    }
    onViewHistory?.(viewHistory.current.length > 0);
  };
  const changeView = (next: View) => {
    const previous = currentView.current;
    if (previous.x === next.x && previous.y === next.y && previous.width === next.width) return;
    rememberView(); setView(next);
  };
  const middleClick = useRef<number>();
  const fit = useRef<View>(view);
  const [raster, setRaster] = useState<{ url: string; width: number; height: number }>();
  const [layers, setLayers] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [status, setStatus] = useState('Carregando planta…');
  const [geometry, setGeometry] = useState<DxfGeometry>();
  const [snapHit, setSnapHit] = useState<SnapHit | null>(null);
  const [trackingHit, setTrackingHit] = useState<TrackingHit | null>(null);
  const acquiredPoint = useRef<Point>();
  const drag = useRef<{ start: Point; view: View; id?: string; index?: number; moved: boolean; panning: boolean; primary: boolean }>();
  const [moving, setMoving] = useState<{ id: string; index: number; point: Point }>();
  const height = view.width * size.height / size.width;
  const unit = view.width / size.width;

  useImperativeHandle(ref, () => ({
    zoomIn: () => changeView({ ...view, width: view.width / 2 }),
    zoomOut: () => changeView({ ...view, width: view.width * 2 }),
    fit: () => changeView(fit.current),
    previousView: () => { const previous = viewHistory.current.pop(); if (previous) setView(previous); onViewHistory?.(viewHistory.current.length > 0); },
    toggleLayer: (name, visible) => {
      cad.current?.ShowLayer(name, visible);
      cad.current?.Render();
      setHidden(previous => visible ? previous.filter(item => item !== name) : [...previous, name]);
    },
  }));

  useEffect(() => { setMoving(undefined); setWindowCorner(undefined); drag.current = undefined; }, [editMode, selected, drawing, plan.id, page, readOnly]);
  const captureKey = captureKinds.join('|'), hiddenKey = hidden.join('|');
  useEffect(() => { acquiredPoint.current = undefined; setSnapHit(null); setTrackingHit(null); }, [plan.id, page, drawing, draftKind, draft.length, capturesEnabled, trackingEnabled, captureKey, hiddenKey]);

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
    let modelUrl: string | undefined;
    let cancelModel: (() => void) | undefined;
    setStatus('Carregando planta…'); onReady?.(false); setRaster(undefined); setLayers([]); setHidden([]); setGeometry(undefined); onSheets?.([]);
    viewHistory.current = []; onViewHistory?.(false);
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
          const model = await new Promise<Blob>((resolve, reject) => {
            const worker = new Worker(new URL('./dxfModel.worker.ts', import.meta.url), { type: 'module' });
            const fail = (message: string) => { worker.terminate(); reject(new Error(message)); };
            cancelModel = () => fail('Carregamento cancelado.');
            worker.onerror = () => fail('Não foi possível preparar o Model do DXF.');
            worker.onmessage = (event: MessageEvent<{ file?: Blob; error?: string }>) => {
              worker.terminate(); cancelModel = undefined;
              if (event.data.file) resolve(event.data.file);
              else reject(new Error(event.data.error || 'DXF sem Model válido.'));
            };
            worker.postMessage(plan.file);
          });
          if (disposed) return;
          modelUrl = URL.createObjectURL(model);
          viewer = new DxfViewer(cadHost.current, { autoResize: false, retainParsedDxf: true, sceneOptions: { suppressPaperSpace: true }, canvasWidth: host.current?.clientWidth || 800, canvasHeight: host.current?.clientHeight || 500 });
          viewer.SetClearColor(backgroundRef.current === 'black' ? '#111827' : backgroundRef.current === 'gray' ? '#d1d5db' : '#ffffff');
          await viewer.Load({ url: modelUrl, fonts: [`${import.meta.env.BASE_URL}fonts/NotoSans-Regular.ttf`], workerFactory: () => new Worker(new URL('./dxfRender.worker.ts', import.meta.url), { type: 'module' }) });
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
      disposed = true; cad.current = undefined; destroyPdf?.(); cancelModel?.();
      // Load may still be pending: defer destruction until it has settled.
      void loading.finally(() => {
        if (viewer) { try { viewer.Destroy(); } catch { /* renderer already released */ } }
        URL.revokeObjectURL(url);
        if (modelUrl) URL.revokeObjectURL(modelUrl);
      });
      container?.replaceChildren();
    };
  }, [plan.id, plan.file, plan.kind, page, onPages, onSheets, onReady, onViewHistory]);

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
    setTrackingHit(null);
    if (capturesEnabled && geometry && captureKinds.length) {
      const hit = snapDxf(raw, geometry, new Set(captureKinds), unit * 12, new Set(hidden), previous, trackingEnabled);
      if (hit) {
        if (trackingEnabled && ['point', 'endpoint', 'insertion', 'center', 'midpoint', 'intersection', 'quadrant'].includes(hit.kind)) acquiredPoint.current = hit.point;
        setSnapHit(hit); return hit.point;
      }
    }
    setSnapHit(null);
    const origin = acquiredPoint.current ?? previous;
    if (capturesEnabled && trackingEnabled && geometry && origin) {
      const tracked = trackAlignment(raw, origin, unit * 8);
      if (tracked) { setTrackingHit(tracked); return tracked.point; }
    }
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
    const fill = area && showHatching ? `url(#${hatchId}-${measure.id})` : 'none';
    const scale = plan.scales[measure.page] ?? null;
    const result = quantity(measure.kind, points, scale, measure.heightMeters);
    const label = (p: Point, value: number, suffix: string, key: string) => <text key={key} data-measure-value x={p.x} y={p.y - unit * 8} fontSize={unit * 12} textAnchor="middle" fill={color} stroke={background === 'black' ? '#111827' : background === 'gray' ? '#d1d5db' : 'white'} strokeWidth={unit * 3} paintOrder="stroke" pointerEvents="none">{value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {suffix}</text>;
    const center = rectangle && points.length === 2 ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
      : circle ? points[0] : area ? { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length } : points.at(-1)!;
    return <g key={measure.id} onPointerDown={e => { if (!drawing && e.button === 0) { e.stopPropagation(); if (editMode === 'deleteMeasure' && !readOnly) onDeleteMeasure?.(measure.id); else onSelect(measure.id); } }}>
      {area && <defs><pattern id={`${hatchId}-${measure.id}`} width={unit * 8} height={unit * 8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2={unit * 8} stroke={color} strokeWidth={unit} opacity=".35" /></pattern></defs>}
      {circle && points.length >= 2 && <circle cx={points[0].x} cy={points[0].y} r={Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)} stroke={color} strokeWidth={unit * 2} fill={fill} style={{ cursor: 'pointer', pointerEvents: 'stroke' }} />}
      {rectangle && points.length >= 2 && <rect x={Math.min(points[0].x, points[1].x)} y={Math.min(points[0].y, points[1].y)} width={Math.abs(points[1].x - points[0].x)} height={Math.abs(points[1].y - points[0].y)} stroke={color} strokeWidth={unit * 2} fill={fill} style={{ cursor: 'pointer', pointerEvents: 'stroke' }} />}
      {measure.kind !== 'count' && !circle && !rectangle && <polyline points={[...points, ...(polygon && points.length ? [points[0]] : [])].map(p => `${p.x},${p.y}`).join(' ')} stroke={color} strokeWidth={unit * 2} fill={polygon ? fill : 'none'} style={{ cursor: 'pointer', pointerEvents: 'stroke' }} />}
      {showMeasureValues && measure.kind !== 'count' && result !== null && center && <>
        {(measure.kind === 'length' || polygon) && points.map((a, i) => { const b = points[(i + 1) % points.length]; if (!polygon && i === points.length - 1) return null; return label({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.hypot(b.x - a.x, b.y - a.y) * (scale ?? 1), scale === null ? 'u.d.' : 'm', `segment-${i}`); })}
        {label(center, result, measureUnit(measure.kind, scale), 'total')}
      </>}
      {points.map((p, i) => <g key={i}>
        <circle data-measure-point={`${measure.id}:${i}`} cx={p.x} cy={p.y} r={unit * 4} fill={color} stroke="white" strokeWidth={unit} style={{ cursor: !readOnly && selected === measure.id ? 'move' : 'pointer' }} onPointerDown={e => {
          if (drawing || e.button !== 0) return; e.stopPropagation();
          if (editMode === 'deleteMeasure' && !readOnly) { onDeleteMeasure?.(measure.id); return; }
          if (editMode === 'deletePoint' && !readOnly) { onDeletePoint?.(measure.id, i); return; }
          onSelect(measure.id);
          if (!readOnly && selected === measure.id && editMode === 'movePoint') { e.currentTarget.ownerSVGElement?.focus({ preventScroll: true }); e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId); setMoving({ id: measure.id, index: i, point: p }); drag.current = { start: p, view, id: measure.id, index: i, moved: false, panning: false, primary: true }; }
        }} />
        {measure.kind === 'count' && <text x={p.x + unit * 8} y={p.y - unit * 7} fontSize={unit * 12} fontWeight="600" fill={color} stroke="white" strokeWidth={unit * 2.5} paintOrder="stroke" style={{ pointerEvents: 'none' }}>{i + 1}</text>}
      </g>)}
    </g>;
  };
  return <div className="min-w-0">
    <div ref={host} className="relative h-[58vh] min-h-[360px] overflow-hidden border border-slate-300 sm:h-[min(69vh,760px)]" style={{ touchAction: 'none', background: background === 'black' ? '#111827' : background === 'gray' ? '#d1d5db' : '#ffffff' }}>
      <div ref={cadHost} className="absolute inset-0" style={{ pointerEvents: 'none', visibility: visible ? 'visible' : 'hidden' }} />
      <svg aria-label="Planta e marcações" tabIndex={0} className="absolute inset-0 h-full w-full outline-none" viewBox={`${view.x - view.width / 2} ${view.y - height / 2} ${view.width} ${height}`} onWheel={e => changeView({ ...view, width: Math.max(.00001, view.width * (e.deltaY > 0 ? 1.12 : 1 / 1.12)) })}
        onKeyDown={e => { if (e.key === 'Escape') { setMoving(undefined); setWindowCorner(undefined); drag.current = undefined; } }}
        onMouseDown={e => { if (e.button === 1) e.preventDefault(); }} onAuxClick={e => { if (e.button === 1) e.preventDefault(); }}
        onContextMenu={e => { if (drawing && draftKind !== 'calibrate') { e.preventDefault(); onFinish?.(); } }}
        onPointerDown={e => { if (status || e.button !== 0 && e.button !== 1) return; if (e.button === 1) e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); const panning = e.button === 1 || !drawing && !moving && (editMode === 'pan' || editMode === 'select'); drag.current = { start: point(e), view, moved: false, panning, primary: e.button === 0 }; }}
        onPointerMove={e => {
          const raw = point(e);
          if (windowCorner) setPointerPosition(raw);
          if (moving && !drag.current && editMode === 'movePoint') setMoving({ ...moving, point: resolvedPoint(raw) });
          const cursor = drawing ? resolvedPoint(raw, draft.at(-1)) : raw;
          onCursor?.(cursor);
          const d = drag.current; if (!d) return;
          const p = point(e);
          if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) > unit * 3) { if (d.panning) rememberView(); d.moved = true; }
          if (d.id !== undefined && d.index !== undefined) setMoving({ id: d.id, index: d.index, point: resolvedPoint(p) });
          else if (d.panning) setView({ ...view, x: view.x + d.start.x - p.x, y: view.y + d.start.y - p.y });
        }} onPointerLeave={() => { onCursor?.(null); setSnapHit(null); setTrackingHit(null); }} onPointerUp={e => {
          const d = drag.current; drag.current = undefined;
          if (e.button === 1 && d && !d.moved) {
            const now = performance.now();
            if (middleClick.current !== undefined && now - middleClick.current < 400) { changeView(fit.current); middleClick.current = undefined; }
            else middleClick.current = now;
          } else if (d?.moved) middleClick.current = undefined;
          if (d?.id !== undefined && d.index !== undefined && d.moved) onMove(d.id, d.index, resolvedPoint(point(e)));
          else if (d?.primary && !d.moved && editMode === 'zoomWindow' && !drawing) {
            const p = point(e);
            if (!windowCorner) { setWindowCorner(p); setPointerPosition(p); }
            else { const width = Math.max(Math.abs(p.x - windowCorner.x), Math.abs(p.y - windowCorner.y) * size.width / size.height); if (width > unit * 3) changeView({ x: (p.x + windowCorner.x) / 2, y: (p.y + windowCorner.y) / 2, width }); setWindowCorner(undefined); }
          }
          else if (d?.primary && !d.moved && moving && editMode === 'movePoint' && d.id === undefined && !readOnly) { onMove(moving.id, moving.index, resolvedPoint(point(e))); setMoving(undefined); }
          else if (d?.primary && !d.moved && drawing) onPoint(resolvedPoint(point(e), draft.at(-1)));
          else if (d?.primary && !d.moved && editMode === 'addPoint' && selected && !readOnly) onAddPoint?.(selected, resolvedPoint(point(e)));
          if (d?.moved) setMoving(undefined);
        }} onPointerCancel={() => { drag.current = undefined; setMoving(undefined); }}>
        {visible && raster && <image href={raster.url} width={raster.width} height={raster.height} style={background === 'white' ? undefined : background === 'gray' ? { mixBlendMode: 'multiply' } : { filter: 'invert(1)', mixBlendMode: 'screen' }} />}
        {visible && plan.measures.filter(m => m.page === page).map(shape)}
        {windowCorner && pointerPosition && <rect x={Math.min(windowCorner.x, pointerPosition.x)} y={Math.min(windowCorner.y, pointerPosition.y)} width={Math.abs(pointerPosition.x - windowCorner.x)} height={Math.abs(pointerPosition.y - windowCorner.y)} fill="#0284c714" stroke="#0284c7" strokeWidth={unit} strokeDasharray={`${unit * 4} ${unit * 3}`} pointerEvents="none" />}
        {draftKind !== 'count' && draft.length > 1 && (draftKind === 'circlePerimeter' || draftKind === 'circleArea' ?
          <circle data-draft-line cx={draft[0].x} cy={draft[0].y} r={Math.hypot(draft[1].x - draft[0].x, draft[1].y - draft[0].y)} fill={draftKind === 'circleArea' ? '#e11d4814' : 'none'} stroke="#e11d48" strokeWidth={unit * 2} pointerEvents="none" /> : draftKind === 'rectangleArea' ?
            <rect data-draft-line x={Math.min(draft[0].x, draft[1].x)} y={Math.min(draft[0].y, draft[1].y)} width={Math.abs(draft[1].x - draft[0].x)} height={Math.abs(draft[1].y - draft[0].y)} fill="#e11d4814" stroke="#e11d48" strokeWidth={unit * 2} pointerEvents="none" /> :
            <polyline data-draft-line points={draft.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#e11d48" strokeWidth={unit * 2} pointerEvents="none" />)}
        {draft.map((p, i) => <g key={i} pointerEvents="none"><circle data-draft-point cx={p.x} cy={p.y} r={unit * 4} fill="#e11d48" />{draftKind === 'count' && <text x={p.x + unit * 8} y={p.y - unit * 7} fontSize={unit * 12} fontWeight="600" fill="#e11d48" stroke="white" strokeWidth={unit * 2.5} paintOrder="stroke">{i + 1}</text>}</g>)}
        {snapHit && capturesEnabled && drawing && <g data-capture-kind={snapHit.kind} pointerEvents="none">{snapHit.guide && <line data-capture-guide x1={snapHit.guide.from.x} y1={snapHit.guide.from.y} x2={snapHit.guide.to.x} y2={snapHit.guide.to.y} stroke="#e11d48" strokeWidth={unit} strokeDasharray={`${unit * 5} ${unit * 3}`} />}<circle cx={snapHit.point.x} cy={snapHit.point.y} r={unit * 8} stroke="#e11d48" strokeWidth={unit * 1.5} fill="none" /><text x={snapHit.point.x + unit * 10} y={snapHit.point.y - unit * 8} fontSize={unit * 11} fill="#be123c" stroke="white" strokeWidth={unit * 2} paintOrder="stroke">{CAPTURE_LABELS[snapHit.kind]}</text></g>}
        {trackingHit && capturesEnabled && trackingEnabled && drawing && <g data-tracking-guide pointerEvents="none"><line x1={trackingHit.from.x} y1={trackingHit.from.y} x2={trackingHit.point.x} y2={trackingHit.point.y} stroke="#0284c7" strokeWidth={unit} strokeDasharray={`${unit * 5} ${unit * 3}`} /><circle cx={trackingHit.point.x} cy={trackingHit.point.y} r={unit * 5} stroke="#0284c7" strokeWidth={unit} fill="none" /><text x={trackingHit.point.x + unit * 10} y={trackingHit.point.y - unit * 8} fontSize={unit * 11} fill="#0369a1" stroke="white" strokeWidth={unit * 2} paintOrder="stroke">Rastreamento {trackingHit.axes.length > 1 ? 'horizontal/vertical' : trackingHit.axes[0] === 'x' ? 'vertical' : 'horizontal'}</text></g>}
      </svg>
      {status && <div role="status" className="absolute inset-0 flex items-center justify-center bg-white/90 p-5 text-center text-slate-800">{status}</div>}
    </div>
  </div>;
});
export default PlanCanvas;
