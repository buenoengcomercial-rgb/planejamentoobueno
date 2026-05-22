import { useMemo } from 'react';
import type { MaterialComparison, Project } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Button } from '@/components/ui/button';
import { ShoppingCart, Printer, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  project: Project;
  comparison: MaterialComparison;
  onProjectChange: (next: Project) => void;
}

export default function PurchaseOrderTab({ project, comparison, onProjectChange }: Props) {
  const suppliers = useMemo(() => MC.getComparisonSuppliers(project, comparison), [project, comparison]);
  const plan = useMemo(() => MC.optimizedPurchasePlan({ ...comparison, suppliers }), [comparison, suppliers]);
  const grouped = useMemo(() => {
    const map = new Map<string, { supplierName: string; rows: typeof plan.rows }>();
    for (const row of plan.rows) {
      const current = map.get(row.supplierId) ?? { supplierName: row.supplierName, rows: [] };
      current.rows.push(row);
      map.set(row.supplierId, current);
    }
    return Array.from(map.entries());
  }, [plan]);

  const unresolvedDetails = useMemo(
    () => plan.unresolvedItems
      .map(unresolved => comparison.items.find(item => item.id === unresolved.itemId))
      .filter((item): item is NonNullable<typeof item> => !!item),
    [plan, comparison.items],
  );

  const confirmSupplierOrder = (supplierId: string, rows: typeof plan.rows) => {
    if (rows.length === 0) return;

    let nextComparison = comparison;
    for (const row of rows) {
      nextComparison = MC.updateItem(nextComparison, row.itemId, {
        chosenSupplierId: supplierId,
        status: 'comprado',
      });
    }

    const hasItems = nextComparison.items.length > 0;
    const allPurchased = hasItems && nextComparison.items.every(item => item.status === 'comprado');
    if (allPurchased) {
      nextComparison = MC.setComparisonStatus(nextComparison, 'comprado');
    }

    onProjectChange(MC.upsertComparison(project, nextComparison));
    toast.success(`${rows.length} item(ns) marcados como comprados. O Almoxarifado ja pode controlar recebimento e saldo.`);
  };

  if (plan.rows.length === 0 && unresolvedDetails.length === 0) {
    return (
      <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
        Vincule insumos e cadastre precos para gerar pedidos.
      </div>
    );
  }

  const print = () => window.print();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShoppingCart className="w-4 h-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">Pedidos sugeridos por fornecedor</h3>
            <p className="text-[11px] text-muted-foreground">
              Confirmar um pedido marca os itens como comprados e alimenta o controle de estoque do Almoxarifado.
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={print}>
          <Printer className="w-3.5 h-3.5 mr-1" /> Imprimir
        </Button>
      </div>

      {grouped.map(([supplierId, group]) => {
        const total = group.rows.reduce((sum, row) => sum + row.total, 0);
        const allGroupRowsPurchased = group.rows.every(row => {
          const item = comparison.items.find(current => current.id === row.itemId);
          return item?.status === 'comprado' && item.chosenSupplierId === supplierId;
        });

        return (
          <div key={supplierId} className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-muted/30 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">{group.supplierName}</div>
                <div className="text-xs text-muted-foreground">
                  {group.rows.length} item(s) - <span className="font-bold text-primary">R$ {total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant={allGroupRowsPurchased ? 'secondary' : 'default'}
                onClick={() => confirmSupplierOrder(supplierId, group.rows)}
              >
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                {allGroupRowsPurchased ? 'Pedido confirmado' : 'Confirmar pedido'}
              </Button>
            </div>
            <table className="w-full text-xs">
              <thead className="bg-muted">
                <tr>
                  <th className="p-2 text-left">Descricao</th>
                  <th className="p-2">Un.</th>
                  <th className="p-2 text-right">Qtd.</th>
                  <th className="p-2 text-right">Preco un.</th>
                  <th className="p-2 text-right">Total</th>
                  <th className="p-2 text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map(row => {
                  const item = comparison.items.find(current => current.id === row.itemId);
                  const purchased = item?.status === 'comprado' && item.chosenSupplierId === supplierId;
                  return (
                    <tr key={row.itemId} className="border-t border-border">
                      <td className="p-2">{row.description}</td>
                      <td className="p-2 text-center">{row.unit}</td>
                      <td className="p-2 text-right">{row.quantity.toLocaleString('pt-BR')}</td>
                      <td className="p-2 text-right">R$ {row.unitPrice.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                      <td className="p-2 text-right font-medium">R$ {row.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                      <td className="p-2 text-center">
                        <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium ${
                          purchased
                            ? 'border-success/40 bg-success/10 text-success'
                            : 'border-border bg-muted/40 text-muted-foreground'
                        }`}>
                          {purchased ? 'Comprado' : 'A confirmar'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      {unresolvedDetails.length > 0 && (
        <div className="bg-card border border-warning/40 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-warning/40 bg-warning/10 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <div className="text-sm font-semibold">Sem fornecedor vencedor</div>
            <div className="text-xs text-muted-foreground ml-auto">{unresolvedDetails.length} item(s) sem cotacao</div>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-muted">
              <tr>
                <th className="p-2 text-left">Codigo</th>
                <th className="p-2 text-left">Descricao</th>
                <th className="p-2">Un.</th>
                <th className="p-2 text-right">Qtd.</th>
              </tr>
            </thead>
            <tbody>
              {unresolvedDetails.map(item => (
                <tr key={item.id} className="border-t border-border">
                  <td className="p-2 font-mono text-[11px]">{item.code || '-'}</td>
                  <td className="p-2">{item.description}</td>
                  <td className="p-2 text-center">{item.unit}</td>
                  <td className="p-2 text-right">{item.quantity.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
