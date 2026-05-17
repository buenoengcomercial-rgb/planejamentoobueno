import { useMemo } from 'react';
import type { MaterialComparison } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Trophy, TrendingDown } from 'lucide-react';
import { CurrencyInput, formatQty } from './numberInput';

interface Props {
  comparison: MaterialComparison;
  onApply: (next: MaterialComparison) => void;
}

export default function ComparisonsTab({ comparison, onApply }: Props) {
  const totals = useMemo(() => MC.totalsBySupplier(comparison), [comparison]);
  const plan = useMemo(() => MC.optimizedPurchasePlan(comparison), [comparison]);
  const supplierMap = useMemo(() => new Map(comparison.suppliers.map(s => [s.id, s.name] as const)), [comparison.suppliers]);

  if (comparison.suppliers.length === 0) {
    return <Empty msg="Cadastre fornecedores na aba 'Fornecedores' para começar a comparar preços." />;
  }
  if (comparison.items.length === 0) {
    return <Empty msg="Adicione itens na aba 'Materiais' para começar a comparar." />;
  }

  return (
    <div className="space-y-4">
      {/* Matrix */}
      <div className="bg-card border border-border rounded-xl overflow-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted sticky top-0">
            <tr>
              <th className="p-2 text-left min-w-[200px]">Item</th>
              <th className="p-2">Un.</th>
              <th className="p-2 text-right">Qtd.</th>
              <th className="p-2 text-right">Ref.</th>
              {comparison.suppliers.map(s => (
                <th key={s.id} className="p-2 text-center min-w-[110px]">{s.name}</th>
              ))}
              <th className="p-2 text-center">Vencedor</th>
              <th className="p-2 text-right">Economia</th>
            </tr>
          </thead>
          <tbody>
            {comparison.items.map(it => {
              const an = MC.analyzeItem(it);
              return (
                <tr key={it.id} className="border-t border-border hover:bg-muted/20">
                  <td className="p-2">
                    <div className="font-medium text-foreground">{it.description}</div>
                    {it.code && <div className="text-[10px] text-muted-foreground">{it.code}</div>}
                  </td>
                  <td className="p-2 text-center">{it.unit}</td>
                  <td className="p-2 text-right">{formatQty(it.quantity)}</td>
                  <td className="p-2 text-right">{it.referencePrice ? fmt(it.referencePrice) : '—'}</td>
                  {comparison.suppliers.map(s => {
                    const price = it.prices.find(p => p.supplierId === s.id);
                    const isBest = an.bestSupplierId === s.id;
                    return (
                      <td key={s.id} className={`p-1 text-right ${isBest ? 'bg-success/10' : ''}`}>
                        <CurrencyInput
                          value={price?.price ?? undefined}
                          onChange={v => {
                            onApply(MC.setItemPrice(comparison, it.id, s.id, v ?? 0));
                          }}
                          className={`h-7 text-xs text-right ${isBest ? 'border-success font-semibold text-success' : ''}`}
                        />
                      </td>
                    );
                  })}
                  <td className="p-2 text-center">
                    {an.chosenSupplierId ? (
                      <span className="inline-flex items-center gap-1 text-success font-medium">
                        <Trophy className="w-3 h-3" />
                        {supplierMap.get(an.chosenSupplierId)}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className={`p-2 text-right font-medium ${an.savings && an.savings > 0 ? 'text-success' : 'text-muted-foreground'}`}>
                    {an.savings != null ? `${fmt(an.savings)} (${an.savingsPct?.toFixed(1)}%)` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-muted/50 font-semibold">
            <tr>
              <td className="p-2" colSpan={4}>Total por fornecedor</td>
              {comparison.suppliers.map(s => {
                const t = totals.find(x => x.supplierId === s.id);
                return <td key={s.id} className="p-2 text-right">{t ? fmt(t.total) : '—'}</td>;
              })}
              <td className="p-2"></td>
              <td className="p-2"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Optimized plan */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <TrendingDown className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">Plano otimizado de compra</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
          <Stat label="Custo otimizado" value={fmt(plan.totalCost)} />
          <Stat label="Custo referência" value={fmt(plan.referenceTotal)} />
          <Stat label="Economia" value={`${fmt(plan.savings)} (${plan.savingsPct.toFixed(1)}%)`} accent="text-success" />
          <Stat label="Itens sem cotação" value={plan.unresolvedItems.length.toString()} accent={plan.unresolvedItems.length ? 'text-warning' : undefined} />
        </div>
        {plan.bySupplier.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {plan.bySupplier.map(s => (
              <div key={s.supplierId} className="border border-border rounded-lg p-3 bg-muted/20">
                <div className="text-xs font-semibold">{s.supplierName}</div>
                <div className="text-[10px] text-muted-foreground">{s.itemsCount} item(s)</div>
                <div className="text-sm font-bold text-primary mt-1">{fmt(s.total)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center text-sm text-muted-foreground">{msg}</div>;
}
function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="border border-border rounded-lg p-3 bg-background">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className={`text-base font-bold mt-1 ${accent ?? 'text-foreground'}`}>{value}</div>
    </div>
  );
}
function fmt(n: number) {
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
