import { useRef, useState } from 'react';
import { FilePlus2, FolderOpen, Link2, Trash2, X } from 'lucide-react';
import { Content, Close } from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogPortal, DialogOverlay, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { TakeoffMeasure, TakeoffPlan } from '@/lib/planTakeoff';

interface Props {
  plans: TakeoffPlan[]; legacyPlans: TakeoffPlan[]; activeId: string; hiddenIds: string[];
  readOnly: boolean; locked: boolean; error: string;
  onClose: () => void; onAccept: (id: string, hiddenIds: string[]) => void;
  onImport: (file: File, floor: string) => Promise<string | undefined>;
  onAssignLegacy: (id: string, floor: string) => Promise<string | undefined>;
  onDelete: (id: string) => Promise<boolean>;
  removableOrphan: (measure: TakeoffMeasure) => boolean;
  onRemoveUnassigned: (planId: string, measureId: string) => Promise<boolean>;
}

export default function PlanDrawingManager({ plans, legacyPlans, activeId, hiddenIds, readOnly, locked, error, removableOrphan, onRemoveUnassigned, onClose, onAccept, onImport, onAssignLegacy, onDelete }: Props) {
  const [selected, setSelected] = useState(activeId);
  const [hidden, setHidden] = useState(hiddenIds);
  const filePicker = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState('');
  const [deleting, setDeleting] = useState('');
  const current = plans.find(plan => plan.id === selected);
  const unassigned = current?.measures.filter(removableOrphan) ?? [];
  const accept = () => onAccept(current?.id ?? plans[0]?.id ?? '', hidden);
  const importFiles = async (files: File[]) => {
    if (!files.length || importing) return;
    setImporting(true);
    let completed = 0;
    let failed = '';
    try {
      for (let index = 0; index < files.length; index++) {
        setImportProgress(`Enviando ${index + 1} de ${files.length}: ${files[index].name}`);
        try {
          const id = await onImport(files[index], '');
          if (!id) { failed = files[index].name; break; }
          setSelected(id); completed++;
        } catch { failed = files[index].name; break; }
      }
      setImportProgress(failed
        ? `${completed} de ${files.length} planta${files.length === 1 ? '' : 's'} confirmada${files.length === 1 ? '' : 's'}. Cadastro interrompido em ${failed}; confira o erro abaixo.`
        : `${completed} de ${files.length} planta${files.length === 1 ? '' : 's'} cadastrada${files.length === 1 ? '' : 's'}.`);
    } finally { setImporting(false); }
  };
  const deleteSelected = async () => {
    if (!await onDelete(deleting)) return;
    setSelected(plans.find(plan => plan.id !== deleting)?.id ?? '');
    setHidden(ids => ids.filter(id => id !== deleting)); setDeleting('');
  };
  return <Dialog open onOpenChange={open => { if (!open && !locked) onClose(); }}>
    <DialogPortal><DialogOverlay className="z-[60] bg-black/20" /><Content className="fixed left-1/2 top-1/2 z-[61] grid w-[calc(100vw-24px)] max-w-[420px] max-h-[calc(100dvh-24px)] -translate-x-1/2 -translate-y-1/2 gap-2 overflow-auto rounded-sm border border-slate-400 bg-[#f1f2f3] p-3 text-xs text-slate-800 shadow-xl" onEscapeKeyDown={event => { if (locked) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()}>
      <DialogTitle className="pr-7 text-sm font-medium">Gestão de desenhos</DialogTitle>
      <DialogDescription className="text-[11px] leading-4">Selecione uma prancha deste prédio. Aceitar aplica a seleção e a visibilidade.</DialogDescription>
      <div role="toolbar" aria-label="Gestão das pranchas" className="flex h-7 items-center gap-0.5 border-y border-slate-300">
        {!readOnly && <><Button aria-label="Nova planta" title="Nova planta — escolher um ou vários arquivos do computador" variant="ghost" size="icon" className="h-6 w-6 rounded-none" disabled={locked || importing} onClick={() => filePicker.current?.click()}><FilePlus2 className="h-3.5 w-3.5" /></Button><input ref={filePicker} type="file" multiple aria-label="Selecionar plantas" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.dxf,.dwf" disabled={locked || importing} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files); }} /></>}
        <Button aria-label="Abrir planta selecionada" title="Abrir — aceitar e visualizar a prancha selecionada" variant="ghost" size="icon" className="h-6 w-6 rounded-none" disabled={!current || locked} onClick={accept}><FolderOpen className="h-3.5 w-3.5" /></Button>
        {!readOnly && <><span className="mx-1 h-4 border-l border-slate-300" /><Button aria-label={`Apagar planta ${current?.name ?? 'selecionada'}`} title={current?.measures.length ? 'Planta com marcações: exclusão indisponível para preservar os quantitativos' : 'Apagar — excluir a prancha selecionada'} variant="ghost" size="icon" className="h-6 w-6 rounded-none" disabled={!current || locked || !!current.measures.length} onClick={() => setDeleting(current!.id)}><Trash2 className="h-3.5 w-3.5" /></Button></>}
      </div>
      {!!current?.measures.length && <div role="status" className="space-y-1 border border-amber-300 bg-amber-50 p-2 text-amber-900">
        {unassigned.length ? <><p>Esta prancha possui ocorrências antigas sem tarefa nem dia. A remoção preserva o arquivo e pode ser desfeita nesta sessão.</p>{unassigned.map(measure => <div key={measure.id} className="flex items-center justify-between gap-2"><span>{measure.name} · {measure.points.length} pontos · Sem tarefa/dia</span>{!readOnly && <Button aria-label={`Remover ocorrência ${measure.name}`} title="Remover somente esta ocorrência sem vínculo; preserve a planta" variant="outline" className="h-6 px-2 text-[11px]" disabled={locked} onClick={() => { void onRemoveUnassigned(current!.id, measure.id); }}>Remover</Button>}</div>)}{current.measures.length > unassigned.length && <p>As demais marcações estão protegidas por seus vínculos com a Produção.</p>}</> : <p>Exclusão bloqueada: esta prancha possui marcações. Remova as marcações e seus quantitativos nas tarefas correspondentes antes de apagar a planta. As outras tarefas deste prédio também podem usar este arquivo.</p>}
      </div>}
      <div className="h-64 overflow-auto border border-slate-400 bg-white">
        <table className="w-full table-fixed border-collapse text-[11px]" aria-label="Plantas cadastradas">
          <thead className="sticky top-0 bg-[#e9ecef]"><tr><th className="w-14 border-b border-r border-slate-300 px-1 py-1 font-normal">Visível</th><th className="border-b border-r border-slate-300 px-1 py-1 text-left font-normal">Nome do desenho / Pavimento</th><th className="w-[70px] border-b border-slate-300 px-1 py-1 font-normal">Eliminável</th></tr></thead>
          <tbody>{plans.map(plan => <tr key={plan.id} aria-selected={selected === plan.id} className={selected === plan.id ? 'bg-sky-100' : 'hover:bg-slate-50'}>
            <td className="border-r border-slate-200 text-center"><input type="checkbox" aria-label={`Visível ${plan.name}`} checked={!hidden.includes(plan.id)} disabled={locked} onChange={event => setHidden(ids => event.target.checked ? ids.filter(id => id !== plan.id) : [...ids, plan.id])} /></td>
            <td className="border-r border-slate-200"><button type="button" disabled={locked} className="block w-full truncate px-1 py-1 text-left focus-visible:outline focus-visible:outline-sky-600" title={`${plan.name}${plan.floor ? ` · ${plan.floor}` : ''}`} onClick={() => { setSelected(plan.id); setDeleting(''); }} onDoubleClick={() => onAccept(plan.id, hidden)}>{plan.name}{plan.floor ? ` · ${plan.floor}` : ''}</button></td>
            <td className="text-center" title={plan.measures.length ? 'Não: existem marcações nesta prancha' : 'Sim: prancha sem marcações'}><input type="checkbox" aria-label={`Eliminável ${plan.name}`} checked={!plan.measures.length} disabled /></td>
          </tr>)}</tbody>
        </table>
        {!plans.length && <p className="p-3 text-slate-500">Nenhuma planta cadastrada neste prédio.</p>}
      </div>
      {importProgress && <p role="status" className="border border-slate-300 bg-white p-2 text-slate-700">{importProgress}</p>}
      {!!legacyPlans.length && !readOnly && <div className="border border-slate-300 bg-white p-2 text-slate-600">Plantas antigas sem prédio: {legacyPlans.map(plan => <Button key={plan.id} variant="link" size="sm" className="h-7 px-1 text-xs" aria-label={`Vincular ${plan.name} a este prédio`} disabled={locked || importing} onClick={() => { void onAssignLegacy(plan.id, '').then(id => { if (id) setSelected(id); }); }}><Link2 className="mr-1 h-3 w-3" />Vincular {plan.name}</Button>)}</div>}
      {deleting && <div role="group" aria-label="Confirmar exclusão" className="space-y-1 border border-amber-300 bg-amber-50 p-2"><p>Apagar {plans.find(plan => plan.id === deleting)?.name}? A prancha será arquivada na nuvem.</p><Button aria-label="Confirmar exclusão da planta" className="h-7 text-xs" variant="destructive" disabled={locked} onClick={() => { void deleteSelected(); }}>Apagar</Button><Button aria-label="Cancelar exclusão da planta" className="ml-1 h-7 text-xs" variant="outline" disabled={locked} onClick={() => setDeleting('')}>Cancelar</Button></div>}
      {error && <p role="alert" className="border border-red-300 bg-red-50 p-2 text-red-800">{error}</p>}
      <div className="flex justify-between border-t border-slate-300 pt-2"><Button aria-label="Aceitar gestão de desenhos" variant="outline" className="h-7 border-slate-400 bg-white px-3 text-xs" disabled={locked} onClick={accept}>Aceitar</Button><Button aria-label="Cancelar gestão de desenhos" variant="outline" className="h-7 border-slate-400 bg-white px-3 text-xs" disabled={locked} onClick={onClose}>Cancelar</Button></div>
      <Close aria-label="Fechar gestão de desenhos" disabled={locked} className="absolute right-3 top-3 text-slate-500 hover:text-slate-900"><X className="h-4 w-4" /></Close>
    </Content></DialogPortal>
  </Dialog>;
}
