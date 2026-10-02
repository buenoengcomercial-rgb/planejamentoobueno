import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  return <section className="space-y-4 p-3 sm:p-5">
    <header><div className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold">Levantamento em planta</h1><span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">Experimental</span></div><p className="mt-1 text-sm text-muted-foreground">Arquivos e marcações ficam neste navegador, por usuário e obra. Não lançam produção ou medição. Limpar os dados do navegador remove este teste.</p></header>
    <div className="flex flex-wrap items-center gap-3">
      <label className={`rounded border px-3 py-2 text-sm ${locked ? 'opacity-50' : 'cursor-pointer hover:bg-muted'}`}>Adicionar planta<input aria-label="Adicionar planta" className="sr-only" type="file" accept=".pdf,.png,.jpg,.jpeg,.dxf" disabled={locked} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
      <span role="status" className="text-xs text-muted-foreground">{status}</span>
      <Button variant="outline" size="sm" disabled={locked || !history.current.length} onClick={() => { const previous = history.current.at(-1); if (previous) { void commit(previous, true); reset(); } }}>Desfazer</Button>
    </div>
    {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">{error}</p>}
    {!plans.length && ready && <div className="rounded border border-dashed p-10 text-center text-muted-foreground">Adicione uma planta para começar. PDF, imagem ou DXF 2D.</div>}
    {!!plans.length && <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
      <aside className="space-y-2"><h2 className="font-medium">Plantas e pavimentos</h2>{plans.map(p => <button key={p.id} className={`block w-full break-words rounded border p-3 text-left text-sm ${p.id === active ? 'border-primary bg-primary/5' : ''}`} onClick={() => { setActive(p.id); setPage(1); setPages(1); setSelected(''); reset(); }}><strong>{p.name}</strong><div className="text-muted-foreground">{p.floor || 'Pavimento não informado'}</div></button>)}</aside>
      {plan && <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap gap-2">
          <label className="min-w-40 flex-1 text-xs">Nome da planta<Input onKeyDown={fieldKey} key={`${plan.id}-name-${plan.name}`} defaultValue={plan.name} disabled={locked} onBlur={e => { const name = e.target.value.trim(); if (name && name !== plan.name) void update({ ...plan, name }); }} /></label>
          <label className="text-xs">Pavimento<Input onKeyDown={fieldKey} key={`${plan.id}-floor-${plan.floor}`} defaultValue={plan.floor} disabled={locked} placeholder="Ex.: Térreo" onBlur={e => { if (e.target.value !== plan.floor) void update({ ...plan, floor: e.target.value }); }} /></label>
          {plan.kind === 'pdf' && <label className="text-xs">Página<select aria-label="Página" className="block rounded border bg-background p-2" value={page} onChange={e => { setPage(Number(e.target.value)); reset(); setSelected(''); }}>{Array.from({ length: pages }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>}
        </div>
        {plan.kind === 'dxf' && <p className="text-xs text-muted-foreground">DXF 2D • espaço de modelo. Textos, estilos e entidades especiais podem diferir do CAD original. Confira a planta antes de medir; captura automática de pontos ainda não está disponível.</p>}
        <div className="flex flex-wrap items-center gap-2 rounded border p-2">
          <Button size="sm" variant={!tool ? 'default' : 'outline'} onClick={reset}>Selecionar / mover vista</Button>
          {(['count', 'length', 'area'] as const).map(kind => <Button key={kind} size="sm" variant={tool === kind ? 'default' : 'outline'} disabled={locked || kind !== 'count' && !scale} onClick={() => { setDraft([]); setTool(kind); setPendingScale(undefined); }}>{labels[kind]}</Button>)}
          <Button size="sm" variant="outline" disabled={locked} onClick={() => { setTool('calibrate'); setDraft([]); setPendingScale(undefined); }}>Calibrar escala</Button>
          <span className="text-xs">{scale ? 'Escala confirmada' : 'Confirme a escala para medir'}</span>
        </div>
        {plan.kind === 'dxf' && <div className="flex flex-wrap items-center gap-2 text-sm"><label>Unidade do DXF <select aria-label="Unidade do DXF" className="rounded border bg-background p-2" value={cadUnit} disabled={locked} onChange={e => setCadUnit(e.target.value)}><option value="1">Metro</option><option value="0.01">Centímetro</option><option value="0.001">Milímetro</option></select></label><Button size="sm" variant="outline" disabled={locked} onClick={() => setPendingScale(Number(cadUnit))}>Conferir unidade</Button></div>}
        {tool && <div className="flex flex-wrap items-center gap-2 rounded bg-muted p-3 text-sm"><span>{tool === 'calibrate' ? 'Marque dois pontos com distância conhecida.' : `${labels[tool]}: clique na planta para marcar pontos.`} ({draft.length} pontos)</span>{tool === 'calibrate' ? <><Input aria-label="Distância conhecida em metros" className="w-40" placeholder="Distância em metros" value={distance} onChange={e => setDistance(e.target.value)} /><Button size="sm" disabled={locked || draft.length !== 2} onClick={() => { try { setPendingScale(calibration(draft, Number(distance.replace(',', '.')))); } catch (e) { setError((e as Error).message); } }}>Conferir escala</Button></> : <Button size="sm" disabled={locked} onClick={finish}>Concluir traçado</Button>}<Button size="sm" variant="outline" onClick={() => setDraft(d => d.slice(0, -1))}>Retirar último ponto</Button><Button size="sm" variant="outline" onClick={reset}>Cancelar</Button></div>}
        {pendingScale !== undefined && <div className="space-y-2 rounded border border-amber-300 p-3 text-sm"><p>Nova escala: {pendingScale.toLocaleString('pt-BR', { maximumSignificantDigits: 8 })} m por unidade do desenho. {plan.measures.filter(m => m.page === page && m.kind !== 'count').length} medidas desta página serão recalculadas.</p>{plan.measures.filter(m => m.page === page && m.kind !== 'count').map(m => <p key={m.id}>{m.name}: {format(quantity(m.kind, m.points, scale))} → {format(quantity(m.kind, m.points, pendingScale))} {units[m.kind]}</p>)}<Button size="sm" disabled={locked} onClick={async () => { if (await update({ ...plan, scales: { ...plan.scales, [page]: pendingScale } })) reset(); }}>Confirmar escala</Button> <Button size="sm" variant="outline" onClick={() => setPendingScale(undefined)}>Voltar</Button></div>}
        <PlanCanvas plan={plan} page={page} draft={draft} drawing={!!tool && !locked} selected={selected} readOnly={locked} onPages={setPages} onPoint={p => setDraft(d => tool === 'calibrate' && d.length >= 2 ? [p] : [...d, p])} onSelect={setSelected} onMove={(id, index, point) => { void update({ ...plan, measures: plan.measures.map(m => m.id === id ? { ...m, points: m.points.map((p, i) => i === index ? point : p) } : m) }); }} />
        <h2 className="font-medium">Detalhe dos levantamentos</h2><p className="text-xs text-muted-foreground">Selecione uma linha para destacar a marcação. No modo Selecionar, arraste seus pontos para corrigir.</p>
        <div className="overflow-x-auto rounded border"><table className="w-full text-sm"><thead className="bg-muted"><tr>{['Nome', 'Página', 'Tipo', 'Resultado', 'Ações'].map(h => <th key={h} className="p-2 text-left">{h}</th>)}</tr></thead><tbody>{plan.measures.map(m => <tr key={m.id} className={`cursor-pointer border-t ${selected === m.id ? 'bg-amber-50 text-slate-900' : ''}`} onClick={() => { setSelected(m.id); if (m.page !== page) { setPage(m.page); reset(); } }}><td className="p-2"><Input onKeyDown={fieldKey} aria-label={`Nome de ${m.name}`} key={`${m.id}-${m.name}`} defaultValue={m.name} disabled={locked} onBlur={e => { const name = e.target.value.trim(); if (name && name !== m.name) void update({ ...plan, measures: plan.measures.map(row => row.id === m.id ? { ...row, name } : row) }); }} /></td><td className="p-2">{m.page}</td><td className="p-2">{labels[m.kind]}</td><td className="whitespace-nowrap p-2 tabular-nums">{format(quantity(m.kind, m.points, plan.scales[m.page] ?? null))} {units[m.kind]}</td><td className="p-2"><Button size="sm" variant="ghost" disabled={locked} onClick={e => { e.stopPropagation(); void update({ ...plan, measures: plan.measures.filter(row => row.id !== m.id) }); }}>Excluir</Button></td></tr>)}</tbody></table>{!plan.measures.length && <p className="p-4 text-sm text-muted-foreground">Nenhum levantamento nesta planta.</p>}</div>
      </div>}
    </div>}
  </section>;
}
