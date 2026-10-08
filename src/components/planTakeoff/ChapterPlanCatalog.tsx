import { useCallback, useEffect, useState } from 'react';
import { FileUp, Link2 } from 'lucide-react';
import { readTakeoffs, updateTakeoffs, TAKEOFF_CATALOG_UPDATED, type TakeoffPlan } from '@/lib/planTakeoff';
import { openDwfSheets } from '@/lib/dwfTakeoff';

interface Props {
  storageKey: string;
  chapterId: string;
  building: string;
  readOnly: boolean;
}

export default function ChapterPlanCatalog({ storageKey, chapterId, building, readOnly }: Props) {
  const [plans, setPlans] = useState<TakeoffPlan[]>([]);
  const [floor, setFloor] = useState('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    try { setPlans(await readTakeoffs(storageKey, { migrateLocal: !readOnly })); setReady(true); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Não foi possível consultar as plantas na nuvem. A cópia local foi preservada.'); }
  }, [storageKey, readOnly]);

  useEffect(() => {
    void load();
    const updated = (event: Event) => { if ((event as CustomEvent<string>).detail === storageKey) void load(); };
    window.addEventListener(TAKEOFF_CATALOG_UPDATED, updated);
    return () => window.removeEventListener(TAKEOFF_CATALOG_UPDATED, updated);
  }, [load, storageKey]);

  const announce = (next: TakeoffPlan[]) => {
    setPlans(next);
    window.dispatchEvent(new CustomEvent(TAKEOFF_CATALOG_UPDATED, { detail: storageKey }));
  };

  async function addFile(file?: File) {
    if (!file || readOnly || saving) return;
    const chosenFloor = floor.trim();
    if (!chosenFloor) { setMessage('Informe o pavimento antes de adicionar a planta.'); return; }
    const extension = file.name.split('.').pop()?.toLowerCase();
    const kind = extension === 'pdf' ? 'pdf' : extension === 'dxf' ? 'dxf' : extension === 'dwf' ? 'dwf' : ['png', 'jpg', 'jpeg'].includes(extension ?? '') ? 'image' : null;
    if (!kind) { setMessage('Escolha PDF, PNG, JPG, DXF ou DWF 2D.'); return; }
    if (file.size > 100 * 1024 * 1024) { setMessage('Neste teste, o limite por arquivo é 100 MB.'); return; }
    setSaving(true); setMessage('Enviando planta para a nuvem…');
    try {
      if (kind === 'dwf') await openDwfSheets(file);
      const next = await updateTakeoffs(storageKey, current => {
        if (current.some(plan => plan.chapterId === chapterId && plan.floor.toLowerCase() === chosenFloor.toLowerCase() && plan.name.toLowerCase() === file.name.toLowerCase())) {
          throw new Error('Esta planta já está cadastrada neste prédio e pavimento.');
        }
        return [...current, { id: crypto.randomUUID(), name: file.name, floor: chosenFloor, building, chapterId, kind, file, scales: kind === 'dxf' ? { 1: 1 } : {}, measures: [] }];
      });
      announce(next); setFloor(''); setMessage('Planta salva na nuvem e disponível para as tarefas deste prédio em outros computadores.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível confirmar a planta na nuvem.'); }
    finally { setSaving(false); }
  }

  async function assignLegacy(planId: string) {
    if (readOnly || saving) return;
    const chosenFloor = floor.trim();
    if (!chosenFloor) { setMessage('Informe o pavimento para vincular a planta antiga.'); return; }
    setSaving(true); setMessage('Vinculando planta…');
    try {
      const next = await updateTakeoffs(storageKey, current => current.map(plan => plan.id === planId && !plan.chapterId ? { ...plan, chapterId, building, floor: chosenFloor } : plan));
      announce(next); setFloor(''); setMessage('Planta antiga vinculada ao prédio sem perder as marcações.');
    } catch { setMessage('Não foi possível vincular a planta antiga.'); }
    finally { setSaving(false); }
  }

  const chapterPlans = plans.filter(plan => plan.chapterId === chapterId);
  const legacyPlans = plans.filter(plan => !plan.chapterId);
  return <section aria-label={`Plantas do prédio ${building}`} className="border-t border-border bg-slate-50 px-5 py-2 text-xs text-slate-800">
    <div className="flex flex-wrap items-center gap-2">
      <strong>Plantas do prédio: {building}</strong>
      <span className="text-slate-500">{chapterPlans.length} cadastrada{chapterPlans.length === 1 ? '' : 's'}</span>
      {!readOnly && <><input aria-label={`Pavimento da planta de ${building}`} value={floor} onChange={event => setFloor(event.target.value)} placeholder="Pavimento (ex.: térreo)" className="h-8 min-w-36 border border-slate-300 bg-white px-2" />
        <label className={`inline-flex h-8 items-center gap-1 border border-slate-300 bg-white px-2 font-medium ${saving ? 'opacity-50' : 'cursor-pointer hover:bg-sky-50'}`}><FileUp className="h-3.5 w-3.5" />Adicionar planta<input type="file" aria-label={`Adicionar planta ao prédio ${building}`} accept=".pdf,.png,.jpg,.jpeg,.dxf,.dwf" className="sr-only" disabled={saving || !ready} onChange={event => { void addFile(event.target.files?.[0]); event.target.value = ''; }} /></label></>}
    </div>
    {message && <p role="status" className="mt-1 text-amber-800">{message}</p>}
    {chapterPlans.length > 0 && <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{chapterPlans.map(plan => <li key={plan.id}>{plan.name} · {plan.floor} <span className="text-slate-500">({(plan.file.size / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB)</span></li>)}</ul>}
    {legacyPlans.length > 0 && !readOnly && <div className="mt-2 border-t border-slate-200 pt-1"><span className="text-slate-600">Plantas antigas sem prédio:</span>{legacyPlans.map(plan => <button key={plan.id} type="button" disabled={saving} onClick={() => void assignLegacy(plan.id)} className="ml-2 inline-flex items-center gap-1 text-sky-800 underline disabled:opacity-50"><Link2 className="h-3 w-3" />Vincular {plan.name} a este prédio</button>)}</div>}
  </section>;
}
