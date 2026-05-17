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
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="p-2 border-b border-border bg-muted/30 relative">
        <Search className="w-3.5 h-3.5 absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar insumo..." className="h-8 pl-8 text-xs" />
      </div>
      <div className="max-h-[calc(100vh-280px)] overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted sticky top-0 z-10">
            <tr>
              <th className="p-2 text-left w-24">Código</th>
              <th className="p-2 text-left">Descrição</th>
              <th className="p-2 text-center w-12">Un</th>
              <th className="p-2 text-right w-20">Planej.</th>
              <th className="p-2 text-right w-20">Comprado</th>
              <th className="p-2 text-right w-20">Receb.</th>
              <th className="p-2 text-right w-20">Retirado</th>
              <th className="p-2 text-right w-20">Perdas</th>
              <th className="p-2 text-right w-20">Saldo</th>
              <th className="p-2 text-right w-24">Mínimo</th>
              <th className="p-2 text-left w-24">Último mov.</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.key} className={`border-t border-border ${r.underMin ? 'bg-destructive/5' : ''}`}>
                <td className="p-1.5 font-mono text-[10px]">{r.code || '—'}</td>
                <td className="p-1.5">{r.description}</td>
                <td className="p-1.5 text-center text-muted-foreground">{r.unit}</td>
                <td className="p-1.5 text-right font-mono">{r.planned.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono">{r.purchased.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono text-success">{r.received.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono">{r.withdrawn.toLocaleString('pt-BR')}</td>
                <td className="p-1.5 text-right font-mono text-destructive">{r.losses.toLocaleString('pt-BR')}</td>
                <td className={`p-1.5 text-right font-mono font-semibold ${r.balance < 0 ? 'text-destructive' : r.underMin ? 'text-warning' : ''}`}>{r.balance.toLocaleString('pt-BR')}</td>
                <td className="p-1.5">
                  <input
                    type="number"
                    step="any"
                    defaultValue={r.minStock ?? ''}
                    className="w-20 h-7 text-xs border border-border rounded px-1 text-right bg-background"
                    onBlur={e => setMin(r.key, r.code, r.description, r.unit, parseFloat(e.target.value))}
                  />
                </td>
                <td className="p-1.5 text-[10px] text-muted-foreground">{r.lastMovementDate ?? '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={11} className="p-6 text-center text-muted-foreground italic">Nenhum item encontrado.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
