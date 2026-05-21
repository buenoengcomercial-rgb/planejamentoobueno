import { useMemo, useState } from 'react';
import type { MaterialComparison, Project } from '@/types/project';
import * as MC from '@/lib/materialComparisons';
import { Trophy, TrendingDown, Plus, X, UserPlus } from 'lucide-react';
import { CurrencyInput, formatQty, parseBR, NumberInput } from './numberInput';
import { Button } from '@/components/ui/button';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { Input } from '@/components/ui/input';

interface Props {
  project: Project;
  comparison: MaterialComparison;
  onApply: (next: MaterialComparison) => void;
  onProjectChange?: (next: Project | ((prev: Project) => Project)) => void;
  hideSupplierManager?: boolean;
}

const supplierColumnTones = [
  { header: 'bg-emerald-100/95 text-emerald-950 border-emerald-200', cell: 'bg-emerald-50/55', input: 'focus-visible:ring-emerald-300' },
  { header: 'bg-sky-100/95 text-sky-950 border-sky-200', cell: 'bg-sky-50/55', input: 'focus-visible:ring-sky-300' },
  { header: 'bg-amber-100/95 text-amber-950 border-amber-200', cell: 'bg-amber-50/55', input: 'focus-visible:ring-amber-300' },
  { header: 'bg-violet-100/95 text-violet-950 border-violet-200', cell: 'bg-violet-50/55', input: 'focus-visible:ring-violet-300' },
  { header: 'bg-rose-100/95 text-rose-950 border-rose-200', cell: 'bg-rose-50/55', input: 'focus-visible:ring-rose-300' },
  { header: 'bg-cyan-100/95 text-cyan-950 border-cyan-200', cell: 'bg-cyan-50/55', input: 'focus-visible:ring-cyan-300' },
];

function supplierTone(index: number) {
  return supplierColumnTones[index % supplierColumnTones.length];
}

export default function ComparisonsTab({ project, comparison, onApply, onProjectChange, hideSupplierManager = false }: Props) {
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
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
    confirm(
      {
        title: `Remover "${name}" deste comparativo?`,
        description: <p>Os preços lançados por este fornecedor neste comparativo deixarão de aparecer.</p>,
        confirmLabel: 'Remover fornecedor',
      },
      () => onApply(MC.removeSupplierFromComparison(comparison, id)),
    );
  };

  const createAndLink = () => {
    if (!form.name.trim() || !onProjectChange) return;
    onProjectChange(prev => MC.addProjectSupplierAndLink(prev, {
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
      {!hideSupplierManager && (
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
              <option value="">+ Adicionar fornecedor cadastrado...</option>
              {searchedAvailable.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {globalSuppliers.length === 0 && (
              <span className="text-[11px] text-muted-foreground italic">Cadastro global vazio. Use a aba Fornecedores ou "Novo fornecedor".</span>
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
      )}

      {suppliers.length === 0 ? (
        <Empty msg="Adicione fornecedores participantes acima para começar a comparar preços." />
      ) : comparison.items.length === 0 ? (
        <Empty msg="Vincule insumos em 'Insumos do Projeto' para começar a comparar." />
      ) : (
        <>
          <div className="bg-card border border-border rounded-xl overflow-auto max-h-[calc(100vh-285px)] shadow-sm">
            <table className="w-full text-xs border-separate border-spacing-0">
              <thead className="sticky top-0 z-30">
                <tr>
                  <th className="p-2.5 text-left min-w-[360px] bg-muted border-b border-border">Item</th>
                  <th className="p-2.5 text-center bg-muted border-b border-border">Un.</th>
                  <th className="p-2.5 text-center bg-muted border-b border-border">Qtd.</th>
                  <th className="p-2.5 text-center bg-muted border-b border-border">Ref.</th>
                  {suppliers.map((s, supplierIndex) => {
                    const tone = supplierTone(supplierIndex);
                    return (
                      <th key={s.id} className={`p-2.5 text-center min-w-[135px] border-b border-l ${tone.header}`}>
                        <span className="block truncate" title={s.name}>{s.name}</span>
                      </th>
                    );
                  })}
                  <th className="p-2.5 text-center bg-muted border-b border-border">Vencedor</th>
                  <th className="p-2.5 text-center bg-muted border-b border-border">Economia</th>
                </tr>
              </thead>
              <tbody>
                {comparison.items.map((it, rowIndex) => {
                  const an = MC.analyzeItem({ ...it, prices: it.prices.filter(p => participatingIds.has(p.supplierId)) });
                  const rowTone = rowIndex % 2 === 0 ? 'bg-background' : 'bg-slate-50/80';
                  return (
                    <tr key={it.id} className={`${rowTone} hover:bg-primary/5 transition-colors`}>
                      <td className="p-2.5 align-middle border-b border-border">
                        <div className="font-semibold text-foreground leading-snug">{it.description}</div>
                        {it.code && <div className="mt-0.5 text-[10px] text-muted-foreground">{it.code}</div>}
                      </td>
                      <td className="p-2.5 align-middle text-center border-b border-border font-medium">{it.unit}</td>
                      <td className="p-2.5 align-middle text-center border-b border-border tabular-nums">{formatQty(it.quantity)}</td>
                      <td className="p-2.5 align-middle text-center border-b border-border tabular-nums">{it.referencePrice ? fmt(it.referencePrice) : '—'}</td>
                      {suppliers.map((s, supplierIndex) => {
                        const price = it.prices.find(p => p.supplierId === s.id);
                        const isBest = an.bestSupplierId === s.id;
                        const tone = supplierTone(supplierIndex);
                        return (
                          <td key={s.id} className={`p-1.5 align-middle border-b border-l border-border ${tone.cell} ${isBest ? 'bg-success/15' : ''}`}>
                            <CurrencyInput
                              value={price?.price ?? undefined}
                              onChange={v => onApply(MC.setItemPrice(comparison, it.id, s.id, v ?? 0))}
                              data-material-price-input="true"
                              data-supplier-id={s.id}
                              className={`h-8 text-xs text-center tabular-nums ${tone.input} ${isBest ? 'border-success font-semibold text-success shadow-[0_0_0_1px_rgba(34,197,94,0.25)]' : 'bg-background/80'}`}
                            />
                          </td>
                        );
                      })}
                      <td className="p-2.5 align-middle text-center border-b border-border">
                        {an.chosenSupplierId ? (
                          <span className="inline-flex items-center justify-center gap-1 text-success font-semibold">
                            <Trophy className="w-3 h-3" />
                            {supplierMap.get(an.chosenSupplierId)}
                          </span>
                        ) : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className={`p-2.5 align-middle text-center border-b border-border font-semibold tabular-nums ${an.savings && an.savings > 0 ? 'text-success' : 'text-muted-foreground'}`}>
                        {an.savings != null ? `${fmt(an.savings)} (${an.savingsPct?.toFixed(1)}%)` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="sticky bottom-0 z-20 bg-muted/95 font-semibold shadow-[0_-1px_0_rgba(15,23,42,0.08)]">
                <tr>
                  <td className="p-2.5 border-t border-border" colSpan={4}>Total por fornecedor</td>
                  {suppliers.map((s, supplierIndex) => {
                    const t = totals.find(x => x.supplierId === s.id);
                    const tone = supplierTone(supplierIndex);
                    return <td key={s.id} className={`p-2.5 text-center border-t border-l border-border tabular-nums ${tone.cell}`}>{t ? fmt(t.total) : '—'}</td>;
                  })}
                  <td className="p-2.5 border-t border-border"></td>
                  <td className="p-2.5 border-t border-border"></td>
                </tr>
              </tfoot>
            </table>
          </div>

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
      {confirmDialog}
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
