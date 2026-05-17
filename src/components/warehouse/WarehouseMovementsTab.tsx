import { useMemo, useState } from 'react';
import type { Project, WarehouseMovementType, WarehouseAttachment } from '@/types/project';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Undo2, Paperclip, X } from 'lucide-react';
import { addMovement, reverseMovement, MOVEMENT_LABEL, ensureWarehouse, makeAttachment, movementSign, computeWarehouseRows } from '@/lib/warehouse';
import { getProjectSuppliers } from '@/lib/materialComparisons';

interface Props { project: Project; onProjectChange: (next: Project) => void; }

const TYPES: WarehouseMovementType[] = ['entrada', 'devolucao', 'retirada', 'perda', 'transferencia_saida', 'transferencia_entrada', 'ajuste_positivo', 'ajuste_negativo'];

export default function WarehouseMovementsTab({ project, onProjectChange }: Props) {
  const wh = ensureWarehouse(project).warehouse!;
  const rows = useMemo(() => computeWarehouseRows(project), [project]);
  const suppliers = useMemo(() => getProjectSuppliers(project), [project]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    type: 'entrada' as WarehouseMovementType,
    date: new Date().toISOString().slice(0, 10),
    itemKey: '',
    quantity: '',
    unitPrice: '',
    supplierId: '',
    invoiceNumber: '',
    notes: '',
    responsible: '',
    user: '',
  });
  const [attachments, setAttachments] = useState<WarehouseAttachment[]>([]);

  const item = rows.find(r => r.key === form.itemKey);

  const submit = () => {
    if (!item) return;
    const qty = parseFloat(form.quantity.replace(',', '.'));
    if (!qty || qty <= 0) return;
    onProjectChange(addMovement(project, {
      type: form.type,
      date: form.date,
      itemKey: item.key,
      itemCode: item.code,
      itemDescription: item.description,
      itemUnit: item.unit,
      quantity: qty,
      unitPrice: form.unitPrice ? parseFloat(form.unitPrice.replace(',', '.')) : undefined,
      supplierId: form.supplierId || undefined,
      invoiceNumber: form.invoiceNumber || undefined,
      notes: form.notes || undefined,
      responsible: form.responsible || undefined,
      user: form.user || undefined,
      attachments,
    }));
    setOpen(false);
    setForm({ ...form, quantity: '', notes: '', invoiceNumber: '' });
    setAttachments([]);
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const made = await Promise.all(files.map(f => makeAttachment(f, form.type === 'entrada' ? 'nf' : 'outro')));
    setAttachments(prev => [...prev, ...made]);
    e.target.value = '';
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setOpen(o => !o)}><Plus className="w-3.5 h-3.5 mr-1" /> Nova movimentação</Button>
        <span className="text-[11px] text-muted-foreground">Total: {wh.movements.length}</span>
      </div>

      {open && (
        <div className="bg-card border border-border rounded-lg p-3 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <select className="h-8 text-xs border border-border rounded px-2 bg-background" value={form.type} onChange={e => setForm({ ...form, type: e.target.value as WarehouseMovementType })}>
              {TYPES.map(t => <option key={t} value={t}>{MOVEMENT_LABEL[t]}</option>)}
            </select>
            <Input type="date" className="h-8 text-xs" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <select className="h-8 text-xs border border-border rounded px-2 bg-background col-span-2" value={form.itemKey} onChange={e => setForm({ ...form, itemKey: e.target.value })}>
              <option value="">— selecione o insumo —</option>
              {rows.map(r => <option key={r.key} value={r.key}>{r.description} ({r.unit})</option>)}
            </select>
            <Input placeholder={`Quantidade ${item ? `(${item.unit})` : ''}`} value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} className="h-8 text-xs" />
            <Input placeholder="Valor unit. (R$)" value={form.unitPrice} onChange={e => setForm({ ...form, unitPrice: e.target.value })} className="h-8 text-xs" />
            {form.type === 'entrada' && (
              <>
                <select className="h-8 text-xs border border-border rounded px-2 bg-background" value={form.supplierId} onChange={e => setForm({ ...form, supplierId: e.target.value })}>
                  <option value="">— fornecedor —</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <Input placeholder="Nota fiscal" value={form.invoiceNumber} onChange={e => setForm({ ...form, invoiceNumber: e.target.value })} className="h-8 text-xs" />
              </>
            )}
            <Input placeholder="Responsável" value={form.responsible} onChange={e => setForm({ ...form, responsible: e.target.value })} className="h-8 text-xs" />
            <Input placeholder="Usuário" value={form.user} onChange={e => setForm({ ...form, user: e.target.value })} className="h-8 text-xs" />
            <Input placeholder="Observação" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="h-8 text-xs col-span-2" />
          </div>

          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1 text-[11px] cursor-pointer border border-border rounded px-2 py-1 hover:bg-muted">
              <Paperclip className="w-3 h-3" /> Anexar (NF, foto)
              <input type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={handleFiles} />
            </label>
            {attachments.map(a => (
              <span key={a.id} className="inline-flex items-center gap-1 text-[10px] bg-muted px-1.5 py-0.5 rounded">
                {a.name}
                <button onClick={() => setAttachments(prev => prev.filter(x => x.id !== a.id))}><X className="w-2.5 h-2.5" /></button>
              </span>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button size="sm" onClick={submit} disabled={!item || !form.quantity}>Registrar</Button>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="max-h-[calc(100vh-360px)] overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted sticky top-0">
              <tr>
                <th className="p-2 text-left w-20">Data</th>
                <th className="p-2 text-left w-32">Tipo</th>
                <th className="p-2 text-left">Insumo</th>
                <th className="p-2 text-right w-20">Qtd</th>
                <th className="p-2 text-left">Origem/Destino</th>
                <th className="p-2 text-left w-32">Responsável</th>
                <th className="p-2 text-center w-16">Anexos</th>
                <th className="p-2 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {wh.movements.slice().sort((a, b) => b.date.localeCompare(a.date)).map(m => {
                const sign = movementSign(m);
                const reversed = !!m.reversedById;
                return (
                  <tr key={m.id} className={`border-t border-border ${reversed ? 'opacity-50 line-through' : ''}`}>
                    <td className="p-1.5 font-mono text-[10px]">{m.date}</td>
                    <td className="p-1.5">{MOVEMENT_LABEL[m.type]}</td>
                    <td className="p-1.5">{m.itemDescription}</td>
                    <td className={`p-1.5 text-right font-mono ${sign > 0 ? 'text-success' : sign < 0 ? 'text-destructive' : ''}`}>
                      {sign > 0 ? '+' : sign < 0 ? '−' : ''}{m.quantity.toLocaleString('pt-BR')} {m.itemUnit}
                    </td>
                    <td className="p-1.5 text-[10px] text-muted-foreground">
                      {m.invoiceNumber && `NF ${m.invoiceNumber} `}
                      {m.workerName && `· ${m.workerName} `}
                      {m.taskId && `· tarefa ${m.taskId.slice(0, 6)} `}
                      {m.notes && `· ${m.notes}`}
                    </td>
                    <td className="p-1.5 text-[10px]">{m.responsible ?? m.user ?? '—'}</td>
                    <td className="p-1.5 text-center text-[10px]">{m.attachments?.length ?? 0}</td>
                    <td className="p-1.5 text-right">
                      {!reversed && m.type !== 'estorno' && (
                        <button title="Estornar" className="text-warning" onClick={() => { if (confirm('Estornar este movimento?')) onProjectChange(reverseMovement(project, m.id)); }}>
                          <Undo2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {wh.movements.length === 0 && (
                <tr><td colSpan={8} className="p-6 text-center text-muted-foreground italic">Nenhuma movimentação registrada.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
