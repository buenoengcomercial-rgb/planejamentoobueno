import { useMemo, useState } from 'react';
import type { Project, WarehouseMovementType } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import {
  addMovement,
  computeWarehouseRows,
  ensureWarehouse,
  MOVEMENT_LABEL,
  movementSign,
  reverseMovement,
  type WarehouseRow,
} from '@/lib/warehouse';
import { getAllTasks } from '@/data/sampleProject';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, ArrowDown, ArrowUp, Settings2, Search, Undo2 } from 'lucide-react';
import { formatQty, parseBR } from './numberInput';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
}

type StockAction = 'entrada' | 'retirada' | 'ajuste';

const STATUS_BADGE: Record<MC.StockStatus, string> = {
  nao_comprado: 'bg-muted text-muted-foreground border-border',
  pedido_aberto: 'bg-primary/10 text-primary border-primary/40',
  recebido_parcial: 'bg-warning/15 text-warning border-warning/40',
  em_estoque: 'bg-success/10 text-success border-success/40',
  consumo_previsto: 'bg-success/10 text-success border-success/40',
  consumo_acima: 'bg-destructive/10 text-destructive border-destructive/40',
  falta_material: 'bg-destructive/10 text-destructive border-destructive/40',
};

function deriveStatus(row: WarehouseRow): MC.StockStatus {
  if (row.received === 0 && row.purchased === 0) return 'nao_comprado';
  if (row.purchased > 0 && row.received === 0) return 'pedido_aberto';
  if (row.withdrawn > row.planned && row.planned > 0) return 'consumo_acima';
  if (row.balance < 0) return 'falta_material';
  if (row.received > 0 && row.purchased > 0 && row.received < row.purchased) return 'recebido_parcial';
  if (row.balance > 0) return 'em_estoque';
  if (row.withdrawn > 0 && Math.abs(row.planned - row.withdrawn) < 0.01) return 'consumo_previsto';
  return 'em_estoque';
}

export default function StockTab({ project, onProjectChange }: Props) {
  const rows = useMemo(() => computeWarehouseRows(project), [project]);
  const warehouse = useMemo(() => ensureWarehouse(project).warehouse!, [project]);
  const suppliers = useMemo(() => MC.getProjectSuppliers(project), [project]);
  const tasks = useMemo(() => getAllTasks(project), [project]);
  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task.name])), [tasks]);
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [form, setForm] = useState({
    type: 'entrada' as StockAction,
    date: new Date().toISOString().slice(0, 10),
    quantity: '',
    supplierId: '',
    notes: '',
    user: '',
    taskId: '',
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(row =>
      (row.code ?? '').toLowerCase().includes(q) ||
      row.description.toLowerCase().includes(q) ||
      row.unit.toLowerCase().includes(q),
    );
  }, [rows, search]);

  const selected = useMemo(() => rows.find(row => row.key === selectedKey) ?? null, [rows, selectedKey]);
  const movements = useMemo(() => {
    if (!selectedKey) return [];
    return warehouse.movements
      .filter(movement => movement.itemKey === selectedKey)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [warehouse.movements, selectedKey]);

  const addMove = () => {
    if (!selected) return;
    const rawQty = parseBR(form.quantity);
    if (rawQty === undefined || rawQty === 0) return;

    let type: WarehouseMovementType;
    if (form.type === 'entrada') {
      if (rawQty <= 0) return;
      type = 'entrada';
    } else if (form.type === 'retirada') {
      if (rawQty <= 0) return;
      type = 'retirada';
    } else {
      type = rawQty > 0 ? 'ajuste_positivo' : 'ajuste_negativo';
    }

    onProjectChange(addMovement(project, {
      date: form.date,
      itemKey: selected.key,
      itemCode: selected.code,
      itemDescription: selected.description,
      itemUnit: selected.unit,
      type,
      quantity: Math.abs(rawQty),
      supplierId: type === 'entrada' ? (form.supplierId || undefined) : undefined,
      taskId: type === 'retirada' ? (form.taskId || undefined) : undefined,
      notes: form.notes || undefined,
      user: form.user || undefined,
    }));
    setForm({ ...form, quantity: '', notes: '', taskId: type === 'retirada' ? form.taskId : '' });
  };

  if (rows.length === 0) {
    return (
      <div className="bg-card border border-dashed border-border rounded-lg p-10 text-center text-sm text-muted-foreground">
        Nenhum insumo vinculado a comparativos. Va em "Insumos do Projeto" para vincular itens antes de controlar o estoque.
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
                <th className="p-2 text-left w-24">Codigo</th>
                <th className="p-2 text-left">Descricao</th>
                <th className="p-2 text-center w-12">Un</th>
                <th className="p-2 text-right w-20">Planej.</th>
                <th className="p-2 text-right w-20">Pedido</th>
                <th className="p-2 text-right w-20">Receb.</th>
                <th className="p-2 text-right w-20">Retir.</th>
                <th className="p-2 text-right w-20">Saldo</th>
                <th className="p-2 text-right w-20">Pl-Util</th>
                <th className="p-2 text-left w-36">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => {
                const status = deriveStatus(row);
                const diffPlannedWithdrawn = row.planned - row.withdrawn;
                return (
                  <tr
                    key={row.key}
                    className={`border-t border-border hover:bg-muted/30 cursor-pointer ${selectedKey === row.key ? 'bg-primary/10' : ''}`}
                    onClick={() => setSelectedKey(row.key)}
                  >
                    <td className="p-1.5 font-mono text-[10px]">{row.code || '-'}</td>
                    <td className="p-1.5">{row.description}</td>
                    <td className="p-1.5 text-center text-muted-foreground">{row.unit}</td>
                    <td className="p-1.5 text-right font-mono">{formatQty(row.planned)}</td>
                    <td className="p-1.5 text-right font-mono">{formatQty(row.purchased)}</td>
                    <td className="p-1.5 text-right font-mono text-success">{formatQty(row.received)}</td>
                    <td className="p-1.5 text-right font-mono">{formatQty(row.withdrawn)}</td>
                    <td className={`p-1.5 text-right font-mono font-semibold ${row.balance < 0 ? 'text-destructive' : row.balance > 0 ? 'text-primary' : ''}`}>{formatQty(row.balance)}</td>
                    <td className={`p-1.5 text-right font-mono ${diffPlannedWithdrawn < 0 ? 'text-destructive' : ''}`}>{formatQty(diffPlannedWithdrawn)}</td>
                    <td className="p-1.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${STATUS_BADGE[status]}`}>
                        {MC.STOCK_STATUS_LABEL[status]}
                      </span>
                    </td>
                  </tr>
                );
              })}
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
                onClick={() => setForm(f => ({ ...f, type: 'entrada', taskId: '' }))}
                className={`flex items-center justify-center gap-1 px-2 py-1.5 rounded border text-[11px] ${form.type === 'entrada' ? 'bg-success/10 border-success/40 text-success' : 'border-border text-muted-foreground'}`}
              >
                <ArrowDown className="w-3 h-3" /> Entrada
              </button>
              <button
                onClick={() => setForm(f => ({ ...f, type: 'retirada' }))}
                className={`flex items-center justify-center gap-1 px-2 py-1.5 rounded border text-[11px] ${form.type === 'retirada' ? 'bg-destructive/10 border-destructive/40 text-destructive' : 'border-border text-muted-foreground'}`}
              >
                <ArrowUp className="w-3 h-3" /> Retirada
              </button>
              <button
                onClick={() => setForm(f => ({ ...f, type: 'ajuste', taskId: '' }))}
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
                  <option value="">-- fornecedor --</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              {form.type === 'retirada' && (
                <select
                  value={form.taskId}
                  onChange={e => setForm({ ...form, taskId: e.target.value })}
                  className="h-8 w-full text-xs border border-border rounded px-2 bg-background"
                >
                  <option value="">-- tarefa/capitulo de destino --</option>
                  {tasks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              )}
              <Input
                placeholder="Responsavel"
                value={form.user}
                onChange={e => setForm({ ...form, user: e.target.value })}
                className="h-8 text-xs"
              />
              <Input
                placeholder="Observacao"
                value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                className="h-8 text-xs"
              />
              <Button size="sm" className="h-8 w-full text-xs" onClick={addMove}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Registrar no Almoxarifado
              </Button>
            </div>

            <div className="border-t border-border pt-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                Movimentacoes do Almoxarifado ({movements.length})
              </div>
              <div className="max-h-[300px] overflow-auto space-y-1">
                {movements.length === 0 && (
                  <div className="text-[11px] text-muted-foreground italic">Nenhuma movimentacao ainda.</div>
                )}
                {movements.map(movement => {
                  const sign = movementSign(movement);
                  return (
                    <div key={movement.id} className={`flex items-start gap-2 text-[11px] border border-border rounded px-2 py-1 ${movement.reversedById ? 'opacity-50 line-through' : ''}`}>
                      <div className="flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${
                            sign > 0 ? 'bg-success/10 text-success'
                            : sign < 0 ? 'bg-destructive/10 text-destructive'
                            : 'bg-warning/10 text-warning'
                          }`}>{MOVEMENT_LABEL[movement.type]}</span>
                          <span className="font-mono font-semibold">{formatQty(movement.quantity)} {movement.itemUnit}</span>
                          <span className="text-muted-foreground">{movement.date}</span>
                        </div>
                        {movement.notes && <div className="text-muted-foreground mt-0.5">{movement.notes}</div>}
                        {movement.user && <div className="text-[10px] text-muted-foreground">por {movement.user}</div>}
                        {movement.taskId && <div className="text-[10px] text-muted-foreground">destino: {taskById.get(movement.taskId) ?? movement.taskId}</div>}
                      </div>
                      {!movement.reversedById && movement.type !== 'estorno' && (
                        <button
                          className="text-warning opacity-70 hover:opacity-100"
                          title="Estornar movimento"
                          onClick={() => onProjectChange(reverseMovement(project, movement.id))}
                        >
                          <Undo2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Clique em um insumo da tabela para registrar entradas, retiradas ou ajustes no Almoxarifado.
          </div>
        )}
      </div>
    </div>
  );
}
