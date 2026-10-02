import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, ChevronDown, ChevronUp, CircleDot, Crosshair, FileUp, FolderOpen, MousePointer2, PanelLeftClose, PanelLeftOpen, Ruler, Settings2, Shapes, Undo2, X } from 'lucide-react';
import { calibration, quantity, readTakeoffs, saveTakeoffs, type MeasureKind, type Point, type TakeoffPlan } from '@/lib/planTakeoff';
import PlanCanvas from './PlanCanvas';

const labels = { count: 'Contagem', length: 'Comprimento', area: 'Área' };
const units = { count: 'un', length: 'm', area: 'm²' };
const format = (value: number | null) => value === null ? 'Escala pendente' : value.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
export default function PlanTakeoff({ storageKey, readOnly }: { storageKey: string; readOnly: boolean }) {
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
  const [showPlans, setShowPlans] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const history = useRef<TakeoffPlan[][]>([]);
  const busy = useRef(false);
  const plan = plans.find(p => p.id === active);
  const scale = plan?.scales[page] ?? null;
  const locked = readOnly || !ready || saving;
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
      if (!alive) return; setPlans(data); setActive(data[0]?.id ?? ''); setReady(true); setStatus('Salvo neste navegador');
    }).catch(() => { if (alive) setError('Não foi possível acessar o armazenamento local. Recarregue para tentar novamente.'); });
    return () => { alive = false; };
  }, [storageKey]);
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
  const reset = () => { setTool(null); setDraft([]); setPendingScale(undefined); };
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
    const id = crypto.randomUUID();
    if (!await update({ ...plan, measures: [...plan.measures, { id, page, name: `${labels[tool]} ${plan.measures.length + 1}`, kind: tool, points: draft }] })) return;
    setSelected(id); reset();
  }
  const fieldKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.currentTarget.value = event.currentTarget.defaultValue; event.currentTarget.blur(); }
    if (event.key === 'Enter') event.currentTarget.blur();
  };
  return <section className="mx-auto flex w-full max-w-[1900px] flex-col gap-2 p-2 sm:p-3" aria-label="Levantamento em planta">
    <header className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm">
      <div className="mr-auto min-w-0">
        <div className="flex items-center gap-2"><h1 className="truncate text-base font-semibold sm:text-lg">Levantamento em planta</h1><span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Experimental</span></div>
        <p className="text-xs text-muted-foreground">{plan ? `${plan.name}${plan.floor ? ` • ${plan.floor}` : ''}` : 'Escolha uma planta para começar'}</p>
      </div>
      <span role="status" className="order-last w-full text-xs text-muted-foreground sm:order-none sm:w-auto">{status}</span>
      <label className={`inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium ${locked ? 'opacity-50' : 'cursor-pointer hover:bg-muted'}`}><FileUp className="h-4 w-4" />Adicionar planta<input aria-label="Adicionar planta" className="sr-only" type="file" accept=".pdf,.png,.jpg,.jpeg,.dxf" disabled={locked} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
      <Button title="Desfazer a última alteração desta sessão" aria-label="Desfazer" variant="outline" size="sm" disabled={locked || !history.current.length} onClick={() => { const previous = history.current.at(-1); if (previous) { void commit(previous, true); reset(); } }}><Undo2 className="h-4 w-4" /><span className="hidden sm:inline">Desfazer</span></Button>
    </header>
    {error && <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">{error}</p>}
    {!plans.length && ready && <div className="rounded border border-dashed bg-card p-10 text-center text-muted-foreground">Adicione uma planta para começar. PDF, imagem ou DXF 2D.</div>}
    {!!plans.length && <div className={`grid min-w-0 gap-2 ${showPlans ? 'md:grid-cols-[210px_minmax(0,1fr)]' : ''}`}>
      {showPlans && <aside aria-label="Plantas e pavimentos" className="min-w-0 rounded-lg border bg-card p-2">
        <div className="mb-2 hidden items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:flex"><FolderOpen className="h-4 w-4" />Plantas e pavimentos</div>
        <div className="flex gap-2 overflow-x-auto pb-1 md:max-h-[calc(100vh-175px)] md:flex-col md:overflow-y-auto md:overflow-x-hidden">
          {plans.map(p => <button key={p.id} className={`min-w-[155px] rounded-md border px-3 py-2 text-left text-sm md:min-w-0 ${p.id === active ? 'border-primary bg-primary/10 text-foreground' : 'hover:bg-muted'}`} onClick={() => { setActive(p.id); setPage(1); setPages(1); setSelected(''); reset(); }}><strong className="block truncate" title={p.name}>{p.name}</strong><span className="block truncate text-xs text-muted-foreground">{p.floor || 'Pavimento não informado'}</span></button>)}
        </div>
      </aside>}
      {plan && <div className="flex min-w-0 flex-col gap-2">
        <div role="toolbar" aria-label="Ferramentas de levantamento" className="flex min-w-0 flex-wrap items-center gap-1 rounded-lg border bg-card px-2 py-1.5 shadow-sm">
          <Button title={showPlans ? 'Ocultar plantas' : 'Mostrar plantas'} aria-label={showPlans ? 'Ocultar plantas' : 'Mostrar plantas'} size="icon" variant="ghost" className="h-8 w-8" onClick={() => setShowPlans(v => !v)}>{showPlans ? <PanelLeftClose /> : <PanelLeftOpen />}</Button>
          <span className="mx-1 h-6 border-l" aria-hidden="true" />
          <Button title="Selecionar marcação ou mover a vista" aria-label="Selecionar / mover vista" aria-pressed={!tool} size="icon" variant={!tool ? 'default' : 'ghost'} className="h-8 w-8" onClick={reset}><MousePointer2 /></Button>
          {(['count', 'length', 'area'] as const).map(kind => {
            const Icon = kind === 'count' ? CircleDot : kind === 'length' ? Ruler : Shapes;
            return <Button key={kind} title={labels[kind]} aria-label={labels[kind]} aria-pressed={tool === kind} size="icon" variant={tool === kind ? 'default' : 'ghost'} className="h-8 w-8" disabled={locked || kind !== 'count' && !scale} onClick={() => { setError(''); setDraft([]); setTool(kind); setPendingScale(undefined); }}><Icon /></Button>;
          })}
          <span className="mx-1 h-6 border-l" aria-hidden="true" />
          <Button title="Calibrar escala por distância conhecida" aria-label="Calibrar escala" aria-pressed={tool === 'calibrate'} size="icon" variant={tool === 'calibrate' ? 'default' : 'ghost'} className="h-8 w-8" disabled={locked} onClick={() => { setError(''); setTool('calibrate'); setDraft([]); setPendingScale(undefined); }}><Crosshair /></Button>
          <Button title="Configurações da planta" aria-label="Configurações da planta" aria-expanded={showSettings} size="icon" variant={showSettings ? 'secondary' : 'ghost'} className="h-8 w-8" onClick={() => setShowSettings(v => !v)}><Settings2 /></Button>
          <span className="ml-auto rounded px-2 py-1 text-xs font-medium text-muted-foreground">{scale ? 'Escala confirmada' : 'Escala pendente'}</span>
          {plan.kind === 'pdf' && <label className="flex items-center gap-1 text-xs">Página<select aria-label="Página" className="h-8 rounded border bg-background px-2" value={page} onChange={e => { setPage(Number(e.target.value)); reset(); setSelected(''); }}>{Array.from({ length: pages }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>}
        </div>
        {showSettings && <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3 text-sm">
          <label className="min-w-[180px] flex-1 text-xs">Nome da planta<Input onKeyDown={fieldKey} key={`${plan.id}-name-${plan.name}`} defaultValue={plan.name} disabled={locked} onBlur={e => { const name = e.target.value.trim(); if (name && name !== plan.name) void update({ ...plan, name }); }} /></label>
          <label className="min-w-[140px] text-xs">Pavimento<Input onKeyDown={fieldKey} key={`${plan.id}-floor-${plan.floor}`} defaultValue={plan.floor} disabled={locked} placeholder="Ex.: Térreo" onBlur={e => { if (e.target.value !== plan.floor) void update({ ...plan, floor: e.target.value }); }} /></label>
          {plan.kind === 'dxf' && <label className="text-xs">Unidade do DXF<select aria-label="Unidade do DXF" className="block h-10 rounded border bg-background px-2" value={cadUnit} disabled={locked} onChange={e => setCadUnit(e.target.value)}><option value="1">Metro</option><option value="0.01">Centímetro</option><option value="0.001">Milímetro</option></select></label>}
          {plan.kind === 'dxf' && <Button size="sm" variant="outline" disabled={locked} onClick={() => setPendingScale(Number(cadUnit))}>Conferir unidade</Button>}
          <p className="basis-full text-xs text-muted-foreground">Arquivos e marcações ficam neste navegador, por usuário e obra. {plan.kind === 'dxf' ? 'DXF 2D usa o espaço de modelo; confira textos e entidades especiais antes de medir.' : 'Não lançam produção ou medição.'}</p>
        </div>}
        {tool && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <strong className="text-primary">{tool === 'calibrate' ? 'Calibrar escala' : labels[tool]}</strong>
          <span className="text-muted-foreground">{tool === 'calibrate' ? 'Marque dois pontos com distância conhecida.' : 'Clique na planta para marcar pontos.'} ({draft.length} pontos)</span>
          {tool === 'calibrate' ? <><Input aria-label="Distância conhecida em metros" className="h-8 w-40" placeholder="Distância em metros" value={distance} onChange={e => setDistance(e.target.value)} /><Button size="sm" disabled={locked || draft.length !== 2} onClick={() => { try { setPendingScale(calibration(draft, Number(distance.replace(',', '.')))); setError(''); } catch (e) { setError((e as Error).message); } }}>Conferir escala</Button></> : <Button size="sm" disabled={locked} onClick={finish}><Check />Concluir traçado</Button>}
          <Button size="sm" variant="outline" onClick={() => setDraft(d => d.slice(0, -1))}><Undo2 />Retirar último ponto</Button><Button size="sm" variant="ghost" onClick={reset}><X />Cancelar</Button>
        </div>}
        {pendingScale !== undefined && <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-slate-900"><p>Nova escala: {pendingScale.toLocaleString('pt-BR', { maximumSignificantDigits: 8 })} m por unidade do desenho. {plan.measures.filter(m => m.page === page && m.kind !== 'count').length} medidas desta página serão recalculadas.</p>{plan.measures.filter(m => m.page === page && m.kind !== 'count').map(m => <p key={m.id}>{m.name}: {format(quantity(m.kind, m.points, scale))} → {format(quantity(m.kind, m.points, pendingScale))} {units[m.kind]}</p>)}<Button size="sm" disabled={locked} onClick={async () => { if (await update({ ...plan, scales: { ...plan.scales, [page]: pendingScale } })) reset(); }}>Confirmar escala</Button> <Button size="sm" variant="outline" onClick={() => setPendingScale(undefined)}>Voltar</Button></div>}
        <PlanCanvas plan={plan} page={page} draft={draft} drawing={!!tool && !locked} selected={selected} readOnly={locked} onPages={setPages} onPoint={p => setDraft(d => tool === 'calibrate' && d.length >= 2 ? [p] : [...d, p])} onSelect={setSelected} onMove={(id, index, point) => { void update({ ...plan, measures: plan.measures.map(m => m.id === id ? { ...m, points: m.points.map((p, i) => i === index ? point : p) } : m) }); }} />
        <section className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label="Detalhe dos levantamentos">
          <button className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm font-semibold hover:bg-muted" onClick={() => setShowDetails(v => !v)} aria-expanded={showDetails}>{showDetails ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}Detalhe dos levantamentos <span className="ml-auto rounded bg-muted px-2 py-0.5 text-xs font-normal">{plan.measures.length} registros</span></button>
          {showDetails && <div className="h-52 min-h-36 max-h-[55vh] resize-y overflow-auto">
            <table className="w-full min-w-[600px] text-sm"><thead className="sticky top-0 z-10 bg-muted"><tr><th className="p-2 text-left">Nome</th><th className="p-2 text-left">Página</th><th className="p-2 text-left">Tipo</th><th className="p-2 text-right">Resultado</th><th className="p-2 text-right">Ações</th></tr></thead><tbody>{plan.measures.map(m => <tr key={m.id} className={`cursor-pointer border-t ${selected === m.id ? 'bg-amber-50 text-slate-900' : 'hover:bg-muted/50'}`} onClick={() => { setSelected(m.id); if (m.page !== page) { setPage(m.page); reset(); } }}><td className="min-w-48 p-2"><Input onKeyDown={fieldKey} aria-label={`Nome de ${m.name}`} key={`${m.id}-${m.name}`} defaultValue={m.name} disabled={locked} onBlur={e => { const name = e.target.value.trim(); if (name && name !== m.name) void update({ ...plan, measures: plan.measures.map(row => row.id === m.id ? { ...row, name } : row) }); }} /></td><td className="p-2">{m.page}</td><td className="p-2">{labels[m.kind]}</td><td className="whitespace-nowrap p-2 text-right tabular-nums">{format(quantity(m.kind, m.points, plan.scales[m.page] ?? null))} {units[m.kind]}</td><td className="p-2 text-right"><Button size="sm" variant="ghost" disabled={locked} onClick={e => { e.stopPropagation(); void update({ ...plan, measures: plan.measures.filter(row => row.id !== m.id) }); }}>Excluir</Button></td></tr>)}</tbody></table>{!plan.measures.length && <p className="p-4 text-sm text-muted-foreground">Nenhum levantamento nesta planta.</p>}
          </div>}
        </section>
      </div>}
    </div>}
  </section>;
}
