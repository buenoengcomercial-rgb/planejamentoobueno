import { useMemo, useState } from 'react';
import type { MaterialComparison, Project } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Trophy, TrendingDown, Plus, X, UserPlus } from 'lucide-react';
import { CurrencyInput, formatQty, parseBR, NumberInput } from './numberInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  project: Project;
  comparison: MaterialComparison;
  onApply: (next: MaterialComparison) => void;
  onProjectChange?: (next: Project) => void;
}

export default function ComparisonsTab({ project, comparison, onApply, onProjectChange }: Props) {
  const globalSuppliers = useMemo(() => MC.getProjectSuppliers(project), [project]);
  const suppliers = useMemo(() => MC.getComparisonSuppliers(project, comparison), [project, comparison]);
  const totals = useMemo(() => MC.totalsBySupplier({ ...comparison, suppliers }), [comparison, suppliers]);
  const plan = useMemo(() => MC.optimizedPurchasePlan({ ...comparison, suppliers }), [comparison, suppliers]);
  const supplierMap = useMemo(() => new Map(suppliers.map(s => [s.id, s.name] as const)), [suppliers]);

  const participatingIds = useMemo(() => new Set(suppliers.map(s => s.id)), [suppliers]);
  const availableToAdd = useMemo(
    () => globalSuppliers.filter(s => !participatingIds.has(s.id)),
    [globalSuppliers, participatingIds],
  );

  const [addId, setAddId] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', contact: '', deliveryDays: '', rating: '' });

  const addExisting = (id: string) => {
    if (!id) return;
    onApply(MC.addSupplierToComparison(comparison, id));
    setAddId('');
  };

  const removeParticipant = (id: string, name: string) => {
    if (!confirm(`Remover "${name}" deste comparativo? Os preços lançados por ele neste comparativo deixarão de aparecer.`)) return;
    onApply(MC.removeSupplierFromComparison(comparison, id));
  };

  const createAndLink = () => {
    if (!form.name.trim() || !onProjectChange) return;
    onProjectChange(MC.addProjectSupplierAndLink(project, {
      name: form.name.trim(),
      contact: form.contact || undefined,
      deliveryDays: parseBR(form.deliveryDays),
      rating: parseBR(form.rating),
    }, comparison.id));
    setForm({ name: '', contact: '', deliveryDays: '', rating: '' });
    setShowCreate(false);
  };

  const searchedAvailable = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return availableToAdd;
    return availableToAdd.filter(s =>
      s.name.toLowerCase().includes(q) || (s.contact ?? '').toLowerCase().includes(q),
    );
  }, [availableToAdd, search]);

  return (
    <div className="space-y-4">
      {/* Participantes */}
      <div className="bg-card border border-border rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Fornecedores participantes ({suppliers.length})
          </div>
          {onProjectChange && (
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setShowCreate(v => !v)}>
              <UserPlus className="w-3.5 h-3.5 mr-1" /> Novo fornecedor
            </Button>
          )}
        </div>

        {suppliers.length === 0 ? (
          <div className="text-[11px] text-muted-foreground italic">
            Nenhum fornecedor vinculado. Adicione um do cadastro abaixo.
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {suppliers.map(s => (
              <span key={s.id} className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary border border-primary/30 rounded text-[11px] font-medium">
                {s.name}
                <button
                  onClick={() => removeParticipant(s.id, s.name)}
                  className="hover:bg-primary/20 rounded p-0.5"
                  title="Remover deste comparativo"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar no cadastro global..."
            className="h-7 text-xs w-56"
          />
          <select
            value={addId}
            onChange={e => addExisting(e.target.value)}
            className="h-7 text-xs border border-border rounded px-2 bg-background"
          >
            <option value="">+ Adicionar fornecedor cadastrado…</option>
            {searchedAvailable.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {globalSuppliers.length === 0 && (
            <span className="text-[11px] text-muted-foreground italic">Cadastro global vazio. Use a aba Fornecedores ou “Novo fornecedor”.</span>
          )}
        </div>

        {showCreate && onProjectChange && (
          <div className="grid grid-cols-12 gap-2 pt-2 border-t border-border mt-2">
            <Input className="col-span-4 h-7 text-xs" placeholder="Nome" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            <Input className="col-span-4 h-7 text-xs" placeholder="Contato" value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} />
            <NumberInput className="col-span-2 h-7 text-xs" decimal={false} placeholder="Prazo" value={form.deliveryDays} onChange={v => setForm({ ...form, deliveryDays: v })} />
            <NumberInput className="col-span-1 h-7 text-xs" placeholder="0-5" value={form.rating} onChange={v => setForm({ ...form, rating: v })} />
            <Button size="sm" className="col-span-1 h-7" onClick={createAndLink}><Plus className="w-3.5 h-3.5" /></Button>
          </div>
        )}
      </div>

      {suppliers.length === 0 ? (
        <Empty msg="Adicione fornecedores participantes acima para começar a comparar preços." />
      ) : comparison.items.length === 0 ? (
        <Empty msg="Vincule insumos em 'Insumos do Projeto' para começar a comparar." />
      ) : (
        <>
          {/* Matrix */}
          <div className="bg-card border border-border rounded-xl overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="p-2 text-left min-w-[200px]">Item</th>
                  <th className="p-2">Un.</th>
                  <th className="p-2 text-right">Qtd.</th>
                  <th className="p-2 text-right">Ref.</th>
                  {suppliers.map(s => (
                    <th key={s.id} className="p-2 text-center min-w-[110px]">{s.name}</th>
                  ))}
                  <th className="p-2 text-center">Vencedor</th>
                  <th className="p-2 text-right">Economia</th>
                </tr>
              </thead>
              <tbody>
                {comparison.items.map(it => {
                  const an = MC.analyzeItem({ ...it, prices: it.prices.filter(p => participatingIds.has(p.supplierId)) });
                  return (
                    <tr key={it.id} className="border-t border-border hover:bg-muted/20">
                      <td className="p-2">
                        <div className="font-medium text-foreground">{it.description}</div>
                        {it.code && <div className="text-[10px] text-muted-foreground">{it.code}</div>}
                      </td>
                      <td className="p-2 text-center">{it.unit}</td>
                      <td className="p-2 text-right">{formatQty(it.quantity)}</td>
                      <td className="p-2 text-right">{it.referencePrice ? fmt(it.referencePrice) : '—'}</td>
                      {suppliers.map(s => {
                        const price = it.prices.find(p => p.supplierId === s.id);
                        const isBest = an.bestSupplierId === s.id;
                        return (
                          <td key={s.id} className={`p-1 text-right ${isBest ? 'bg-success/10' : ''}`}>
                            <CurrencyInput
                              value={price?.price ?? undefined}
                              onChange={v => onApply(MC.setItemPrice(comparison, it.id, s.id, v ?? 0))}
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
                  {suppliers.map(s => {
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
        </>
      )}
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
