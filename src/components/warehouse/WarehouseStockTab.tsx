import { useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import { computeWarehouseRows, upsertItemConfig } from '@/lib/warehouse';
import { Input } from '@/components/ui/input';
import { Search } from 'lucide-react';

interface Props { project: Project; onProjectChange: (next: Project) => void; }

export default function WarehouseStockTab({ project, onProjectChange }: Props) {
  const [search, setSearch] = useState('');
  const rows = useMemo(() => computeWarehouseRows(project), [project]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => r.description.toLowerCase().includes(q) || (r.code ?? '').toLowerCase().includes(q));
  }, [rows, search]);

  const setMin = (key: string, code: string | undefined, description: string, unit: string, min: number) => {
    onProjectChange(upsertItemConfig(project, { key, code, description, unit, minStock: Number.isFinite(min) ? min : undefined }));
  };

  return (
    <div className="bg-card border border-border rounded-md overflow-hidden">
      <div className="p-2 border-b border-border bg-muted/30 relative flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar insumo por descrição ou código..." className="h-8 pl-7 text-xs" />
        </div>
        <span className="text-[11px] text-muted-foreground ml-auto">{filtered.length} item(ns)</span>
      </div>
      <div className="max-h-[calc(100vh-300px)] overflow-auto">
        <table className="w-full text-xs table-fixed">
          <colgroup>
            <col className="w-24" />
            <col />
            <col className="w-12" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-24" />
          </colgroup>
          <thead className="bg-muted sticky top-0 z-10">
            <tr className="text-muted-foreground">
              <th className="p-2 text-left font-semibold">Código</th>
              <th className="p-2 text-left font-semibold">Descrição</th>
              <th className="p-2 text-center font-semibold">Un</th>
              <th className="p-2 text-right font-semibold">Planej.</th>
              <th className="p-2 text-right font-semibold">Comprado</th>
              <th className="p-2 text-right font-semibold">Receb.</th>
              <th className="p-2 text-right font-semibold">Retirado</th>
              <th className="p-2 text-right font-semibold">Perdas</th>
              <th className="p-2 text-right font-semibold bg-primary/5">Saldo</th>
              <th className="p-2 text-right font-semibold bg-warning/5">Mínimo</th>
              <th className="p-2 text-left font-semibold">Último mov.</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.key} className={`border-t border-border hover:bg-muted/30 ${r.underMin ? 'bg-destructive/5' : ''}`}>
                <td className="p-1.5 font-mono text-[10px] text-muted-foreground truncate">{r.code || '—'}</td>
                <td className="p-1.5 leading-snug" title={r.description}>{r.description}</td>
                <td className="p-1.5 text-center text-muted-foreground">{r.unit}</td>
                <td className="p-1.5 text-right font-mono tabular-nums">{r.planned.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums">{r.purchased.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums text-success">{r.received.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums">{r.withdrawn.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono tabular-nums text-destructive">{r.losses.toLocaleString('pt-BR')}</td>
                <td className={`p-1.5 text-right font-mono tabular-nums font-bold bg-primary/5 ${r.balance < 0 ? 'text-destructive' : r.underMin ? 'text-warning' : 'text-primary'}`}>{r.balance.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 bg-warning/5">
                  <input
                    type="number"
                    step="any"
                    defaultValue={r.minStock ?? ''}
                    placeholder="—"
                    className="w-full h-7 text-xs border border-border rounded px-1 text-right bg-background font-mono"
                    onBlur={e => setMin(r.key, r.code, r.description, r.unit, parseFloat(e.target.value))}
                  />
                </td>
                <td className="p-1.5 text-[10px] text-muted-foreground">{r.lastMovementDate ?? '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={11} className="p-8 text-center text-muted-foreground italic">Nenhum item encontrado.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
