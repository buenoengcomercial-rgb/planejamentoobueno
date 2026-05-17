import type { Project } from '@/types/project';
import { panelSummary, computeWarehouseRows } from '@/lib/warehouse';
import { useMemo } from 'react';

interface Props { project: Project; }

const Card = ({ label, value, tone }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'danger' | 'primary' }) => {
  const toneClass =
    tone === 'ok' ? 'text-success' :
    tone === 'warn' ? 'text-warning' :
    tone === 'danger' ? 'text-destructive' :
    tone === 'primary' ? 'text-primary' : 'text-foreground';
  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>
      <div className={`text-lg font-bold ${toneClass}`}>{typeof value === 'number' ? value.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : value}</div>
    </div>
  );
};

export default function WarehousePanel({ project }: Props) {
  const s = useMemo(() => panelSummary(project), [project]);
  const rows = useMemo(() => computeWarehouseRows(project), [project]);
  const underMin = rows.filter(r => r.underMin).slice(0, 8);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
        <Card label="Planejado" value={s.totalPlanned} />
        <Card label="Comprado" value={s.totalPurchased} tone="primary" />
        <Card label="Recebido" value={s.totalReceived} tone="ok" />
        <Card label="Retirado" value={s.totalWithdrawn} />
        <Card label="Perdas" value={s.totalLosses} tone="danger" />
        <Card label="Saldo em estoque" value={s.totalBalance} tone="primary" />
        <Card label="Saldo a comprar" value={s.totalToPurchase} tone="warn" />
        <Card label="Abaixo do mínimo" value={s.underMinCount} tone="danger" />
        <Card label="Termos em aberto" value={s.openCustodyCount} />
        <Card label="Termos vencidos" value={s.overdueCustodyCount} tone="danger" />
        <Card label="Divergência > 10%" value={s.divergenceCount} tone="warn" />
        <Card label="Total de insumos" value={rows.length} />
      </div>

      <div className="bg-card border border-border rounded-lg p-3">
        <div className="text-xs font-semibold mb-2">Materiais abaixo do estoque mínimo</div>
        {underMin.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">Nenhum item abaixo do mínimo.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left p-1">Descrição</th>
                <th className="text-center p-1">Un</th>
                <th className="text-right p-1">Saldo</th>
                <th className="text-right p-1">Mínimo</th>
              </tr>
            </thead>
            <tbody>
              {underMin.map(r => (
                <tr key={r.key} className="border-t border-border">
                  <td className="p-1">{r.description}</td>
                  <td className="p-1 text-center">{r.unit}</td>
                  <td className="p-1 text-right font-mono text-destructive">{r.balance.toLocaleString('pt-BR')}</td>
                  <td className="p-1 text-right font-mono">{r.minStock?.toLocaleString('pt-BR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
