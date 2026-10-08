import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Box, Check, ChevronDown, ChevronUp, Circle, CircleDot, Crosshair, FileUp, Layers3, List, Magnet, Maximize2, MousePointer2, Move, Palette, Plus, Route, Ruler, Settings2, Shapes, Square, Trash2, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { calibration, fixedPointCount, measureCategory, measureUnit, MEASURE_KINDS, minimumPoints, measuresForContext, quantity, readTakeoffs, requiresHeight, saveTakeoffs, TAKEOFF_CATALOG_UPDATED, type MeasureKind, type Point, type TakeoffContext, type TakeoffMeasure, type TakeoffPlan } from '@/lib/planTakeoff';
import { openDwfSheets, type DwfSheet } from '@/lib/dwfTakeoff';
import { CAPTURE_KINDS, CAPTURE_LABELS, type CaptureKind } from '@/lib/dxfSnap';
import PlanDrawingManager from './PlanDrawingManager';
import PlanCanvas, { type CanvasBackground, type CanvasEditMode, type PlanCanvasHandle } from './PlanCanvas';

const labels: Record<MeasureKind, string> = { count: 'Contagem', linearLength: 'Comprimento linear', length: 'Comprimento poligonal', circlePerimeter: 'Perímetro circular', rectangleArea: 'Superfície retangular', area: 'Superfície poligonal', circleArea: 'Superfície circular', verticalArea: 'Superfície vertical', polygonVolume: 'Volume de planta poligonal' };
const toolIcons = { count: CircleDot, linearLength: Ruler, length: Route, circlePerimeter: Circle, rectangleArea: Square, area: Shapes, circleArea: CircleDot, verticalArea: Maximize2, polygonVolume: Box };
const format = (value: number | null) => value === null ? '—' : value.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
export default function PlanTakeoff({ storageKey, readOnly, onUseMeasure, onUpdateMeasure, onDeleteMeasure, onRestoreMeasure, onRecalibrate, executedMeasureIds = [], linkedMeasureIds = [], focusMeasure, embedded = false, allowedKinds = MEASURE_KINDS, destinationColumn, chapterId, measureContext }: { storageKey: string; readOnly: boolean; onUseMeasure?: (plan: TakeoffPlan, measure: TakeoffMeasure, result: number) => boolean | void; onUpdateMeasure?: (plan: TakeoffPlan, measure: TakeoffMeasure, result: number) => boolean | void; onDeleteMeasure?: (plan: TakeoffPlan, measure: TakeoffMeasure) => boolean | void; onRestoreMeasure?: (plan: TakeoffPlan, measure: TakeoffMeasure) => boolean | void; onRecalibrate?: (plan: TakeoffPlan, page: number, scale: number | null) => boolean | void; executedMeasureIds?: string[]; linkedMeasureIds?: string[]; focusMeasure?: { planId: string; page: number; measureId: string }; embedded?: boolean; allowedKinds?: MeasureKind[]; destinationColumn?: string; chapterId?: string; measureContext?: TakeoffContext }) {
  const [plans, setPlans] = useState<TakeoffPlan[]>([]);
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('Carregando plantas da nuvem…');
  const [error, setError] = useState('');
  const [tool, setTool] = useState<MeasureKind | 'calibrate' | null>(null);
  const [draft, setDraft] = useState<Point[]>([]);
  const [selected, setSelected] = useState('');
  const [distance, setDistance] = useState('');
  const [cadUnit, setCadUnit] = useState('1');
  const [pendingScale, setPendingScale] = useState<number>();
  const [draftName, setDraftName] = useState('');
  const [heightMeters, setHeightMeters] = useState('3');
  const [cursor, setCursor] = useState<Point | null>(null);
  const [canvasLayers, setCanvasLayers] = useState<string[]>([]);
  const [hiddenLayers, setHiddenLayers] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [background, setBackground] = useState<CanvasBackground>('white');
  const [ortho, setOrtho] = useState(false);
  const [editMode, setEditMode] = useState<CanvasEditMode>('select');
  const [captureDialog, setCaptureDialog] = useState(false);
  const [capturesEnabled, setCapturesEnabled] = useState(false);
  const [trackingEnabled, setTrackingEnabled] = useState(false);
  const [pendingCapturesEnabled, setPendingCapturesEnabled] = useState(false);
  const [pendingTrackingEnabled, setPendingTrackingEnabled] = useState(false);
  const [captureKinds, setCaptureKinds] = useState<CaptureKind[]>([]);
  const [pendingCaptures, setPendingCaptures] = useState<CaptureKind[]>([]);
  const [availableCaptures, setAvailableCaptures] = useState<CaptureKind[]>([]);
  const [sheetInfo, setSheetInfo] = useState<DwfSheet[]>([]);
  const [showDrawings, setShowDrawings] = useState(false);
  const [hiddenPlans, setHiddenPlans] = useState<string[]>([]);
  const [canvasReady, setCanvasReady] = useState(false);
  const focusPlanId = focusMeasure?.planId;
  const focusPage = focusMeasure?.page;
  const focusMeasureId = focusMeasure?.measureId;
  const history = useRef<TakeoffPlan[][]>([]);
  const lastCommittedPlans = useRef<TakeoffPlan[]>([]);
  const deletedLinkedIds = useRef(new Set<string>());
  const busy = useRef(false);
  const canvas = useRef<PlanCanvasHandle>(null);
  const receiveLayers = useCallback((names: string[], invisible: string[]) => { setCanvasLayers(names); setHiddenLayers(invisible); }, []);
  const availablePlans = chapterId ? plans.filter(plan => plan.chapterId === chapterId) : plans;
  const plan = availablePlans.find(p => p.id === active);
  const visibleMeasures = embedded && !measureContext ? [] : measuresForContext(plan?.measures ?? [], measureContext, linkedMeasureIds);
  const selectedMeasure = visibleMeasures.find(measure => measure.id === selected);
  const scale = plan?.scales[page] ?? null;
  const destinationHint = destinationColumn ? `Coluna ${destinationColumn}: qualquer ferramenta pode preencher esta célula. Sem escala, o resultado usa unidades do desenho.` : '';
  const locked = readOnly || !ready || saving;
  const drawable = canvasReady && !!plan && !hiddenPlans.includes(plan.id);
  const previewPoints = tool && tool !== 'calibrate' && tool !== 'count' && cursor && draft.length && (!fixedPointCount(tool) || draft.length < 2)
    ? [...draft, cursor] : draft;
  const draftResult = tool && tool !== 'calibrate' && previewPoints.length >= minimumPoints(tool)
    ? quantity(tool, previewPoints, scale, Number(heightMeters.replace(',', '.'))) : null;
  const lastPoint = draft.at(-1);
  const displacement = cursor && lastPoint ? Math.hypot(cursor.x - lastPoint.x, cursor.y - lastPoint.y) * (scale ?? 1) : null;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busy.current || draft.length) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft.length]);
  useEffect(() => {
    let alive = true;
    void readTakeoffs(storageKey, { migrateLocal: !readOnly }).then(data => {
      if (!alive) return; const available = chapterId ? data.filter(plan => plan.chapterId === chapterId) : data; lastCommittedPlans.current = data; setPlans(data); setActive(available.some(plan => plan.id === focusPlanId) ? focusPlanId! : available[0]?.id ?? ''); setPage(focusPage ?? 1); setSelected(focusMeasureId ?? ''); setReady(true); setStatus('Plantas na nuvem');
    }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Não foi possível acessar as plantas na nuvem. A cópia local foi preservada.'); });
    return () => { alive = false; };
  }, [storageKey, focusPlanId, focusPage, focusMeasureId, chapterId, readOnly]);
  async function commit(next: TakeoffPlan[], undo = false) {
    if (locked || busy.current) return false;
    busy.current = true; setSaving(true); setError(''); setStatus('Salvando…');
    try {
      const previous = lastCommittedPlans.current;
      await saveTakeoffs(storageKey, next, previous);
      if (undo) history.current.pop(); else history.current = [...history.current.slice(-19), previous];
      lastCommittedPlans.current = next;
      setPlans(next);
      window.dispatchEvent(new CustomEvent(TAKEOFF_CATALOG_UPDATED, { detail: storageKey }));
      if (undo && !next.some(p => p.id === active)) { setActive(next[0]?.id ?? ''); setPage(1); }
      setStatus('Salvo na nuvem'); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar na nuvem. O traçado atual foi preservado para tentar novamente.'); setStatus('Alteração não salva'); return false; }
    finally { busy.current = false; setSaving(false); }
  }
  const update = (next: TakeoffPlan) => commit(plans.map(p => p.id === next.id ? next : p));
  const reset = () => { setTool(null); setDraft([]); setDraftName(''); setPendingScale(undefined); };
  async function importFile(file?: File, importFloor = '') {
    if (!file || locked) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    const kind = extension === 'pdf' ? 'pdf' : extension === 'dxf' ? 'dxf' : extension === 'dwf' ? 'dwf' : ['png', 'jpg', 'jpeg'].includes(extension ?? '') ? 'image' : null;
    if (!kind) { setError('Escolha PDF, PNG, JPG, DXF ou DWF 2D. DWG ainda não está disponível.'); return; }
    if (file.size > 100 * 1024 * 1024) { setError('Neste teste, o limite por arquivo é 100 MB.'); return; }
    if (embedded && (!chapterId || !importFloor.trim())) { setError('Informe o pavimento para cadastrar a prancha neste prédio.'); return; }
    if (plans.some(item => item.chapterId === chapterId && item.floor.toLowerCase() === importFloor.trim().toLowerCase() && item.name.toLowerCase() === file.name.toLowerCase())) { setError('Esta prancha já está cadastrada neste prédio e pavimento.'); return; }
    try { if (kind === 'dwf') await openDwfSheets(file); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'DWF inválido ou sem folha 2D compatível.'); return; }
    const next: TakeoffPlan = { id: crypto.randomUUID(), name: file.name, floor: embedded ? importFloor.trim() : '', kind, file, scales: kind === 'dxf' ? { 1: 1 } : {}, measures: [], ...(embedded ? { chapterId, building: plan?.building } : {}) };
    if (!await commit([...plans, next])) return;
    if (!showDrawings) { setActive(next.id); setPage(1); setPages(1); reset(); }
    return next.id;
  }
  async function assignLegacy(planId: string, importFloor: string) {
    const legacy = plans.find(item => item.id === planId && !item.chapterId);
    if (!legacy || !chapterId || locked) return;
    const floor = importFloor.trim();
    if (!floor) { setError('Informe o pavimento para vincular a planta antiga.'); return; }
    if (!await update({ ...legacy, chapterId, building: plan?.building, floor })) return;
    return legacy.id;
  }
  async function deletePlan(planId: string) {
    const target = availablePlans.find(item => item.id === planId);
    if (!target || locked) return false;
    if (active === planId && draft.length) { setError('Conclua ou cancele o traçado antes de apagar esta planta.'); return false; }
    if (target.measures.length) { setError('Esta planta tem marcações. Remova os quantitativos vinculados antes de apagá-la.'); return false; }
    const remaining = plans.filter(item => item.id !== planId);
    if (!await commit(remaining)) return false;
    // A exclusão arquiva a planta na nuvem. O desfazer desta sessão não deve tentar inseri-la de novo.
    history.current = [];
    if (active === planId) { setActive(remaining.find(item => item.chapterId === chapterId)?.id ?? ''); setPage(1); setSelected(''); reset(); }
    setHiddenPlans(previous => previous.filter(id => id !== planId));
    return true;
  }
  async function finish() {
    if (!plan || !drawable || !tool || tool === 'calibrate') return;
    const minimum = minimumPoints(tool);
    if (draft.length < minimum) { setError(`Marque pelo menos ${minimum} pontos.`); return; }
    const height = Number(heightMeters.replace(',', '.'));
    const result = quantity(tool, draft, scale, height);
    if (result === null || result <= 0) { setError(requiresHeight(tool) ? 'Informe uma altura positiva e confira o traçado.' : 'A medição deve ser maior que zero.'); return; }
    const measure: TakeoffMeasure = { id: crypto.randomUUID(), page, name: draftName.trim() || `${labels[tool]} ${visibleMeasures.length + 1}`, kind: tool, points: draft, ...(requiresHeight(tool) ? { heightMeters: height } : {}), ...measureContext };
    if (!await update({ ...plan, measures: [...plan.measures, measure] })) return;
    if (embedded && onUseMeasure) {
      if (onUseMeasure(plan, measure, result) === false) {
        await commit(plans, true);
        return;
      }
      setSelected(''); setDraft([]); setDraftName(''); setPendingScale(undefined);
      return;
    }
    setSelected(measure.id); reset();
  }
  async function applyStoredMeasure(measure: TakeoffMeasure) {
    if (!plan || !onUseMeasure) return;
    const result = quantity(measure.kind, measure.points, plan.scales[measure.page] ?? null, measure.heightMeters);
    if (result === null) return;
    if (measureContext && !measure.taskId && !measure.logId) {
      const claimed = { ...measure, ...measureContext };
      if (!await update({ ...plan, measures: plan.measures.map(item => item.id === measure.id ? claimed : item) })) return;
      if (onUseMeasure(plan, claimed, result) === false) {
        await commit(plans, true);
      }
      return;
    }
    onUseMeasure(plan, measure, result);
  }
  async function moveMeasurePoint(id: string, index: number, point: Point) {
    if (!plan) return;
    const measure = plan.measures.find(item => item.id === id);
    if (!measure) return;
    const changed = { ...measure, points: measure.points.map((existing, i) => i === index ? point : existing) };
    await reviseMeasure(changed);
  }
  async function reviseMeasure(changed: TakeoffMeasure) {
    if (!plan) return;
    const result = quantity(changed.kind, changed.points, plan.scales[changed.page] ?? null, changed.heightMeters);
    if (result === null || result <= 0) { setError('A marcação precisa manter pontos e medida válidos.'); return; }
    if (embedded && linkedMeasureIds.includes(changed.id) && !onUpdateMeasure) { setError('Não foi possível atualizar a célula vinculada.'); return; }
    if (!await update({ ...plan, measures: plan.measures.map(item => item.id === changed.id ? changed : item) })) return;
    if (embedded && linkedMeasureIds.includes(changed.id) && onUpdateMeasure?.(plan, changed, result) === false) {
      await commit(plans, true);
    }
  }
  async function removeMeasure(id: string) {
    if (!plan) return;
    const measure = plan.measures.find(item => item.id === id);
    if (!measure) return;
    if (embedded && linkedMeasureIds.includes(id) && !onDeleteMeasure) { setError('Não foi possível desvincular a marcação da Produção.'); return; }
    if (!await update({ ...plan, measures: plan.measures.filter(item => item.id !== id) })) return;
    if (embedded && linkedMeasureIds.includes(id) && onDeleteMeasure?.(plan, measure) === false) { await commit(plans, true); return; }
    if (embedded && linkedMeasureIds.includes(id)) deletedLinkedIds.current.add(id);
    setSelected('');
  }
  async function addMeasurePoint(id: string, point: Point) {
    const measure = plan?.measures.find(item => item.id === id);
    if (!measure || fixedPointCount(measure.kind)) { setError('Esta medida usa exatamente dois pontos. Selecione Mover ponto.'); return; }
    if (measure.kind === 'count') { await reviseMeasure({ ...measure, points: [...measure.points, point] }); return; }
    const edges = measure.kind === 'area' || measure.kind === 'polygonVolume' ? measure.points.length : measure.points.length - 1;
    let best = Number.POSITIVE_INFINITY, insertion = measure.points.length;
    for (let i = 0; i < edges; i++) {
      const a = measure.points[i], b = measure.points[(i + 1) % measure.points.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const gap = Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
      if (gap < best) { best = gap; insertion = i + 1; }
    }
    const points = [...measure.points]; points.splice(insertion, 0, point);
    await reviseMeasure({ ...measure, points });
  }
  async function deleteMeasurePoint(id: string, index: number) {
    const measure = plan?.measures.find(item => item.id === id);
    if (!measure) return;
    const points = measure.points.filter((_, i) => i !== index);
    if (points.length < minimumPoints(measure.kind)) { await removeMeasure(id); return; }
    await reviseMeasure({ ...measure, points });
  }
  async function undoLast() {
    const previous = history.current.at(-1);
    if (!previous || !plan) return;
    const oldPlan = previous.find(item => item.id === plan.id);
    if (embedded && oldPlan) {
      const scalePage = [...new Set([...Object.keys(oldPlan.scales), ...Object.keys(plan.scales)])].map(Number).find(index => oldPlan.scales[index] !== plan.scales[index]);
      if (scalePage && plan.measures.some(item => item.page === scalePage && linkedMeasureIds.includes(item.id)) && !onRecalibrate) {
        setError('Não foi possível desfazer esta escala sem recalcular as células vinculadas.'); return;
      }
      const oldRows = new Map(oldPlan.measures.map(item => [item.id, item]));
      const currentRows = new Map(plan.measures.map(item => [item.id, item]));
      const changedIds = [...new Set([...oldRows.keys(), ...currentRows.keys()])].filter(id => JSON.stringify(oldRows.get(id)) !== JSON.stringify(currentRows.get(id)));
      if (changedIds.length > 1) { setError('Esta operação altera várias marcações; desfaça pela edição da medida original.'); return; }
      const id = changedIds[0];
      const before = id ? oldRows.get(id) : undefined;
      const after = id ? currentRows.get(id) : undefined;
      if (before && after && linkedMeasureIds.includes(id) && !onUpdateMeasure) { setError('Não foi possível atualizar a célula vinculada.'); return; }
      if (!before && after && linkedMeasureIds.includes(id) && !onDeleteMeasure) { setError('Não foi possível desfazer o lançamento vinculado.'); return; }
      if (before && !after && deletedLinkedIds.current.has(id) && !onRestoreMeasure) { setError('Não foi possível restaurar a célula vinculada.'); return; }
      if (!await commit(previous, true)) return;
      const restored = scalePage && onRecalibrate
        ? onRecalibrate(oldPlan, scalePage, oldPlan.scales[scalePage] ?? null)
        : before && after && linkedMeasureIds.includes(id)
        ? onUpdateMeasure?.(oldPlan, before, quantity(before.kind, before.points, oldPlan.scales[before.page] ?? null, before.heightMeters) ?? 0)
        : !before && after && linkedMeasureIds.includes(id) ? onDeleteMeasure?.(plan, after)
          : before && !after && deletedLinkedIds.current.has(id) ? onRestoreMeasure?.(oldPlan, before) : true;
      if (restored === false) { await commit(plans); setError('Não foi possível desfazer sem alterar os limites da Produção.'); return; }
      if (id) deletedLinkedIds.current.delete(id);
      reset(); return;
    }
    if (await commit(previous, true)) reset();
  }
  async function confirmScale() {
    if (!plan || pendingScale === undefined) return;
    if (embedded && !onRecalibrate && plan.measures.some(item => item.page === page && item.kind !== 'count')) { setError('A Produção precisa validar as células vinculadas antes de recalibrar.'); return; }
    if (!await update({ ...plan, scales: { ...plan.scales, [page]: pendingScale } })) return;
    if (embedded && onRecalibrate?.(plan, page, pendingScale) === false) { await commit(plans, true); return; }
    reset();
  }
  const fieldKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.currentTarget.value = event.currentTarget.defaultValue; event.currentTarget.blur(); }
    if (event.key === 'Enter') event.currentTarget.blur();
  };
  return <section className="mx-auto flex w-full max-w-[2100px] flex-col gap-1 bg-[#f5f6f7] p-1.5 text-slate-800 sm:p-2" aria-label="Levantamento em planta">
    <header className="flex min-w-0 flex-wrap items-center gap-2 border border-slate-300 bg-white px-3 py-1.5">
      <div className="mr-auto min-w-0">
        <div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold">Levantamento em planta</h1><span className="bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">Experimental</span></div>
        <p className="text-xs text-muted-foreground">{plan ? `${plan.building ? `${plan.building} · ` : ''}${plan.name}${plan.floor ? ` · ${plan.floor}` : ''}` : 'Escolha uma planta para começar'}</p>
      </div>
      <span role="status" className="order-last w-full text-xs text-muted-foreground sm:order-none sm:w-auto">{status}</span>
      {embedded && <Button title="Gerenciar plantas — adicionar, selecionar ou apagar pranchas deste prédio" aria-label="Gerenciar plantas" aria-expanded={showDrawings} variant="outline" size="sm" className="h-7 rounded-none text-xs" onClick={() => { setError(''); setShowDrawings(true); }}><List className="mr-1 h-3.5 w-3.5" />Plantas</Button>}
      {!embedded && <label className={`inline-flex h-7 items-center gap-1.5 border border-slate-300 bg-slate-50 px-2 text-xs font-medium ${locked ? 'opacity-50' : 'cursor-pointer hover:bg-slate-100'}`}><FileUp className="h-3.5 w-3.5" />Adicionar planta<input aria-label="Adicionar planta" className="sr-only" type="file" accept=".pdf,.png,.jpg,.jpeg,.dxf,.dwf" disabled={locked} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></label>}
    </header>
    {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}
    {showDrawings && <PlanDrawingManager plans={availablePlans} legacyPlans={embedded ? plans.filter(item => !item.chapterId) : []} activeId={active} hiddenIds={hiddenPlans} readOnly={readOnly} locked={!ready || saving} error={error} onClose={() => setShowDrawings(false)} onAccept={(id, hidden) => { setHiddenPlans(hidden); if (id !== active) { setActive(id); setPage(1); setPages(1); setSelected(''); reset(); } setShowDrawings(false); }} onImport={importFile} onAssignLegacy={assignLegacy} onDelete={deletePlan} />}
    {!availablePlans.length && ready && <div className="rounded border border-dashed bg-card p-10 text-center text-muted-foreground">{embedded ? showDrawings ? 'A planta escolhida será exibida aqui.' : 'Nenhuma planta cadastrada neste prédio. Abra Plantas acima para adicionar uma prancha.' : 'Adicione uma planta para começar. PDF, imagem, DXF ou DWF 2D.'}</div>}
    {!!availablePlans.length && plan && <div className="flex min-w-0 flex-col gap-1">
        <div role="toolbar" aria-label="Ferramentas de levantamento" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 border border-slate-300 bg-[#e9ecef] px-1.5 py-1 text-xs">
          <div className="flex shrink-0 items-center gap-1 border-r border-slate-300 pr-2 tabular-nums" aria-label="Informações do cursor e da medição">
            {destinationHint && <span className="whitespace-nowrap font-medium text-slate-700" title={destinationHint}>{destinationColumn} · Captura livre</span>}
            {displacement !== null && <span className="whitespace-nowrap text-slate-600" title="Distância do último ponto ao cursor">Δ {format(displacement)} {scale === null ? 'u.d.' : 'm'}</span>}
             {draftResult !== null && tool && tool !== 'calibrate' && <span className="whitespace-nowrap font-medium" title="Resultado do traçado">{measureCategory(tool) === 'length' ? 'C' : measureCategory(tool) === 'area' ? 'A' : measureCategory(tool) === 'volume' ? 'V' : 'Q'} {format(draftResult)} {measureUnit(tool, scale)}</span>}
            <span className="whitespace-nowrap text-slate-600" title={scale ? 'Conversão da unidade do desenho para metros' : 'Medidas sem escala usam unidades do desenho; não são metros'}>{scale ? `${format(scale)} m/unid.` : 'Unidades do desenho'}</span>
          </div>
          <div className="flex items-center gap-0.5 border-r border-slate-300 pr-1" aria-label="Visualização e navegação">
            <label title="Fundo do desenho — branco, cinza ou preto" className="flex h-7 items-center gap-1 px-1"><Palette className="h-4 w-4" /><select aria-label="Fundo do desenho" className="h-6 border border-slate-300 bg-white text-xs" value={background} onChange={event => setBackground(event.target.value as CanvasBackground)}><option value="white">Branco</option><option value="gray">Cinza</option><option value="black">Preto</option></select></label>
            <Button title="Modo ortogonal — restringe o próximo segmento aos eixos horizontal ou vertical" aria-label="Modo ortogonal" aria-pressed={ortho} variant="ghost" size="icon" className={`h-7 w-7 rounded-none ${ortho ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-400' : ''}`} onClick={() => setOrtho(value => !value)}><Square className="h-4 w-4" /></Button>
            <Button title="Ampliar — aproxima o desenho; a roda também controla o zoom" aria-label="Ampliar" variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => canvas.current?.zoomIn()}><ZoomIn className="h-4 w-4" /></Button>
            <Button title="Reduzir — afasta o desenho" aria-label="Reduzir" variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => canvas.current?.zoomOut()}><ZoomOut className="h-4 w-4" /></Button>
            <Button title="Enquadrar — mostra toda a prancha na janela" aria-label="Enquadrar desenho" variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => canvas.current?.fit()}><Maximize2 className="h-4 w-4" /></Button>
            <Button title="Deslocar vista — arraste o desenho; o botão central também desloca" aria-label="Deslocar vista" aria-pressed={!tool && editMode === 'pan'} variant="ghost" size="icon" className={`h-7 w-7 rounded-none ${!tool && editMode === 'pan' ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-400' : ''}`} onClick={() => { reset(); setEditMode('pan'); }}><Move className="h-4 w-4" /></Button>
          </div>
          <div className="flex items-center gap-0.5 border-r border-slate-300 pr-1" aria-label="Capturas para máscaras">
            <Button title="Capturas para máscaras — escolha pontos geométricos identificados no DXF" aria-label="Capturas para máscaras" aria-pressed={captureDialog || capturesEnabled} variant="ghost" size="icon" className={`h-7 w-7 rounded-none ${captureDialog || capturesEnabled ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-400' : ''}`} onClick={() => { setPendingCaptures(captureKinds); setPendingCapturesEnabled(capturesEnabled); setPendingTrackingEnabled(trackingEnabled); setCaptureDialog(true); }}><Magnet className="h-4 w-4" /></Button>
          </div>
          <div className="flex items-center gap-0.5 border-r border-slate-300 pr-1" aria-label="Levantamento">
             {MEASURE_KINDS.map(kind => {
               const Icon = toolIcons[kind];
               const description = kind === 'count' ? 'marque pontos numerados, sem linha' : kind === 'linearLength' ? 'marque dois extremos' : kind === 'length' ? 'some os segmentos do percurso' : kind === 'circlePerimeter' ? 'marque centro e raio para obter o perímetro' : kind === 'rectangleArea' ? 'marque vértices opostos do retângulo' : kind === 'area' ? 'marque vértices e feche o polígono' : kind === 'circleArea' ? 'marque centro e raio para obter a área' : 'use a altura informada na faixa inferior';
               const unavailable = readOnly ? 'Somente consulta' : !ready || saving ? 'Aguarde a abertura ou o salvamento da planta' : !drawable ? 'Aguarde a renderização ou mostre a prancha' : !allowedKinds.includes(kind) ? 'Esta ferramenta não está disponível neste contexto' : '';
               const hint = unavailable || `${labels[kind]} — ${description}`;
               return <span key={kind} className="inline-flex" title={hint}><Button title={hint} aria-label={labels[kind]} aria-description={unavailable || description} aria-pressed={tool === kind} variant="ghost" size="icon" className={`h-7 w-7 rounded-none ${tool === kind ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-400' : ''}`} disabled={locked || !drawable || !allowedKinds.includes(kind)} onClick={() => { setError(''); setDraft([]); setDraftName(''); setTool(kind); setEditMode('select'); setPendingScale(undefined); }}><Icon className="h-4 w-4" /></Button></span>;
             })}
            <Button title="Calibrar escala — marque dois pontos e informe a distância em metros" aria-label="Calibrar escala" aria-pressed={tool === 'calibrate'} variant="ghost" size="icon" className={`h-7 w-7 rounded-none ${tool === 'calibrate' ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-400' : ''}`} disabled={locked || !drawable} onClick={() => { setError(''); setTool('calibrate'); setDraft([]); setPendingScale(undefined); }}><Crosshair className="h-4 w-4" /></Button>
          </div>
          <div className="flex items-center gap-0.5 border-r border-slate-300 pr-1" aria-label="Edição das marcações">
            {([['select', MousePointer2, 'Selecionar/Editar medida', 'selecione uma marcação para conferir ou editar'], ['deleteMeasure', Trash2, 'Apagar medida', 'remove a marcação e limpa a célula vinculada'], ['addPoint', Plus, 'Adicionar ponto', 'insere um ponto na medida selecionada'], ['deletePoint', X, 'Apagar ponto', 'clique no ponto de uma medida existente'], ['movePoint', Move, 'Mover ponto', 'arraste um vértice da medida selecionada']] as const).map(([mode, Icon, name, description]) => <Button key={mode} title={`${name} — ${description}`} aria-label={name} aria-pressed={!tool && editMode === mode} variant="ghost" size="icon" className={`h-7 w-7 rounded-none ${!tool && editMode === mode ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-400' : ''}`} disabled={locked && mode !== 'select' || (mode === 'addPoint' || mode === 'deletePoint' || mode === 'movePoint') && !selectedMeasure} onClick={() => { reset(); setEditMode(mode); }}><Icon className="h-4 w-4" /></Button>)}
            <Button title="Desfazer — reverte a última alteração da planta nesta sessão" aria-label="Desfazer" variant="ghost" size="icon" className="h-7 w-7 rounded-none" disabled={locked || !history.current.length} onClick={() => { void undoLast(); }}><Undo2 className="h-4 w-4" /></Button>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-1 border-r border-slate-300 pr-2 sm:w-auto" aria-label="Desenho">
            <Button title="Lista de plantas — selecione, adicione ou apague uma prancha" aria-label="Lista de plantas" aria-expanded={showDrawings} variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => { setError(''); setShowDrawings(true); }}><List className="h-4 w-4" /></Button>
            <select aria-label="Planta" title="Selecionar planta" className="h-7 w-44 max-w-full min-w-0 border border-slate-300 bg-white px-1 text-xs" value={active} onChange={e => { setActive(e.target.value); setPage(1); setPages(1); setSelected(''); reset(); }}>{availablePlans.map(p => <option key={p.id} value={p.id}>{p.name}{p.floor ? ` · ${p.floor}` : ''}</option>)}</select>
            {(plan.kind === 'pdf' || plan.kind === 'dwf') && <select aria-label="Página" title={plan.kind === 'dwf' ? 'Prancha do DWF' : 'Página do PDF'} className="h-7 w-40 max-w-full min-w-0 border border-slate-300 bg-white px-1 text-xs" value={page} onChange={e => { setPage(Number(e.target.value)); reset(); setSelected(''); }}>{Array.from({ length: pages }, (_, i) => <option key={i} value={i + 1}>{plan.kind === 'dwf' ? `${i + 1}. ${sheetInfo[i]?.name ?? 'Prancha'}${sheetInfo[i] && !sheetInfo[i].supported ? ' · indisponível' : ''}` : `Pág. ${i + 1}`}</option>)}</select>}
            {plan.kind === 'dxf' && <details className="relative"><summary className="flex h-7 cursor-pointer list-none items-center gap-1 border border-slate-300 bg-white px-1.5" title="Layers — mostre ou oculte camadas identificadas no DXF"><Layers3 className="h-4 w-4" />Layers ({canvasLayers.length})</summary><div className="absolute left-0 top-7 z-30 max-h-60 w-60 overflow-auto border border-slate-300 bg-white p-2 shadow-md">{canvasLayers.map(name => <label key={name} className="flex items-center gap-2 py-1 text-xs"><input type="checkbox" checked={!hiddenLayers.includes(name)} onChange={e => canvas.current?.toggleLayer(name, e.target.checked)} />{name}</label>)}</div></details>}
            {plan.kind === 'dwf' && <span title="Layers indisponíveis: este leitor DWF não fornece entidades de layer confiáveis para esta prancha." className="flex h-7 items-center gap-1 border border-slate-300 px-1.5 text-slate-400"><Layers3 className="h-4 w-4" />Layers</span>}
            <Button title="Configurações da planta — nome, pavimento e unidade do DXF" aria-label="Configurações da planta" aria-expanded={showSettings} variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => setShowSettings(v => !v)}><Settings2 className="h-4 w-4" /></Button>
          </div>
          <div className="flex shrink-0 items-center gap-1" aria-label="Quantitativo">
            {embedded && selectedMeasure && !tool ? <Input key={`${selectedMeasure.id}-${selectedMeasure.name}`} aria-label="Renomear marcação selecionada" title="Renomear marcação selecionada" className="h-7 w-32 rounded-none border-slate-300 bg-white px-1.5 text-xs" defaultValue={selectedMeasure.name} disabled={locked} onKeyDown={fieldKey} onBlur={e => { const name = e.target.value.trim(); if (name && name !== selectedMeasure.name) void update({ ...plan, measures: plan.measures.map(measure => measure.id === selectedMeasure.id ? { ...measure, name } : measure) }); }} /> : <Input aria-label="Nome do levantamento" title="Nome do levantamento em curso" className="h-7 w-32 rounded-none border-slate-300 bg-white px-1.5 text-xs" placeholder="Nome do item" value={draftName} disabled={!tool || tool === 'calibrate' || locked} onChange={e => setDraftName(e.target.value)} />}
             <Button title="Concluir traçado — grava a medida na célula escolhida" aria-label="Concluir traçado" variant="ghost" size="icon" className="h-7 w-7 rounded-none" disabled={locked || !drawable || !tool || tool === 'calibrate' || draft.length < minimumPoints(tool)} onClick={finish}><Check className="h-4 w-4" /></Button>
             <Button title="Cancelar traçado — descarta os pontos ainda não concluídos" aria-label="Cancelar traçado" variant="ghost" size="icon" className="h-7 w-7 rounded-none" disabled={!tool} onClick={reset}><X className="h-4 w-4" /></Button>
             {embedded && onUseMeasure && selectedMeasure && !tool && <Button title="Usar a marcação selecionada na célula escolhida" aria-label="Usar marcação selecionada" variant="outline" size="sm" className="h-7 rounded-none px-2 text-xs" disabled={locked || quantity(selectedMeasure.kind, selectedMeasure.points, plan.scales[selectedMeasure.page] ?? null, selectedMeasure.heightMeters) === null} onClick={() => { void applyStoredMeasure(selectedMeasure); }}>Usar {format(quantity(selectedMeasure.kind, selectedMeasure.points, plan.scales[selectedMeasure.page] ?? null, selectedMeasure.heightMeters))} {measureUnit(selectedMeasure.kind, plan.scales[selectedMeasure.page] ?? null)}</Button>}
              {embedded && selectedMeasure && !tool && <Button title="Apagar marcação selecionada — limpa a célula vinculada após validar o saldo" aria-label="Excluir marcação selecionada" variant="ghost" size="icon" className="h-7 w-7 rounded-none text-red-700" disabled={locked} onClick={() => { void removeMeasure(selectedMeasure.id); }}><Trash2 className="h-4 w-4" /></Button>}
          </div>
        </div>
        {captureDialog && <div role="dialog" aria-label="Capturas para máscaras" className="relative z-20 w-full border border-slate-400 bg-white p-3 text-xs shadow-md">
          <div className="flex items-center gap-2"><strong>Capturas para máscaras</strong><span className="text-slate-500">{plan.kind === 'dxf' ? 'Geometria identificada no espaço de modelo DXF.' : 'Esta folha não oferece entidades identificáveis; marque livremente.'}</span></div>
          <div className="mt-2 flex flex-wrap gap-4"><label className="flex items-center gap-1"><input type="checkbox" checked={pendingCapturesEnabled} disabled={plan.kind !== 'dxf' || !availableCaptures.length} onChange={event => setPendingCapturesEnabled(event.target.checked)} />Ativar capturas</label><label className="flex items-center gap-1"><input type="checkbox" checked={pendingTrackingEnabled} disabled={plan.kind !== 'dxf' || !availableCaptures.length} onChange={event => setPendingTrackingEnabled(event.target.checked)} />Ativar rastreamento</label></div>
          <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">{CAPTURE_KINDS.map(kind => { const enabled = plan.kind === 'dxf' && availableCaptures.includes(kind); return <label key={kind} className={`flex items-center gap-1 ${enabled ? '' : 'text-slate-400'}`} title={enabled ? `${CAPTURE_LABELS[kind]} — capturar na geometria reconhecida` : `${CAPTURE_LABELS[kind]} — geometria não identificada nesta planta`}><input type="checkbox" checked={pendingCaptures.includes(kind) && enabled} disabled={!enabled} onChange={event => setPendingCaptures(previous => event.target.checked ? [...previous, kind] : previous.filter(item => item !== kind))} />{CAPTURE_LABELS[kind]}</label>; })}</div>
          <div className="mt-3 flex items-center gap-2"><Button size="sm" className="h-7 text-xs" onClick={() => { setCaptureKinds(pendingCaptures.filter(kind => availableCaptures.includes(kind))); setCapturesEnabled(pendingCapturesEnabled); setTrackingEnabled(pendingTrackingEnabled); setCaptureDialog(false); }}>Confirmar</Button><Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setPendingCaptures([]); setPendingCapturesEnabled(false); setPendingTrackingEnabled(false); }}>Desmarcar todas</Button><Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCaptureDialog(false)}>Cancelar</Button></div>
        </div>}
        {showSettings && <div className="flex flex-wrap items-end gap-2 border border-slate-300 bg-white p-2 text-xs">
          <label className="min-w-[180px] flex-1">Nome da planta<Input className="h-7 rounded-none text-xs" onKeyDown={fieldKey} key={`${plan.id}-name-${plan.name}`} defaultValue={plan.name} disabled={locked} onBlur={e => { const name = e.target.value.trim(); if (name && name !== plan.name) void update({ ...plan, name }); }} /></label>
          <label className="min-w-[140px]">Pavimento<Input className="h-7 rounded-none text-xs" onKeyDown={fieldKey} key={`${plan.id}-floor-${plan.floor}`} defaultValue={plan.floor} disabled={locked} placeholder="Ex.: Térreo" onBlur={e => { if (e.target.value !== plan.floor) void update({ ...plan, floor: e.target.value }); }} /></label>
          {plan.kind === 'dxf' && <label>Unidade do DXF<select aria-label="Unidade do DXF" className="block h-7 border border-slate-300 bg-white px-2" value={cadUnit} disabled={locked} onChange={e => setCadUnit(e.target.value)}><option value="1">Metro (padrão)</option><option value="0.01">Centímetro</option><option value="0.001">Milímetro</option></select></label>}
          {plan.kind === 'dxf' && <Button size="sm" variant="outline" className="h-7 rounded-none text-xs" disabled={locked} onClick={() => setPendingScale(Number(cadUnit))}>Conferir unidade</Button>}
          <p className="basis-full text-xs text-muted-foreground">Arquivo e marcações são salvos na nuvem da obra, com cópia local de recuperação. {plan.kind === 'dxf' ? 'DXF novo usa metro por padrão; ajuste aqui se o arquivo estiver em centímetros ou milímetros. DXF 2D usa o espaço de modelo.' : embedded ? 'Concluir o traçado preenche a célula escolhida; confirme o total no lançamento do dia.' : 'Não lançam produção ou medição.'}</p>
        </div>}
        {tool && <div className="flex min-h-8 flex-wrap items-center gap-2 border-x border-b border-slate-300 bg-[#f2f3f4] px-2 py-0.5 text-xs">
          <strong>{tool === 'calibrate' ? 'Calibrar escala' : labels[tool]}</strong>
          <span className="text-slate-500">{draft.length} ponto{draft.length === 1 ? '' : 's'}</span>
          {tool === 'calibrate' && <><Input aria-label="Distância conhecida em metros" className="h-7 w-36 rounded-none text-xs" placeholder="Distância em metros" value={distance} onChange={e => setDistance(e.target.value)} /><Button size="sm" className="h-7 rounded-none text-xs" disabled={locked || draft.length !== 2} onClick={() => { try { setPendingScale(calibration(draft, Number(distance.replace(',', '.')))); setError(''); } catch (e) { setError((e as Error).message); } }}>Conferir escala</Button></>}
          {tool !== 'calibrate' && requiresHeight(tool) && <label className="flex items-center gap-1">Altura (m)<Input aria-label="Altura da medição em metros" inputMode="decimal" className="h-7 w-20 rounded-none text-xs" value={heightMeters} onChange={e => setHeightMeters(e.target.value)} /></label>}
          <Button size="sm" variant="ghost" className="h-7 rounded-none text-xs" disabled={!draft.length} onClick={() => setDraft(d => d.slice(0, -1))}><Undo2 className="h-3.5 w-3.5" />Retirar último ponto</Button>
        </div>}
         {pendingScale !== undefined && <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-slate-900"><p>Nova escala: {pendingScale.toLocaleString('pt-BR', { maximumSignificantDigits: 8 })} m por unidade do desenho. A escala pertence à prancha; os lançamentos vinculados serão validados antes da atualização.</p>{visibleMeasures.filter(m => m.page === page && m.kind !== 'count').map(m => <p key={m.id}>{m.name}: {format(quantity(m.kind, m.points, scale, m.heightMeters))} {measureUnit(m.kind, scale)} → {format(quantity(m.kind, m.points, pendingScale, m.heightMeters))} {measureUnit(m.kind, pendingScale)}</p>)}<Button size="sm" disabled={locked} onClick={() => { void confirmScale(); }}>Confirmar escala</Button> <Button size="sm" variant="outline" onClick={() => setPendingScale(undefined)}>Voltar</Button></div>}
        <PlanCanvas ref={canvas} plan={{ ...plan, measures: visibleMeasures }} page={page} draft={draft} draftKind={tool} drawing={!!tool && !locked && drawable} selected={selected} readOnly={locked} executedMeasureIds={executedMeasureIds} onPages={setPages} onSheets={setSheetInfo} onReady={setCanvasReady} onCursor={setCursor} onLayers={receiveLayers} onCaptureAvailable={setAvailableCaptures} background={background} ortho={ortho} capturesEnabled={capturesEnabled && plan.kind === 'dxf'} trackingEnabled={trackingEnabled} captureKinds={captureKinds.filter(kind => availableCaptures.includes(kind))} editMode={editMode} visible={!hiddenPlans.includes(plan.id)} onFinish={() => { void finish(); }} onPoint={p => setDraft(d => tool === 'calibrate' && d.length >= 2 ? [p] : tool && tool !== 'calibrate' && fixedPointCount(tool) && d.length >= 2 ? [p] : [...d, p])} onSelect={setSelected} onMove={(id, index, point) => { void moveMeasurePoint(id, index, point); }} onDeleteMeasure={id => { void removeMeasure(id); }} onAddPoint={(id, point) => { void addMeasurePoint(id, point); }} onDeletePoint={(id, index) => { void deleteMeasurePoint(id, index); }} />
        <div role="status" className="flex min-h-7 items-center gap-2 border border-slate-300 bg-[#e9ecef] px-2 text-xs text-slate-700"><strong>{tool === 'calibrate' ? 'Calibração' : tool ? labels[tool] : editMode === 'pan' ? 'Deslocamento' : editMode === 'deleteMeasure' ? 'Apagar medida' : editMode === 'addPoint' ? 'Adicionar ponto' : editMode === 'deletePoint' ? 'Apagar ponto' : editMode === 'movePoint' ? 'Mover ponto' : 'Seleção'}</strong><span className="border-l border-slate-400 pl-2">{!drawable ? 'Aguarde a renderização ou mostre uma prancha compatível.' : tool === 'calibrate' ? 'Marque dois pontos e informe a distância conhecida.' : tool ? 'Clique para marcar; botão direito conclui, botão central desloca e a roda amplia ou reduz.' : editMode === 'addPoint' ? 'Selecione uma medida e clique onde deseja inserir o ponto.' : editMode === 'deletePoint' ? 'Clique no ponto que deseja remover.' : editMode === 'movePoint' ? 'Selecione a medida e arraste um ponto.' : editMode === 'deleteMeasure' ? 'Clique na marcação que deseja excluir; o subtotal será validado.' : embedded ? selectedMeasure ? `Marcação ${selectedMeasure.name} selecionada; use o resultado na barra superior.` : 'Clique numa marcação existente para usá-la na célula, ou inicie uma nova contagem.' : 'Arraste ou segure o botão central para deslocar; use a roda do mouse para zoom.'}</span></div>
        {!embedded && <section className="min-w-0 overflow-hidden border border-slate-300 bg-white" aria-label="Detalhe dos levantamentos">
          <button className="flex w-full items-center gap-2 border-b border-slate-300 bg-[#e9ecef] px-2 py-1 text-left text-xs font-semibold hover:bg-slate-100" onClick={() => setShowDetails(v => !v)} aria-expanded={showDetails}>{showDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}Detalhe dos levantamentos <span className="ml-auto text-xs font-normal">{plan.measures.length} {plan.measures.length === 1 ? 'registro' : 'registros'}</span></button>
          {showDetails && <div className="h-52 min-h-36 max-h-[55vh] resize-y overflow-auto">
            <table className="w-full min-w-[600px] text-xs"><thead className="sticky top-0 z-10 bg-[#f1f2f3]"><tr><th className="border-r border-slate-300 px-2 py-1 text-left">Nome</th><th className="border-r border-slate-300 px-2 py-1 text-left">Página</th><th className="border-r border-slate-300 px-2 py-1 text-left">Tipo</th><th className="border-r border-slate-300 px-2 py-1 text-right">Resultado</th><th className="px-2 py-1 text-right">Ações</th></tr></thead><tbody>{plan.measures.map(m => <tr key={m.id} className={`cursor-pointer border-t border-slate-200 ${selected === m.id ? 'bg-sky-100 text-slate-900' : 'hover:bg-slate-50'}`} onClick={() => { setSelected(m.id); if (m.page !== page) { setPage(m.page); reset(); } }}><td className="min-w-48 px-2 py-0.5"><Input className="h-7 rounded-none text-xs" onKeyDown={fieldKey} aria-label={`Nome de ${m.name}`} key={`${m.id}-${m.name}`} defaultValue={m.name} disabled={locked} onBlur={e => { const name = e.target.value.trim(); if (name && name !== m.name) void update({ ...plan, measures: plan.measures.map(row => row.id === m.id ? { ...row, name } : row) }); }} /></td><td className="px-2 py-0.5">{m.page}</td><td className="px-2 py-0.5">{labels[m.kind]}</td><td className="whitespace-nowrap px-2 py-0.5 text-right tabular-nums">{format(quantity(m.kind, m.points, plan.scales[m.page] ?? null, m.heightMeters))} {measureUnit(m.kind, plan.scales[m.page] ?? null)}</td><td className="px-2 py-0.5 text-right"><Button size="sm" variant="ghost" className="h-7 text-xs" disabled={locked} onClick={e => { e.stopPropagation(); void removeMeasure(m.id); }}>Excluir</Button></td></tr>)}</tbody></table>{!plan.measures.length && <p className="p-3 text-xs text-muted-foreground">Nenhum levantamento nesta planta.</p>}
          </div>}
        </section>}
    </div>}
  </section>;
}
