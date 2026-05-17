import { useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, ArrowDown, ArrowUp, Settings2, Search } from 'lucide-react';
import { formatQty, parseBR } from './numberInput';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
}

const STATUS_BADGE: Record<MC.StockStatus, string> = {
  nao_comprado: 'bg-muted text-muted-foreground border-border',
  pedido_aberto: 'bg-primary/10 text-primary border-primary/40',
  recebido_parcial: 'bg-warning/15 text-warning border-warning/40',
  em_estoque: 'bg-success/10 text-success border-success/40',
  consumo_previsto: 'bg-success/10 text-success border-success/40',
  consumo_acima: 'bg-destructive/10 text-destructive border-destructive/40',
  falta_material: 'bg-destructive/10 text-destructive border-destructive/40',
};

export default function StockTab({ project, onProjectChange }: Props) {
  const rows = useMemo(() => MC.computeStockRows(project), [project]);
  const suppliers = useMemo(() => MC.getProjectSuppliers(project), [project]);
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [form, setForm] = useState({
    type: 'entrada' as MC.StockMovementType,
    date: new Date().toISOString().slice(0, 10),
    quantity: '',
    supplierId: '',
    notes: '',
    user: '',
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (r.code ?? '').toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.unit.toLowerCase().includes(q) ||
      (r.comparisonName ?? '').toLowerCase().includes(q),
    );
  }, [rows, search]);

  const selected = useMemo(() => rows.find(r => r.key === selectedKey) ?? null, [rows, selectedKey]);
  const movements = useMemo(() => {
    if (!selectedKey) return [];
    return (project.stockMovements ?? [])
      .filter(m => m.itemKey === selectedKey)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [project.stockMovements, selectedKey]);

  const addMove = () => {
    if (!selected) return;
    const qty = parseBR(form.quantity);
    if (!qty || qty <= 0) return;
    onProjectChange(MC.addStockMovement(project, {
      date: form.date,
      itemKey: selected.key,
      itemCode: selected.code,
      itemDescription: selected.description,
      itemUnit: selected.unit,
      type: form.type,
      quantity: qty,
      supplierId: form.type === 'entrada' ? (form.supplierId || undefined) : undefined,
      notes: form.notes || undefined,
      user: form.user || undefined,
    }));
    setForm({ ...form, quantity: '', notes: '' });
  };

  if (rows.length === 0) {
    return (
      <div className="bg-card border border-dashed border-border rounded-lg p-10 text-center text-sm text-muted-foreground">
        Nenhum insumo vinculado a comparativos. Vá em "Insumos do Projeto" para vincular itens antes de controlar o estoque.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <div className="lg:col-span-2 bg-card border border-border rounded-lg overflow-hidden flex flex-col">
        <div className="p-2 border-b border-border bg-muted/30">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar insumo..."
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>
        <div className="max-h-[calc(100vh-260px)] overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted sticky top-0 z-10">
              <tr>
                <th className="p-2 text-left w-24">Código</th>
                <th className="p-2 text-left">Descrição</th>
                <th className="p-2 text-center w-12">Un</th>
                <th className="p-2 text-left w-32">Grupo</th>
                <th className="p-2 text-right w-20">Planej.</th>
                <th className="p-2 text-right w-20">Pedido</th>
                <th className="p-2 text-right w-20">Receb.</th>
                <th className="p-2 text-right w-20">Util.</th>
                <th className="p-2 text-right w-20">Saldo</th>
                <th className="p-2 text-right w-20">Δ Pl-Ut</th>
                <th className="p-2 text-left w-36">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr
                  key={r.key}
                  className={`border-t border-border hover:bg-muted/30 cursor-pointer ${selectedKey === r.key ? 'bg-primary/10' : ''}`}
                  onClick={() => setSelectedKey(r.key)}
                >
                  <td className="p-1.5 font-mono text-[10px]">{r.code || '—'}</td>
                  <td className="p-1.5">{r.description}</td>
                  <td className="p-1.5 text-center text-muted-foreground">{r.unit}</td>
                  <td className="p-1.5 text-[10px] text-muted-foreground truncate max-w-[120px]">{r.comparisonName || '—'}</td>
                  <td className="p-1.5 text-right font-mono">{formatQty(r.planned)}</td>
                  <td className="p-1.5 text-right font-mono">{formatQty(r.purchased)}</td>
                  <td className="p-1.5 text-right font-mono">{formatQty(r.received)}</td>
                  <td className="p-1.5 text-right font-mono">{formatQty(r.used)}</td>
                  <td className={`p-1.5 text-right font-mono font-semibold ${r.balance < 0 ? 'text-destructive' : ''}`}>{formatQty(r.balance)}</td>
                  <td className={`p-1.5 text-right font-mono ${r.diffPlannedUsed < 0 ? 'text-destructive' : ''}`}>{formatQty(r.diffPlannedUsed)}</td>
                  <td className="p-1.5">
                    <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${STATUS_BADGE[r.status]}`}>
                      {MC.STOCK_STATUS_LABEL[r.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border bg-muted/30 text-xs font-semibold">
          {selected ? selected.description : 'Selecione um insumo'}
        </div>
        {selected ? (
          <div className="p-3 space-y-3">
            <div className="grid grid-cols-3 gap-1.5">
              <button
                onClick={() => setForm(f => ({ ...f, type: 'entrada' }))}
                className={`flex items-center justify-center gap-1 px-2 py-1.5 rounded border text-[11px] ${form.type === 'entrada' ? 'bg-success/10 border-success/40 text-success' : 'border-border text-muted-foreground'}`}
              >
                <ArrowDown className="w-3 h-3" /> Entrada
              </button>
              <button
                onClick={() => setForm(f => ({ ...f, type: 'saida' }))}
                className={`flex items-center justify-center gap-1 px-2 py-1.5 rounded border text-[11px] ${form.type === 'saida' ? 'bg-destructive/10 border-destructive/40 text-destructive' : 'border-border text-muted-foreground'}`}
              >
                <ArrowUp className="w-3 h-3" /> Saída
              </button>
              <button
                onClick={() => setForm(f => ({ ...f, type: 'ajuste' }))}
                className={`flex items-center justify-center gap-1 px-2 py-1.5 rounded border text-[11px] ${form.type === 'ajuste' ? 'bg-warning/10 border-warning/40 text-warning' : 'border-border text-muted-foreground'}`}
              >
                <Settings2 className="w-3 h-3" /> Ajuste
              </button>
            </div>
            <div className="space-y-1.5">
              <Input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="h-8 text-xs" />
              <Input
                placeholder={`Quantidade (${selected.unit})`}
                value={form.quantity}
                onChange={e => setForm({ ...form, quantity: e.target.value })}
                className="h-8 text-xs"
              />
              {form.type === 'entrada' && (
                <select
                  value={form.supplierId}
                  onChange={e => setForm({ ...form, supplierId: e.target.value })}
                  className="h-8 w-full text-xs border border-border rounded px-2 bg-background"
                >
                  <option value="">— fornecedor —</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              <Input
                placeholder="Responsável"
                value={form.user}
                onChange={e => setForm({ ...form, user: e.target.value })}
                className="h-8 text-xs"
              />
              <Input
                placeholder="Observação"
                value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                className="h-8 text-xs"
              />
              <Button size="sm" className="h-8 w-full text-xs" onClick={addMove}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Registrar movimentação
              </Button>
            </div>

            <div className="border-t border-border pt-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                Movimentações ({movements.length})
              </div>
              <div className="max-h-[300px] overflow-auto space-y-1">
                {movements.length === 0 && (
                  <div className="text-[11px] text-muted-foreground italic">Nenhuma movimentação ainda.</div>
                )}
                {movements.map(m => (
                  <div key={m.id} className="flex items-start gap-2 text-[11px] border border-border rounded px-2 py-1">
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${
                          m.type === 'entrada' ? 'bg-success/10 text-success'
                          : m.type === 'saida' ? 'bg-destructive/10 text-destructive'
                          : 'bg-warning/10 text-warning'
                        }`}>{m.type}</span>
                        <span className="font-mono font-semibold">{formatQty(m.quantity)} {m.itemUnit}</span>
                        <span className="text-muted-foreground">{m.date}</span>
                      </div>
                      {m.notes && <div className="text-muted-foreground mt-0.5">{m.notes}</div>}
                      {m.user && <div className="text-[10px] text-muted-foreground">por {m.user}</div>}
                    </div>
                    <button
                      className="text-destructive opacity-60 hover:opacity-100"
                      onClick={() => onProjectChange(MC.removeStockMovement(project, m.id))}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Clique em um insumo da tabela para registrar entradas, saídas ou ajustes.
          </div>
        )}
      </div>
    </div>
  );
}
