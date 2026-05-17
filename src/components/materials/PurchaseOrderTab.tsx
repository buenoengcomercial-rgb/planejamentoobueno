import { useMemo } from 'react';
import type { MaterialComparison, Project } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Button } from '@/components/ui/button';
import { ShoppingCart, Printer, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

interface Props { project: Project; comparison: MaterialComparison }

export default function PurchaseOrderTab({ project, comparison }: Props) {
  const suppliers = useMemo(() => MC.getComparisonSuppliers(project, comparison), [project, comparison]);
  const plan = useMemo(() => MC.optimizedPurchasePlan({ ...comparison, suppliers }), [comparison, suppliers]);
  const grouped = useMemo(() => {
    const map = new Map<string, { supplierName: string; rows: typeof plan.rows }>();
    for (const r of plan.rows) {
      const cur = map.get(r.supplierId) ?? { supplierName: r.supplierName, rows: [] };
      cur.rows.push(r);
      map.set(r.supplierId, cur);
    }
    return Array.from(map.entries());
  }, [plan]);

  const unresolvedDetails = useMemo(
    () => plan.unresolvedItems
      .map(u => comparison.items.find(i => i.id === u.itemId))
      .filter((x): x is NonNullable<typeof x> => !!x),
    [plan, comparison.items],
  );

  if (plan.rows.length === 0 && unresolvedDetails.length === 0) {
    return <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
      Vincule insumos e cadastre preços para gerar pedidos.
    </div>;
  }

  const print = () => window.print();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShoppingCart className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">Pedidos sugeridos por fornecedor (plano otimizado)</h3>
        </div>
        <Button size="sm" variant="outline" onClick={print}>
          <Printer className="w-3.5 h-3.5 mr-1" /> Imprimir
        </Button>
      </div>

      {grouped.map(([supplierId, group]) => {
        const total = group.rows.reduce((s, r) => s + r.total, 0);
        return (
          <div key={supplierId} className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
              <div className="text-sm font-semibold">{group.supplierName}</div>
              <div className="text-xs text-muted-foreground">{group.rows.length} item(s) · <span className="font-bold text-primary">R$ {total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span></div>
            </div>
            <table className="w-full text-xs">
              <thead className="bg-muted">
                <tr>
                  <th className="p-2 text-left">Descrição</th>
                  <th className="p-2">Un.</th>
                  <th className="p-2 text-right">Qtd.</th>
                  <th className="p-2 text-right">Preço un.</th>
                  <th className="p-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map(r => (
                  <tr key={r.itemId} className="border-t border-border">
                    <td className="p-2">{r.description}</td>
                    <td className="p-2 text-center">{r.unit}</td>
                    <td className="p-2 text-right">{r.quantity.toLocaleString('pt-BR')}</td>
                    <td className="p-2 text-right">R$ {r.unitPrice.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                    <td className="p-2 text-right font-medium">R$ {r.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-3 flex justify-end">
              <Button size="sm" variant="outline" onClick={() => toast.info('Pedido de compra completo será integrado em uma próxima etapa.')}>
                Gerar pedido (em breve)
              </Button>
            </div>
          </div>
        );
      })}

      {unresolvedDetails.length > 0 && (
        <div className="bg-card border border-warning/40 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-warning/40 bg-warning/10 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <div className="text-sm font-semibold">Sem fornecedor vencedor</div>
            <div className="text-xs text-muted-foreground ml-auto">{unresolvedDetails.length} item(s) sem cotação</div>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-muted">
              <tr>
                <th className="p-2 text-left">Código</th>
                <th className="p-2 text-left">Descrição</th>
                <th className="p-2">Un.</th>
                <th className="p-2 text-right">Qtd.</th>
              </tr>
            </thead>
            <tbody>
              {unresolvedDetails.map(it => (
                <tr key={it.id} className="border-t border-border">
                  <td className="p-2 font-mono text-[11px]">{it.code || '—'}</td>
                  <td className="p-2">{it.description}</td>
                  <td className="p-2 text-center">{it.unit}</td>
                  <td className="p-2 text-right">{it.quantity.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
