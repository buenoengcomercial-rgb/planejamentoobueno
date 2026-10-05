import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, ChevronDown, ChevronUp, CircleDot, Crosshair, FileUp, Layers3, Maximize2, MousePointer2, Ruler, Settings2, Shapes, Trash2, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { calibration, quantity, readTakeoffs, saveTakeoffs, type MeasureKind, type Point, type TakeoffMeasure, type TakeoffPlan } from '@/lib/planTakeoff';
import PlanCanvas, { type PlanCanvasHandle } from './PlanCanvas';

const labels = { count: 'Contagem', length: 'Comprimento', area: 'Área' };
const units = { count: 'un', length: 'm', area: 'm²' };
const format = (value: number | null) => value === null ? 'Escala pendente' : value.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
export default function PlanTakeoff({ storageKey, readOnly, onUseMeasure, executedMeasureIds = [], focusMeasure, embedded = false, allowedKinds = ['count', 'length', 'area'] }: { storageKey: string; readOnly: boolean; onUseMeasure?: (plan: TakeoffPlan, measure: TakeoffMeasure, result: number) => boolean | void; executedMeasureIds?: string[]; focusMeasure?: { planId: string; page: number; measureId: string }; embedded?: boolean; allowedKinds?: MeasureKind[] }) {
  const [plans, setPlans] = useState<TakeoffPlan[]>([]);
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('Carregando dados locais…');
  const [error, setError] = useState('');
  const [tool, setTool] = useState<MeasureKind | 'calibrate' | null>(null);
  const [draft, setDraft] = useState<Point[]>([]);
  const [selected, setSelected] = useState('');
  const [distance, setDistance] = useState('');
  const [cadUnit, setCadUnit] = useState('1');
  const [pendingScale, setPendingScale] = useState<number>();
  const [draftName, setDraftName] = useState('');
  const [cursor, setCursor] = useState<Point | null>(null);
  const [canvasLayers, setCanvasLayers] = useState<string[]>([]);
  const [hiddenLayers, setHiddenLayers] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const focusPlanId = focusMeasure?.planId;
  const focusPage = focusMeasure?.page;
  const focusMeasureId = focusMeasure?.measureId;
  const history = useRef<TakeoffPlan[][]>([]);
  const busy = useRef(false);
  const canvas = useRef<PlanCanvasHandle>(null);
  const receiveLayers = useCallback((names: string[], invisible: string[]) => { setCanvasLayers(names); setHiddenLayers(invisible); }, []);
  const plan = plans.find(p => p.id === active);
  const selectedMeasure = plan?.measures.find(measure => measure.id === selected);
  const scale = plan?.scales[page] ?? null;
  const locked = readOnly || !ready || saving;
  const draftResult = tool && tool !== 'calibrate' && draft.length >= (tool === 'count' ? 1 : tool === 'length' ? 2 : 3)
    ? quantity(tool, draft, scale) : null;
  const lastPoint = draft.at(-1);
  const displacement = cursor && lastPoint && scale ? Math.hypot(cursor.x - lastPoint.x, cursor.y - lastPoint.y) * scale : null;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busy.current || draft.length) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft.length]);
  useEffect(() => {
    let alive = true;
    void readTakeoffs(storageKey).then(data => {
      if (!alive) return; setPlans(data); setActive(data.some(plan => plan.id === focusPlanId) ? focusPlanId! : data[0]?.id ?? ''); setPage(focusPage ?? 1); setSelected(focusMeasureId ?? ''); setReady(true); setStatus('Salvo neste navegador');
    }).catch(() => { if (alive) setError('Não foi possível acessar o armazenamento local. Recarregue para tentar novamente.'); });
    return () => { alive = false; };
  }, [storageKey, focusPlanId, focusPage, focusMeasureId]);
  async function commit(next: TakeoffPlan[], undo = false) {
    if (locked || busy.current) return false;
    busy.current = true; setSaving(true); setError(''); setStatus('Salvando…');
    try {
      await saveTakeoffs(storageKey, next);
      if (undo) history.current.pop(); else history.current = [...history.current.slice(-19), plans];
      setPlans(next);
      if (undo && !next.some(p => p.id === active)) { setActive(next[0]?.id ?? ''); setPage(1); }
      setStatus('Salvo neste navegador'); return true;
    } catch { setError('Não foi possível salvar. Seus dados anteriores foram preservados. Libere espaço e tente novamente.'); setStatus('Alteração não salva'); return false; }
    finally { busy.current = false; setSaving(false); }
  }
  const update = (next: TakeoffPlan) => commit(plans.map(p => p.id === next.id ? next : p));
  const reset = () => { setTool(null); setDraft([]); setDraftName(''); setPendingScale(undefined); };
  async function importFile(file?: File) {
    if (!file || locked) return;
    const extension = file.name.split('.').pop()?.toLowerCase();
    const kind = extension === 'pdf' ? 'pdf' : extension === 'dxf' ? 'dxf' : ['png', 'jpg', 'jpeg'].includes(extension ?? '') ? 'image' : null;
    if (!kind) { setError('Escolha PDF, PNG, JPG ou DXF. DWG e DWF ainda não estão disponíveis.'); return; }
    if (file.size > 100 * 1024 * 1024) { setError('Neste teste, o limite por arquivo é 100 MB.'); return; }
    const next: TakeoffPlan = { id: crypto.randomUUID(), name: file.name, floor: '', kind, file, scales: {}, measures: [] };
    if (!await commit([...plans, next])) return; setActive(next.id); setPage(1); setPages(1); reset();
  }
  async function finish() {
    if (!plan || !tool || tool === 'calibrate') return;
    const minimum = tool === 'count' ? 1 : tool === 'length' ? 2 : 3;
    if (draft.length < minimum) { setError(`Marque pelo menos ${minimum} pontos.`); return; }
    if (tool !== 'count' && !scale) return;
    if (tool === 'area' && !quantity('area', draft, scale)) { setError('O contorno deve ter área maior que zero.'); return; }
    const measure: TakeoffMeasure = { id: crypto.randomUUID(), page, name: draftName.trim() || `${labels[tool]} ${plan.measures.length + 1}`, kind: tool, points: draft };
    if (!await update({ ...plan, measures: [...plan.measures, measure] })) return;
    setSelected(measure.id); reset();
    if (embedded && onUseMeasure) {
      const result = quantity(measure.kind, measure.points, scale);
      if (result !== null) onUseMeasure(plan, measure, result);
    }
  }
  const fieldKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.currentTarget.value = event.currentTarget.defaultValue; event.currentTarget.blur(); }
    if (event.key === 'Enter') event.currentTarget.blur();
  };
  return <section className="mx-auto flex w-full max-w-[2100px] flex-col gap-1 bg-[#f5f6f7] p-1.5 text-slate-800 sm:p-2" aria-label="Levantamento em planta">
    <header className="flex min-w-0 flex-wrap items-center gap-2 border border-slate-300 bg-white px-3 py-1.5">
      <div className="mr-auto min-w-0">
        <div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold">Levantamento em planta</h1><span className="bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">Experimental</span></div>
        <p className="text-xs text-muted-foreground">{plan ? `${plan.name}${plan.floor ? ` • ${plan.floor}` : ''}` : 'Escolha uma planta para começar'}</p>
      </div>
      <span role="status" className="order-last w-full text-xs text-muted-foreground sm:order-none sm:w-auto">{status}</span>
      <label className={`inline-flex h-7 items-center gap-1.5 border border-slate-300 bg-slate-50 px-2 text-xs font-medium ${locked ? 'opacity-50' : 'cursor-pointer hover:bg-slate-100'}`}><FileUp className="h-3.5 w-3.5" />Adicionar planta<input aria-label="Adicionar planta" className="sr-only" type="file" accept=".pdf,.png,.jpg,.jpeg,.dxf" disabled={locked} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
      <Button title="Desfazer a última alteração desta sessão" aria-label="Desfazer" variant="outline" size="sm" className="h-7 rounded-none text-xs" disabled={locked || !history.current.length} onClick={() => { const previous = history.current.at(-1); if (previous) { void commit(previous, true); reset(); } }}><Undo2 className="h-3.5 w-3.5" /><span className="hidden sm:inline">Desfazer</span></Button>
    </header>
    {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}
    {!plans.length && ready && <div className="rounded border border-dashed bg-card p-10 text-center text-muted-foreground">Adicione uma planta para começar. PDF, imagem ou DXF 2D.</div>}
    {!!plans.length && plan && <div className="flex min-w-0 flex-col gap-1">
        <div role="toolbar" aria-label="Ferramentas de levantamento" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 border border-slate-300 bg-[#e9ecef] px-1.5 py-1 text-xs xl:flex-nowrap">
          <div className="flex min-w-0 items-center gap-1 border-r border-slate-300 pr-2 tabular-nums" aria-label="Informações do cursor e da medição">
            <span className="hidden whitespace-nowrap text-slate-600 sm:inline" title="Coordenadas do cursor em unidades do desenho">{cursor ? `X ${format(cursor.x)} · Y ${format(cursor.y)}` : 'X — · Y —'}</span>
            {displacement !== null && <span className="whitespace-nowrap text-slate-600" title="Distância do último ponto ao cursor">Δ {format(displacement)} m</span>}
            {draftResult !== null && tool && tool !== 'calibrate' && <span className="whitespace-nowrap font-medium" title="Resultado do traçado">{tool === 'length' ? 'C' : tool === 'area' ? 'A' : 'Q'} {format(draftResult)} {units[tool]}</span>}
            <span className="whitespace-nowrap text-slate-600">{scale ? `${format(scale)} m/unid.` : 'Escala pendente'}</span>
          </div>
          <div className="flex items-center gap-0.5 border-r border-slate-300 pr-1" aria-label="Navegação">
            <Button title="Ampliar" aria-label="Ampliar" variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => canvas.current?.zoomIn()}><ZoomIn className="h-4 w-4" /></Button>
            <Button title="Reduzir" aria-label="Reduzir" variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => canvas.current?.zoomOut()}><ZoomOut className="h-4 w-4" /></Button>
            <Button title="Enquadrar desenho" aria-label="Enquadrar desenho" variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => canvas.current?.fit()}><Maximize2 className="h-4 w-4" /></Button>
            <Button title="Selecionar marcação ou deslocar a vista" aria-label="Deslocar vista" aria-pressed={!tool} variant="ghost" size="icon" className={`h-7 w-7 rounded-none ${!tool ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-400' : ''}`} onClick={reset}><MousePointer2 className="h-4 w-4" /></Button>
          </div>
          <div className="flex items-center gap-0.5 border-r border-slate-300 pr-1" aria-label="Levantamento">
            {(['count', 'length', 'area'] as const).map(kind => { const Icon = kind === 'count' ? CircleDot : kind === 'length' ? Ruler : Shapes; return <Button key={kind} title={labels[kind]} aria-label={labels[kind]} aria-pressed={tool === kind} variant="ghost" size="icon" className={`h-7 w-7 rounded-none ${tool === kind ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-400' : ''}`} disabled={locked || !allowedKinds.includes(kind) || kind !== 'count' && !scale} onClick={() => { setError(''); setDraft([]); setDraftName(''); setTool(kind); setPendingScale(undefined); }}><Icon className="h-4 w-4" /></Button>; })}
            <Button title="Calibrar escala" aria-label="Calibrar escala" aria-pressed={tool === 'calibrate'} variant="ghost" size="icon" className={`h-7 w-7 rounded-none ${tool === 'calibrate' ? 'bg-sky-100 text-sky-900 ring-1 ring-sky-400' : ''}`} disabled={locked} onClick={() => { setError(''); setTool('calibrate'); setDraft([]); setPendingScale(undefined); }}><Crosshair className="h-4 w-4" /></Button>
          </div>
          <div className="flex min-w-0 items-center gap-1 border-r border-slate-300 pr-2" aria-label="Desenho">
            <select aria-label="Planta" title="Selecionar planta" className="h-7 max-w-[190px] border border-slate-300 bg-white px-1 text-xs" value={active} onChange={e => { setActive(e.target.value); setPage(1); setPages(1); setSelected(''); reset(); }}>{plans.map(p => <option key={p.id} value={p.id}>{p.name}{p.floor ? ` · ${p.floor}` : ''}</option>)}</select>
            {plan.kind === 'pdf' && <select aria-label="Página" title="Página do PDF" className="h-7 border border-slate-300 bg-white px-1 text-xs" value={page} onChange={e => { setPage(Number(e.target.value)); reset(); setSelected(''); }}>{Array.from({ length: pages }, (_, i) => <option key={i} value={i + 1}>Pág. {i + 1}</option>)}</select>}
            {plan.kind === 'dxf' && <details className="relative"><summary className="flex h-7 cursor-pointer list-none items-center gap-1 border border-slate-300 bg-white px-1.5" title="Visibilidade dos layers"><Layers3 className="h-4 w-4" />Layers ({canvasLayers.length})</summary><div className="absolute left-0 top-7 z-30 max-h-60 w-60 overflow-auto border border-slate-300 bg-white p-2 shadow-md">{canvasLayers.map(name => <label key={name} className="flex items-center gap-2 py-1 text-xs"><input type="checkbox" checked={!hiddenLayers.includes(name)} onChange={e => canvas.current?.toggleLayer(name, e.target.checked)} />{name}</label>)}</div></details>}
            <Button title="Configurações da planta" aria-label="Configurações da planta" aria-expanded={showSettings} variant="ghost" size="icon" className="h-7 w-7 rounded-none" onClick={() => setShowSettings(v => !v)}><Settings2 className="h-4 w-4" /></Button>
          </div>
          <div className="flex min-w-0 items-center gap-1" aria-label="Quantitativo">
            {embedded && selectedMeasure && !tool ? <Input key={`${selectedMeasure.id}-${selectedMeasure.name}`} aria-label="Renomear marcação selecionada" title="Renomear marcação selecionada" className="h-7 w-32 rounded-none border-slate-300 bg-white px-1.5 text-xs" defaultValue={selectedMeasure.name} disabled={locked} onKeyDown={fieldKey} onBlur={e => { const name = e.target.value.trim(); if (name && name !== selectedMeasure.name) void update({ ...plan, measures: plan.measures.map(measure => measure.id === selectedMeasure.id ? { ...measure, name } : measure) }); }} /> : <Input aria-label="Nome do levantamento" title="Nome do levantamento em curso" className="h-7 w-32 rounded-none border-slate-300 bg-white px-1.5 text-xs" placeholder="Nome do item" value={draftName} disabled={!tool || tool === 'calibrate' || locked} onChange={e => setDraftName(e.target.value)} />}
            <Button title="Concluir traçado" aria-label="Concluir traçado" variant="ghost" size="icon" className="h-7 w-7 rounded-none" disabled={locked || !tool || tool === 'calibrate'} onClick={finish}><Check className="h-4 w-4" /></Button>
            <Button title="Cancelar traçado" aria-label="Cancelar traçado" variant="ghost" size="icon" className="h-7 w-7 rounded-none" disabled={!tool} onClick={reset}><X className="h-4 w-4" /></Button>
            {embedded && onUseMeasure && selectedMeasure && !tool && <Button title="Usar a marcação selecionada na célula escolhida" aria-label="Usar marcação selecionada" variant="outline" size="sm" className="h-7 rounded-none px-2 text-xs" disabled={locked || quantity(selectedMeasure.kind, selectedMeasure.points, plan.scales[selectedMeasure.page] ?? null) === null} onClick={() => { const result = quantity(selectedMeasure.kind, selectedMeasure.points, plan.scales[selectedMeasure.page] ?? null); if (result !== null) onUseMeasure(plan, selectedMeasure, result); }}>Usar {format(quantity(selectedMeasure.kind, selectedMeasure.points, plan.scales[selectedMeasure.page] ?? null))} {units[selectedMeasure.kind]}</Button>}
            {embedded && selectedMeasure && !tool && <Button title="Excluir marcação selecionada" aria-label="Excluir marcação selecionada" variant="ghost" size="icon" className="h-7 w-7 rounded-none text-red-700" disabled={locked} onClick={async () => { if (await update({ ...plan, measures: plan.measures.filter(measure => measure.id !== selectedMeasure.id) })) setSelected(''); }}><Trash2 className="h-4 w-4" /></Button>}
          </div>
        </div>
        {showSettings && <div className="flex flex-wrap items-end gap-2 border border-slate-300 bg-white p-2 text-xs">
          <label className="min-w-[180px] flex-1">Nome da planta<Input className="h-7 rounded-none text-xs" onKeyDown={fieldKey} key={`${plan.id}-name-${plan.name}`} defaultValue={plan.name} disabled={locked} onBlur={e => { const name = e.target.value.trim(); if (name && name !== plan.name) void update({ ...plan, name }); }} /></label>
          <label className="min-w-[140px]">Pavimento<Input className="h-7 rounded-none text-xs" onKeyDown={fieldKey} key={`${plan.id}-floor-${plan.floor}`} defaultValue={plan.floor} disabled={locked} placeholder="Ex.: Térreo" onBlur={e => { if (e.target.value !== plan.floor) void update({ ...plan, floor: e.target.value }); }} /></label>
          {plan.kind === 'dxf' && <label>Unidade do DXF<select aria-label="Unidade do DXF" className="block h-7 border border-slate-300 bg-white px-2" value={cadUnit} disabled={locked} onChange={e => setCadUnit(e.target.value)}><option value="1">Metro</option><option value="0.01">Centímetro</option><option value="0.001">Milímetro</option></select></label>}
          {plan.kind === 'dxf' && <Button size="sm" variant="outline" className="h-7 rounded-none text-xs" disabled={locked} onClick={() => setPendingScale(Number(cadUnit))}>Conferir unidade</Button>}
          <p className="basis-full text-xs text-muted-foreground">Arquivos e marcações ficam neste navegador, por usuário e obra. {plan.kind === 'dxf' ? 'DXF 2D usa o espaço de modelo; confira textos e entidades especiais antes de medir.' : embedded ? 'Concluir o traçado preenche a célula escolhida; confirme o total no lançamento do dia.' : 'Não lançam produção ou medição.'}</p>
        </div>}
        {tool && <div className="flex min-h-8 flex-wrap items-center gap-2 border-x border-b border-slate-300 bg-[#f2f3f4] px-2 py-0.5 text-xs">
          <strong>{tool === 'calibrate' ? 'Calibrar escala' : labels[tool]}</strong>
          <span className="text-slate-500">{draft.length} ponto{draft.length === 1 ? '' : 's'}</span>
          {tool === 'calibrate' && <><Input aria-label="Distância conhecida em metros" className="h-7 w-36 rounded-none text-xs" placeholder="Distância em metros" value={distance} onChange={e => setDistance(e.target.value)} /><Button size="sm" className="h-7 rounded-none text-xs" disabled={locked || draft.length !== 2} onClick={() => { try { setPendingScale(calibration(draft, Number(distance.replace(',', '.')))); setError(''); } catch (e) { setError((e as Error).message); } }}>Conferir escala</Button></>}
          <Button size="sm" variant="ghost" className="h-7 rounded-none text-xs" disabled={!draft.length} onClick={() => setDraft(d => d.slice(0, -1))}><Undo2 className="h-3.5 w-3.5" />Retirar último ponto</Button>
        </div>}
        {pendingScale !== undefined && <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-slate-900"><p>Nova escala: {pendingScale.toLocaleString('pt-BR', { maximumSignificantDigits: 8 })} m por unidade do desenho. {plan.measures.filter(m => m.page === page && m.kind !== 'count').length} medidas desta página serão recalculadas.</p>{plan.measures.filter(m => m.page === page && m.kind !== 'count').map(m => <p key={m.id}>{m.name}: {format(quantity(m.kind, m.points, scale))} → {format(quantity(m.kind, m.points, pendingScale))} {units[m.kind]}</p>)}<Button size="sm" disabled={locked} onClick={async () => { if (await update({ ...plan, scales: { ...plan.scales, [page]: pendingScale } })) reset(); }}>Confirmar escala</Button> <Button size="sm" variant="outline" onClick={() => setPendingScale(undefined)}>Voltar</Button></div>}
        <PlanCanvas ref={canvas} plan={plan} page={page} draft={draft} drawing={!!tool && !locked} selected={selected} readOnly={locked} executedMeasureIds={executedMeasureIds} onPages={setPages} onCursor={setCursor} onLayers={receiveLayers} onPoint={p => setDraft(d => tool === 'calibrate' && d.length >= 2 ? [p] : [...d, p])} onSelect={setSelected} onMove={(id, index, point) => { void update({ ...plan, measures: plan.measures.map(m => m.id === id ? { ...m, points: m.points.map((p, i) => i === index ? point : p) } : m) }); }} />
        <div role="status" className="flex min-h-7 items-center gap-2 border border-slate-300 bg-[#e9ecef] px-2 text-xs text-slate-700"><strong>{tool === 'calibrate' ? 'Calibração' : tool ? labels[tool] : 'Navegação'}</strong><span className="border-l border-slate-400 pl-2">{tool === 'calibrate' ? 'Marque dois pontos e informe a distância conhecida.' : tool ? 'Clique para marcar pontos; conclua ou cancele na barra superior.' : embedded ? selectedMeasure ? `Marcação ${selectedMeasure.name} selecionada; use o resultado na barra superior.` : 'Clique numa marcação existente para usá-la na célula, ou inicie uma nova contagem.' : 'Arraste para deslocar a vista; use a roda do mouse para zoom.'}</span></div>
        {!embedded && <section className="min-w-0 overflow-hidden border border-slate-300 bg-white" aria-label="Detalhe dos levantamentos">
          <button className="flex w-full items-center gap-2 border-b border-slate-300 bg-[#e9ecef] px-2 py-1 text-left text-xs font-semibold hover:bg-slate-100" onClick={() => setShowDetails(v => !v)} aria-expanded={showDetails}>{showDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}Detalhe dos levantamentos <span className="ml-auto text-xs font-normal">{plan.measures.length} {plan.measures.length === 1 ? 'registro' : 'registros'}</span></button>
          {showDetails && <div className="h-52 min-h-36 max-h-[55vh] resize-y overflow-auto">
            <table className="w-full min-w-[600px] text-xs"><thead className="sticky top-0 z-10 bg-[#f1f2f3]"><tr><th className="border-r border-slate-300 px-2 py-1 text-left">Nome</th><th className="border-r border-slate-300 px-2 py-1 text-left">Página</th><th className="border-r border-slate-300 px-2 py-1 text-left">Tipo</th><th className="border-r border-slate-300 px-2 py-1 text-right">Resultado</th><th className="px-2 py-1 text-right">Ações</th></tr></thead><tbody>{plan.measures.map(m => <tr key={m.id} className={`cursor-pointer border-t border-slate-200 ${selected === m.id ? 'bg-sky-100 text-slate-900' : 'hover:bg-slate-50'}`} onClick={() => { setSelected(m.id); if (m.page !== page) { setPage(m.page); reset(); } }}><td className="min-w-48 px-2 py-0.5"><Input className="h-7 rounded-none text-xs" onKeyDown={fieldKey} aria-label={`Nome de ${m.name}`} key={`${m.id}-${m.name}`} defaultValue={m.name} disabled={locked} onBlur={e => { const name = e.target.value.trim(); if (name && name !== m.name) void update({ ...plan, measures: plan.measures.map(row => row.id === m.id ? { ...row, name } : row) }); }} /></td><td className="px-2 py-0.5">{m.page}</td><td className="px-2 py-0.5">{labels[m.kind]}</td><td className="whitespace-nowrap px-2 py-0.5 text-right tabular-nums">{format(quantity(m.kind, m.points, plan.scales[m.page] ?? null))} {units[m.kind]}</td><td className="px-2 py-0.5 text-right"><div className="flex justify-end gap-1">{onUseMeasure && <Button size="sm" variant="outline" className="h-7 text-xs" disabled={readOnly || quantity(m.kind, m.points, plan.scales[m.page] ?? null) === null} onClick={e => { e.stopPropagation(); const result = quantity(m.kind, m.points, plan.scales[m.page] ?? null); if (result !== null) onUseMeasure(plan, m, result); }}>Usar no detalhe</Button>}<Button size="sm" variant="ghost" className="h-7 text-xs" disabled={locked} onClick={e => { e.stopPropagation(); void update({ ...plan, measures: plan.measures.filter(row => row.id !== m.id) }); }}>Excluir</Button></div></td></tr>)}</tbody></table>{!plan.measures.length && <p className="p-3 text-xs text-muted-foreground">Nenhum levantamento nesta planta.</p>}
          </div>}
        </section>}
    </div>}
  </section>;
}
