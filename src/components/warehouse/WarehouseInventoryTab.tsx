import { useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import { computeWarehouseRows, addMovement } from '@/lib/warehouse';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Save } from 'lucide-react';

interface Props { project: Project; onProjectChange: (next: Project) => void; }

export default function WarehouseInventoryTab({ project, onProjectChange }: Props) {
  const rows = useMemo(() => computeWarehouseRows(project), [project]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [user, setUser] = useState('');
  const today = new Date().toISOString().slice(0, 10);

  const apply = () => {
    let next = project;
    let applied = 0;
    for (const r of rows) {
      const v = counts[r.key];
      if (v === undefined || v === '') continue;
      const counted = parseFloat(v.replace(',', '.'));
      if (!Number.isFinite(counted)) continue;
      const diff = +(counted - r.balance).toFixed(2);
      if (Math.abs(diff) < 0.001) continue;
      next = addMovement(next, {
        type: diff > 0 ? 'ajuste_positivo' : 'ajuste_negativo',
        date: today,
        itemKey: r.key,
        itemCode: r.code,
        itemDescription: r.description,
        itemUnit: r.unit,
        quantity: Math.abs(diff),
        user: user || undefined,
        notes: `Inventário: saldo era ${r.balance}, contado ${counted}`,
      });
      applied += 1;
    }
    if (applied > 0) {
      onProjectChange(next);
      setCounts({});
      alert(`${applied} ajuste(s) de inventário aplicado(s).`);
    } else {
      alert('Nenhuma diferença a aplicar.');
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-card border border-border rounded-lg p-2 flex items-center gap-2">
        <Input placeholder="Responsável pela contagem" className="h-8 text-xs max-w-xs" value={user} onChange={e => setUser(e.target.value)} />
        <Button size="sm" onClick={apply}><Save className="w-3.5 h-3.5 mr-1" /> Aplicar contagem como ajustes</Button>
        <span className="text-[11px] text-muted-foreground">Deixe em branco os itens sem contagem.</span>
      </div>
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="max-h-[calc(100vh-320px)] overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted sticky top-0">
              <tr>
                <th className="p-2 text-left">Insumo</th>
                <th className="p-2 text-center w-12">Un</th>
                <th className="p-2 text-right w-24">Saldo atual</th>
                <th className="p-2 text-right w-32">Contado</th>
                <th className="p-2 text-right w-24">Diferença</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const v = counts[r.key];
                const counted = v ? parseFloat(v.replace(',', '.')) : NaN;
                const diff = Number.isFinite(counted) ? +(counted - r.balance).toFixed(2) : null;
                return (
                  <tr key={r.key} className="border-t border-border">
                    <td className="p-1.5">{r.description}</td>
                    <td className="p-1.5 text-center text-muted-foreground">{r.unit}</td>
                    <td className="p-1.5 text-right font-mono">{r.balance.toLocaleString('pt-BR')}</td>
                    <td className="p-1.5">
                      <Input className="h-7 text-xs text-right" type="number" step="any" value={v ?? ''} onChange={e => setCounts({ ...counts, [r.key]: e.target.value })} />
                    </td>
                    <td className={`p-1.5 text-right font-mono ${diff != null && diff < 0 ? 'text-destructive' : diff != null && diff > 0 ? 'text-success' : ''}`}>
                      {diff != null ? diff.toLocaleString('pt-BR') : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
