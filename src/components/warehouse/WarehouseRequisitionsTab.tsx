import { useMemo, useState } from 'react';
import type { Project, WarehouseRequisition, WarehouseRequisitionItem } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, FileDown, Check, X } from 'lucide-react';
import { ensureWarehouse, createRequisition, deliverRequisition, updateRequisition, computeWarehouseRows } from '@/lib/warehouse';
import { getAllTasks } from '@/data/sampleProject';
import SignaturePad from './SignaturePad';
import { generateRequisitionReceipt } from './pdf';

interface Props { project: Project; onProjectChange: (next: Project) => void; }

export default function WarehouseRequisitionsTab({ project, onProjectChange }: Props) {
  const wh = ensureWarehouse(project).warehouse!;
  const tasks = useMemo(() => getAllTasks(project), [project]);
  const rows = useMemo(() => computeWarehouseRows(project), [project]);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [form, setForm] = useState<{
    date: string; taskId: string; teamId: string; requesterName: string; workFront: string; notes: string;
    items: WarehouseRequisitionItem[];
    sigWh?: string; sigRec?: string; operator: string;
  }>({
    date: new Date().toISOString().slice(0, 10),
    taskId: '', teamId: '', requesterName: '', workFront: '', notes: '',
    items: [], operator: '',
  });

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, { itemKey: '', code: '', description: '', unit: '', quantity: 0 }] }));
  const updateItem = (i: number, patch: Partial<WarehouseRequisitionItem>) =>
    setForm(f => ({ ...f, items: f.items.map((it, idx) => idx === i ? { ...it, ...patch } : it) }));
  const removeItem = (i: number) => setForm(f => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }));

  const onPickItem = (i: number, key: string) => {
    const r = rows.find(x => x.key === key);
    if (!r) return;
    updateItem(i, { itemKey: r.key, code: r.code, description: r.description, unit: r.unit });
  };

  const submit = (deliver: boolean) => {
    if (form.items.length === 0 || form.items.some(it => !it.itemKey || !it.quantity)) return;
    const task = tasks.find(t => t.id === form.taskId);
    const { project: p, requisition } = createRequisition(project, {
      date: form.date,
      taskId: form.taskId || undefined,
      taskName: task?.name,
      teamId: form.teamId || undefined,
      requesterName: form.requesterName || undefined,
      workFront: form.workFront || undefined,
      notes: form.notes || undefined,
      items: form.items,
      signatureWarehouse: form.sigWh,
      signatureReceiver: form.sigRec,
      warehouseOperator: form.operator || undefined,
    });
    const next = deliver ? deliverRequisition(p, requisition.id, { warehouseOperator: form.operator, publishToDailyReport: true }) : p;
    onProjectChange(next);
    setOpen(false);
    setForm({ date: new Date().toISOString().slice(0, 10), taskId: '', teamId: '', requesterName: '', workFront: '', notes: '', items: [], operator: '' });
  };

  const active = wh.requisitions.find(r => r.id === activeId);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 bg-card border border-border rounded-md p-2">
        <Button size="sm" onClick={() => setOpen(o => !o)}>
          <Plus className="w-3.5 h-3.5 mr-1" /> Nova requisição
        </Button>
        <div className="h-5 w-px bg-border mx-1" />
        <span className="text-[11px] text-muted-foreground">{wh.requisitions.length} requisição(ões)</span>
      </div>

      {open && (
        <div className="bg-card border border-border rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Input type="date" className="h-8 text-xs" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <Input placeholder="Solicitante" className="h-8 text-xs" value={form.requesterName} onChange={e => setForm({ ...form, requesterName: e.target.value })} />
            <Input placeholder="Frente de serviço" className="h-8 text-xs" value={form.workFront} onChange={e => setForm({ ...form, workFront: e.target.value })} />
            <Input placeholder="Almoxarife" className="h-8 text-xs" value={form.operator} onChange={e => setForm({ ...form, operator: e.target.value })} />
            <select className="h-8 text-xs border border-border rounded px-2 bg-background col-span-2" value={form.taskId} onChange={e => setForm({ ...form, taskId: e.target.value })}>
              <option value="">— tarefa/EAP —</option>
              {tasks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <Input placeholder="Observação" className="h-8 text-xs col-span-2" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
          </div>

          <div className="border border-border rounded">
            <div className="bg-muted px-2 py-1 text-[10px] uppercase font-semibold flex justify-between">
              <span>Itens da requisição</span>
              <button onClick={addItem} className="text-primary text-[10px]">+ Adicionar item</button>
            </div>
            <table className="w-full text-xs">
              <tbody>
                {form.items.map((it, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="p-1">
                      <select className="h-7 text-xs border border-border rounded px-1 bg-background w-full" value={it.itemKey} onChange={e => onPickItem(i, e.target.value)}>
                        <option value="">— selecione —</option>
                        {rows.map(r => <option key={r.key} value={r.key}>{r.description}</option>)}
                      </select>
                    </td>
                    <td className="p-1 w-24">
                      <Input type="number" step="any" placeholder="Qtd" className="h-7 text-xs" value={it.quantity || ''} onChange={e => updateItem(i, { quantity: parseFloat(e.target.value) || 0 })} />
                    </td>
                    <td className="p-1 w-16 text-center text-muted-foreground">{it.unit}</td>
                    <td className="p-1 w-8">
                      <button onClick={() => removeItem(i)} className="text-destructive"><Trash2 className="w-3 h-3" /></button>
                    </td>
                  </tr>
                ))}
                {form.items.length === 0 && (
                  <tr><td className="p-3 text-center text-muted-foreground italic">Nenhum item. Clique em "+ Adicionar item".</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <SignaturePad label="Assinatura do Almoxarife" value={form.sigWh} onChange={v => setForm(f => ({ ...f, sigWh: v }))} />
            <SignaturePad label="Assinatura de Quem Retirou" value={form.sigRec} onChange={v => setForm(f => ({ ...f, sigRec: v }))} />
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button size="sm" variant="outline" onClick={() => submit(false)}>Salvar rascunho</Button>
            <Button size="sm" onClick={() => submit(true)}><Check className="w-3.5 h-3.5 mr-1" /> Entregar e baixar estoque</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        <div className="lg:col-span-3 bg-card border border-border rounded-md overflow-hidden">
          <div className="bg-muted/40 px-3 py-2 border-b border-border text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Requisições</div>
          <table className="w-full text-xs">
            <thead className="bg-muted">
              <tr className="text-muted-foreground">
                <th className="p-2 text-left font-semibold">Nº</th>
                <th className="p-2 text-left font-semibold">Data</th>
                <th className="p-2 text-left font-semibold">Solicitante</th>
                <th className="p-2 text-left font-semibold">Tarefa</th>
                <th className="p-2 text-center font-semibold w-14">Itens</th>
                <th className="p-2 text-left font-semibold w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {wh.requisitions.slice().sort((a, b) => b.date.localeCompare(a.date)).map(r => (
                <tr key={r.id} className={`border-t border-border cursor-pointer hover:bg-muted/30 ${activeId === r.id ? 'bg-primary/10' : ''}`} onClick={() => setActiveId(r.id)}>
                  <td className="p-1.5 font-mono text-[10px]">{r.number}</td>
                  <td className="p-1.5 tabular-nums">{r.date}</td>
                  <td className="p-1.5">{r.requesterName ?? '—'}</td>
                  <td className="p-1.5 text-[10px] truncate max-w-[180px]" title={r.taskName}>{r.taskName ?? '—'}</td>
                  <td className="p-1.5 text-center tabular-nums">{r.items.length}</td>
                  <td className="p-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      r.status === 'entregue' ? 'bg-success/10 text-success'
                      : r.status === 'cancelada' ? 'bg-muted text-muted-foreground'
                      : 'bg-warning/10 text-warning'}`}>{r.status}</span>
                  </td>
                </tr>
              ))}
              {wh.requisitions.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">
                  <div className="text-xs">Nenhuma requisição registrada.</div>
                  <div className="text-[11px] mt-1">Crie uma requisição para registrar a saída de material vinculada a uma tarefa.</div>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="lg:col-span-2 bg-card border border-border rounded-md overflow-hidden">
          <div className="bg-muted/40 px-3 py-2 border-b border-border text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Detalhes</div>
          <div className="p-3">
          {active ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm">{active.number}</div>
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => generateRequisitionReceipt(project, active)}>
                  <FileDown className="w-3 h-3 mr-1" /> Recibo PDF
                </Button>
              </div>
              <div className="text-[11px] text-muted-foreground space-y-0.5">
                <div>Data: {active.date}</div>
                <div>Solicitante: {active.requesterName ?? '—'}</div>
                <div>Tarefa: {active.taskName ?? '—'}</div>
                <div>Frente: {active.workFront ?? '—'}</div>
                <div>Almoxarife: {active.warehouseOperator ?? '—'}</div>
                {active.publishedToDailyReportId && <div className="text-success">✓ Publicado no Diário</div>}
              </div>
              <div className="border-t border-border pt-2">
                {active.items.map((it, i) => (
                  <div key={i} className="text-xs flex justify-between border-b border-border py-1">
                    <span>{it.description}</span>
                    <span className="font-mono">{it.quantity} {it.unit}</span>
                  </div>
                ))}
              </div>
              {active.status === 'rascunho' && (
                <div className="flex gap-2">
                  <Button size="sm" className="flex-1" onClick={() => onProjectChange(deliverRequisition(project, active.id, { publishToDailyReport: true }))}>
                    <Check className="w-3 h-3 mr-1" /> Entregar
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => onProjectChange(updateRequisition(project, active.id, { status: 'cancelada' }))}>
                    <X className="w-3 h-3 mr-1" /> Cancelar
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground py-8 text-center">
              <div>Selecione uma requisição na lista</div>
              <div className="text-[11px] mt-1">ou clique em <strong>Nova requisição</strong> para criar uma.</div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
