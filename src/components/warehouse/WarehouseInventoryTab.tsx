import { useMemo, useState } from 'react';
import type { Project, WarehouseAuditActor, WarehouseInventorySession } from '@/types/project';
import {
  applyInventorySession,
  cancelInventorySession,
  closeInventorySession,
  createInventorySession,
  ensureWarehouse,
  setInventoryCount,
  warehouseActorName,
} from '@/lib/warehouse';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Check, ClipboardCheck, FileDown, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { generateInventoryReportPdf } from './pdf';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
  auditActor?: WarehouseAuditActor;
  canApprove?: boolean;
}

export default function WarehouseInventoryTab({ project, onProjectChange, auditActor, canApprove = true }: Props) {
  const wh = ensureWarehouse(project).warehouse!;
  const sessions = useMemo(() => (wh.inventorySessions ?? []).slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [wh.inventorySessions]);
  const [selectedId, setSelectedId] = useState<string | null>(() => sessions.find(session => session.status === 'em_contagem' || session.status === 'em_revisao')?.id ?? null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [justification, setJustification] = useState('');
  const selected = sessions.find(session => session.id === selectedId) ?? sessions[0];

  const create = () => {
    try {
      const result = createInventorySession(project, month, auditActor, justification);
      onProjectChange(result.project);
      setSelectedId(result.session.id);
      setJustification('');
      toast.success(`Inventário ${result.session.number} aberto para contagem cega.`);
    } catch (error) { toast.error((error as Error).message); }
  };

  const close = () => {
    if (!selected) return;
    try {
      onProjectChange(closeInventorySession(project, selected.id, auditActor));
      toast.success('Contagem encerrada e diferenças liberadas para revisão.');
    } catch (error) { toast.error((error as Error).message); }
  };

  const apply = () => {
    if (!selected) return;
    try {
      onProjectChange(applyInventorySession(project, selected.id, auditActor));
      toast.success('Inventário aplicado. Os ajustes foram registrados no extrato.');
    } catch (error) { toast.error((error as Error).message); }
  };

  const cancel = () => {
    if (!selected) return;
    onProjectChange(cancelInventorySession(project, selected.id, auditActor));
    toast.message('Sessão de inventário cancelada sem alterar o estoque.');
  };

  const exportCsv = (session: WarehouseInventorySession) => {
    const lines = [
      ['Código', 'Material', 'Unidade', 'Esperado', 'Contado', 'Diferença', 'Custo unitário'].join(';'),
      ...session.lines.map(line => [line.itemCode ?? '', line.itemDescription, line.itemUnit, line.expectedQuantity ?? '', line.countedQuantity ?? '', line.difference ?? '', line.unitCostSnapshot ?? ''].join(';')),
    ];
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${session.number}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const counted = selected?.lines.filter(line => line.countedQuantity != null).length ?? 0;
  const total = selected?.lines.length ?? 0;

  return (
    <div className="grid gap-3 lg:grid-cols-[300px_1fr]">
      <aside className="space-y-3">
        <div className="rounded-md border bg-card p-3">
          <h3 className="font-semibold">Inventário mensal</h3>
          <p className="mt-1 text-sm text-muted-foreground">A contagem é cega. O saldo esperado só aparece depois que todos os materiais forem contados.</p>
          <div className="mt-3 space-y-2"><Input className="min-h-11" type="month" value={month} onChange={event => setMonth(event.target.value)} /><Input className="min-h-11" value={justification} onChange={event => setJustification(event.target.value)} placeholder="Justificativa para recontagem, se houver" /><Button className="min-h-11 w-full" onClick={create}><Plus className="mr-2 h-4 w-4" />Abrir sessão</Button></div>
          <div className="mt-3 text-xs text-muted-foreground">Responsável pelo login: <strong className="text-foreground">{warehouseActorName(auditActor)}</strong></div>
        </div>
        <div className="overflow-hidden rounded-md border bg-card"><div className="border-b bg-muted/40 p-2 text-xs font-semibold uppercase text-muted-foreground">Sessões</div>{sessions.map(session => <button key={session.id} type="button" className={`w-full border-b p-3 text-left last:border-0 ${selected?.id === session.id ? 'bg-primary/10' : 'hover:bg-muted/30'}`} onClick={() => setSelectedId(session.id)}><div className="flex justify-between gap-2"><strong className="text-sm">{session.number}</strong><span className="text-xs">{session.month}</span></div><div className="mt-1 text-xs text-muted-foreground">{session.status.replace('_', ' ')} · {session.lines.length} material(is)</div></button>)}{!sessions.length && <div className="p-5 text-center text-sm text-muted-foreground">Nenhuma sessão.</div>}</div>
      </aside>

      <section className="overflow-hidden rounded-md border bg-card">
        {!selected ? <div className="p-10 text-center text-sm text-muted-foreground">Abra o inventário do mês para iniciar a contagem.</div> : <>
          <div className="flex flex-col gap-3 border-b p-3 sm:flex-row sm:flex-wrap sm:items-center"><div><h3 className="font-semibold">{selected.number}</h3><p className="text-sm text-muted-foreground">{selected.status === 'em_contagem' ? `${counted} de ${total} materiais contados` : `Status: ${selected.status.replace('_', ' ')}`}</p></div><div className="grid grid-cols-1 gap-2 sm:ml-auto sm:flex sm:flex-wrap">{selected.status === 'em_contagem' && <><Button variant="outline" className="min-h-11" onClick={cancel}><X className="mr-2 h-4 w-4" />Cancelar</Button><Button className="min-h-11" onClick={close} disabled={counted !== total || total === 0}><ClipboardCheck className="mr-2 h-4 w-4" />Encerrar contagem</Button></>}{selected.status === 'em_revisao' && <Button className="min-h-11" disabled={!canApprove} onClick={apply}><Check className="mr-2 h-4 w-4" />{canApprove ? 'Confirmar e aplicar ajustes' : 'Aguardando administrador'}</Button>}{selected.status === 'aplicado' && <><Button variant="outline" className="min-h-11" onClick={() => exportCsv(selected)}><FileDown className="mr-2 h-4 w-4" />CSV</Button><Button variant="outline" className="min-h-11" onClick={() => generateInventoryReportPdf(project, selected)}><FileDown className="mr-2 h-4 w-4" />PDF</Button></>}</div></div>
          <div className="space-y-2 p-3 md:hidden">{selected.lines.map(line => { const impact = line.difference != null && line.unitCostSnapshot != null ? line.difference * line.unitCostSnapshot : undefined; return <article key={line.itemKey} className="rounded-md border p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="font-medium leading-snug">{line.itemDescription}</div><div className="mt-0.5 text-xs text-muted-foreground">{line.itemCode || 'Sem código'} · {line.itemUnit}</div></div>{selected.status !== 'em_contagem' && <span className={`shrink-0 rounded-full bg-muted px-2 py-1 text-xs font-semibold ${(line.difference ?? 0) < 0 ? 'text-destructive' : (line.difference ?? 0) > 0 ? 'text-success' : ''}`}>Dif. {line.difference?.toLocaleString('pt-BR') ?? '—'}</span>}</div>{selected.status === 'em_contagem' ? <div className="mt-3"><label htmlFor={`inventory-count-${line.itemKey}`} className="mb-1 block text-xs font-semibold">Quantidade contada</label><Input id={`inventory-count-${line.itemKey}`} className="min-h-11 w-full text-right text-base" inputMode="decimal" type="number" min="0" step="any" value={line.countedQuantity ?? ''} onChange={event => { const value = event.target.value === '' ? undefined : Number(event.target.value); try { onProjectChange(setInventoryCount(project, selected.id, line.itemKey, value, auditActor)); } catch (error) { toast.error((error as Error).message); } }} /></div> : <dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><div><dt className="text-xs text-muted-foreground">Esperado</dt><dd className="font-mono">{line.expectedQuantity?.toLocaleString('pt-BR') ?? '—'}</dd></div><div><dt className="text-xs text-muted-foreground">Contado</dt><dd className="font-mono">{line.countedQuantity?.toLocaleString('pt-BR') ?? '—'}</dd></div><div className="col-span-2"><dt className="text-xs text-muted-foreground">Impacto</dt><dd className="font-mono">{impact == null ? 'Cálculo incompleto' : impact.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</dd></div></dl>}</article>; })}</div>
          <div className="hidden max-h-[calc(100dvh-330px)] overflow-auto md:block"><table className="w-full min-w-[720px] text-sm"><thead className="sticky top-0 bg-muted text-muted-foreground"><tr><th className="p-2 text-left">Material</th><th className="p-2 text-center">Un</th>{selected.status !== 'em_contagem' && <th className="p-2 text-right">Esperado</th>}<th className="p-2 text-right">Contado</th>{selected.status !== 'em_contagem' && <><th className="p-2 text-right">Diferença</th><th className="p-2 text-right">Impacto</th></>}</tr></thead><tbody>{selected.lines.map(line => { const impact = line.difference != null && line.unitCostSnapshot != null ? line.difference * line.unitCostSnapshot : undefined; return <tr key={line.itemKey} className="border-t"><td className="p-2"><div className="font-medium">{line.itemDescription}</div><div className="text-xs text-muted-foreground">{line.itemCode || 'Sem código'}</div></td><td className="p-2 text-center">{line.itemUnit}</td>{selected.status !== 'em_contagem' && <td className="p-2 text-right font-mono">{line.expectedQuantity?.toLocaleString('pt-BR') ?? '—'}</td>}<td className="p-2 text-right">{selected.status === 'em_contagem' ? <Input className="ml-auto min-h-11 w-32 text-right" type="number" min="0" step="any" value={line.countedQuantity ?? ''} onChange={event => { const value = event.target.value === '' ? undefined : Number(event.target.value); try { onProjectChange(setInventoryCount(project, selected.id, line.itemKey, value, auditActor)); } catch (error) { toast.error((error as Error).message); } }} aria-label={`Contagem de ${line.itemDescription}`} /> : <span className="font-mono">{line.countedQuantity?.toLocaleString('pt-BR') ?? '—'}</span>}</td>{selected.status !== 'em_contagem' && <><td className={`p-2 text-right font-mono ${(line.difference ?? 0) < 0 ? 'text-destructive' : (line.difference ?? 0) > 0 ? 'text-success' : ''}`}>{line.difference?.toLocaleString('pt-BR') ?? '—'}</td><td className="p-2 text-right font-mono">{impact == null ? 'Cálculo incompleto' : impact.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td></>}</tr>; })}</tbody></table></div>
        </>}
      </section>
    </div>
  );
}
