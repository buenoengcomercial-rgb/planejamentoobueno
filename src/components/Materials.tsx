import { useMemo, useState } from 'react';
import { Project } from '@/types/project';
import { useMaterialComparisons } from '@/hooks/useMaterialComparisons';
import * as MC from '@/lib/materialComparisons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { Input } from '@/components/ui/input';
import {
  Boxes,
  History,
  ListChecks,
  Lock,
  Plus,
  ShoppingCart,
  Trash2,
  Truck,
  UserPlus,
  Users,
  Warehouse,
  X,
} from 'lucide-react';
import MaterialsListTab from './materials/MaterialsListTab';
import ComparisonsTab from './materials/ComparisonsTab';
import SuppliersTab from './materials/SuppliersTab';
import PriceHistoryTab from './materials/PriceHistoryTab';
import PurchaseOrderTab from './materials/PurchaseOrderTab';
import StockTab from './materials/StockTab';
import { NumberInput, parseBR } from './materials/numberInput';

interface Props {
  project: Project;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
}

export default function Materials({ project, onProjectChange }: Props) {
  const ctl = useMaterialComparisons(project, onProjectChange);
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const [newName, setNewName] = useState('');
  const [tab, setTab] = useState('comparativo');
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierToAdd, setSupplierToAdd] = useState('');
  const [showSupplierCreate, setShowSupplierCreate] = useState(false);
  const [supplierForm, setSupplierForm] = useState({ name: '', contact: '', deliveryDays: '', rating: '' });

  const summary = useMemo(() => {
    const all = ctl.comparisons;
    const totalEconomy = all.reduce((s, c) => s + MC.optimizedPurchasePlan(c).savings, 0);
    return {
      count: all.length,
      open: all.filter(c => c.status === 'em_cotacao' || c.status === 'rascunho').length,
      closed: all.filter(c => c.status === 'fechado' || c.status === 'comprado').length,
      totalEconomy,
    };
  }, [ctl.comparisons]);

  const globalSuppliers = useMemo(() => MC.getProjectSuppliers(project), [project]);
  const activeSuppliers = useMemo(
    () => ctl.active ? MC.getComparisonSuppliers(project, ctl.active) : [],
    [project, ctl.active],
  );
  const activeSupplierIds = useMemo(
    () => new Set(activeSuppliers.map(s => s.id)),
    [activeSuppliers],
  );
  const availableSuppliers = useMemo(() => {
    const q = supplierSearch.trim().toLowerCase();
    return globalSuppliers.filter(s => {
      if (activeSupplierIds.has(s.id)) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || (s.contact ?? '').toLowerCase().includes(q);
    });
  }, [activeSupplierIds, globalSuppliers, supplierSearch]);

  const createComparison = () => {
    const name = newName.trim() || `Grupo ${ctl.comparisons.length + 1}`;
    ctl.createNew(name);
    setNewName('');
    setTab('comparativo');
  };

  const addExistingSupplier = (id: string) => {
    if (!ctl.active || !id) return;
    ctl.apply(MC.addSupplierToComparison(ctl.active, id));
    setSupplierToAdd('');
  };

  const createAndLinkSupplier = () => {
    if (!ctl.active || !supplierForm.name.trim()) return;
    const comparisonId = ctl.active.id;
    onProjectChange(prev => MC.addProjectSupplierAndLink(prev, {
      name: supplierForm.name.trim(),
      contact: supplierForm.contact.trim() || undefined,
      deliveryDays: parseBR(supplierForm.deliveryDays),
      rating: parseBR(supplierForm.rating),
    }, comparisonId));
    setSupplierForm({ name: '', contact: '', deliveryDays: '', rating: '' });
    setShowSupplierCreate(false);
  };

  const removeActiveSupplier = (id: string, name: string) => {
    if (!ctl.active) return;
    confirm(
      {
        title: `Remover "${name}" deste grupo?`,
        description: (
          <p>
            Os preços lançados por este fornecedor neste grupo deixarão de aparecer na cotação.
          </p>
        ),
        confirmLabel: 'Remover fornecedor',
      },
      () => ctl.apply(MC.removeSupplierFromComparison(ctl.active!, id)),
    );
  };

  const deleteActiveComparison = () => {
    if (!ctl.active) return;
    const activeId = ctl.active.id;
    confirm(
      {
        title: `Excluir grupo "${ctl.active.name}"?`,
        description: (
          <p>
            Esta ação removerá o grupo atual e seus lançamentos vinculados nesta tela.
          </p>
        ),
        confirmLabel: 'Excluir grupo',
      },
      () => ctl.remove(activeId),
    );
  };

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-bold text-foreground">Lista de Material</h2>
          <span className="text-[11px] text-muted-foreground">
            Comparativos: <strong className="text-foreground">{summary.count}</strong>
            <span className="mx-1.5">·</span>
            Em aberto: <strong className="text-foreground">{summary.open}</strong>
            <span className="mx-1.5">·</span>
            Fechados: <strong className="text-foreground">{summary.closed}</strong>
            <span className="mx-1.5">·</span>
            Economia: <strong className="text-success">R$ {summary.totalEconomy.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(360px,0.9fr)_minmax(460px,1.1fr)] gap-3">
        <section className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/40">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Grupos de compra</div>
              <div className="text-[11px] text-muted-foreground">Comparativos da obra</div>
            </div>
            <Button size="sm" className="h-8" onClick={createComparison}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Grupo
            </Button>
          </div>
          <div className="p-3 border-b border-border">
            <Input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Nome do novo grupo"
              className="h-8 text-xs"
              onKeyDown={e => {
                if (e.key === 'Enter') createComparison();
              }}
            />
          </div>
          <div className="max-h-[265px] overflow-y-auto">
            {ctl.comparisons.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">Crie um grupo para começar.</div>
            ) : (
              ctl.comparisons.map((c, index) => {
                const selected = ctl.activeId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      ctl.setActiveId(c.id);
                      setTab('comparativo');
                    }}
                    className={`w-full grid grid-cols-[26px_74px_1fr_auto] items-center gap-2 px-3 py-2 text-left border-b border-border last:border-b-0 transition-colors ${
                      selected ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted/60'
                    }`}
                  >
                    <span className={`w-3.5 h-3.5 rounded-full border ${selected ? 'border-primary-foreground bg-primary-foreground/20' : 'border-muted-foreground/40'}`} />
                    <span className={`font-mono text-[11px] ${selected ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                      CMP{String(index + 1).padStart(4, '0')}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold">{c.name}</span>
                      <span className={`inline-flex mt-0.5 px-1.5 py-0.5 rounded text-[9px] ${
                        selected ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground'
                      }`}>
                        {MC.STATUS_LABEL[c.status]}
                      </span>
                    </span>
                    <span className="text-[11px] font-medium">{c.items.length} itens</span>
                  </button>
                );
              })
            )}
          </div>
          {ctl.active && (
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border bg-muted/30">
              {ctl.active.status !== 'fechado' && ctl.active.status !== 'comprado' ? (
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => ctl.close(ctl.active!.id)}>
                  <Lock className="w-3 h-3 mr-1" /> Fechar grupo
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">Grupo fechado</span>
              )}
              <Button size="sm" variant="ghost" className="h-7 text-[11px] text-destructive" onClick={deleteActiveComparison}>
                <Trash2 className="w-3 h-3 mr-1" /> Excluir
              </Button>
            </div>
          )}
        </section>

        <section className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/40">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fornecedores do grupo</div>
              <div className="text-[11px] text-muted-foreground truncate max-w-[360px]">
                {ctl.active ? ctl.active.name : 'Selecione um grupo'}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Users className="w-3.5 h-3.5" /> Cadastrados: {globalSuppliers.length}
              </span>
              <Button size="sm" className="h-8" disabled={!ctl.active} onClick={() => setShowSupplierCreate(v => !v)}>
                <UserPlus className="w-3.5 h-3.5 mr-1" /> Novo
              </Button>
            </div>
          </div>

          <div className="p-3 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)] gap-2">
              <Input
                value={supplierSearch}
                onChange={e => setSupplierSearch(e.target.value)}
                placeholder="Buscar fornecedor cadastrado"
                className="h-8 text-xs"
                disabled={!ctl.active}
              />
              <select
                value={supplierToAdd}
                onChange={e => {
                  setSupplierToAdd(e.target.value);
                  addExistingSupplier(e.target.value);
                }}
                disabled={!ctl.active || availableSuppliers.length === 0}
                className="h-8 text-xs border border-border rounded-md px-2 bg-background disabled:opacity-60"
              >
                <option value="">+ Adicionar fornecedor cadastrado</option>
                {availableSuppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            {showSupplierCreate && ctl.active && (
              <div className="grid grid-cols-12 gap-2 p-2 border border-dashed border-border rounded-lg bg-muted/20">
                <Input className="col-span-12 md:col-span-4 h-8 text-xs" placeholder="Nome do fornecedor" value={supplierForm.name} onChange={e => setSupplierForm({ ...supplierForm, name: e.target.value })} />
                <Input className="col-span-12 md:col-span-4 h-8 text-xs" placeholder="Contato" value={supplierForm.contact} onChange={e => setSupplierForm({ ...supplierForm, contact: e.target.value })} />
                <NumberInput className="col-span-5 md:col-span-2 h-8 text-xs" decimal={false} placeholder="Prazo" value={supplierForm.deliveryDays} onChange={v => setSupplierForm({ ...supplierForm, deliveryDays: v })} />
                <NumberInput className="col-span-4 md:col-span-1 h-8 text-xs" placeholder="0-5" value={supplierForm.rating} onChange={v => setSupplierForm({ ...supplierForm, rating: v })} />
                <Button size="sm" className="col-span-3 md:col-span-1 h-8" onClick={createAndLinkSupplier}>
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}

            <div className="border border-border rounded-lg overflow-hidden">
              <div className="grid grid-cols-[42px_1fr_120px_110px_34px] gap-2 px-3 py-2 bg-muted text-[11px] font-semibold text-muted-foreground">
                <span>Nº</span>
                <span>Fornecedor</span>
                <span>Prazo</span>
                <span>Avaliação</span>
                <span />
              </div>
              <div className="max-h-[185px] overflow-y-auto">
                {!ctl.active ? (
                  <div className="p-5 text-center text-xs text-muted-foreground">Selecione um grupo para ver os fornecedores.</div>
                ) : activeSuppliers.length === 0 ? (
                  <div className="p-5 text-center text-xs text-muted-foreground">Nenhum fornecedor vinculado a este grupo.</div>
                ) : (
                  activeSuppliers.map((supplier, index) => (
                    <div key={supplier.id} className="grid grid-cols-[42px_1fr_120px_110px_34px] gap-2 items-center px-3 py-2 border-t border-border text-xs">
                      <span className="font-mono text-primary">{index + 1}</span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{supplier.name}</span>
                        {supplier.contact && <span className="block truncate text-[10px] text-muted-foreground">{supplier.contact}</span>}
                      </span>
                      <span className="text-muted-foreground">{supplier.deliveryDays ? `${supplier.deliveryDays} dias` : '-'}</span>
                      <span className="text-muted-foreground">{supplier.rating ? supplier.rating.toLocaleString('pt-BR') : '-'}</span>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="Remover deste grupo"
                        onClick={() => removeActiveSupplier(supplier.id, supplier.name)}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      {ctl.active ? (
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="bg-muted h-9">
            <TabsTrigger value="comparativo" className="text-xs"><ListChecks className="w-3.5 h-3.5 mr-1" /> Cotação ({ctl.active.items.length})</TabsTrigger>
            <TabsTrigger value="insumos" className="text-xs"><Boxes className="w-3.5 h-3.5 mr-1" /> Insumos do Projeto</TabsTrigger>
            <TabsTrigger value="fornecedores" className="text-xs"><Truck className="w-3.5 h-3.5 mr-1" /> Cadastro global</TabsTrigger>
            <TabsTrigger value="pedido" className="text-xs"><ShoppingCart className="w-3.5 h-3.5 mr-1" /> Pedido</TabsTrigger>
            <TabsTrigger value="estoque" className="text-xs"><Warehouse className="w-3.5 h-3.5 mr-1" /> Estoque</TabsTrigger>
            <TabsTrigger value="historico" className="text-xs"><History className="w-3.5 h-3.5 mr-1" /> Histórico</TabsTrigger>
          </TabsList>

          <TabsContent value="comparativo" className="mt-3">
            <ComparisonsTab project={project} comparison={ctl.active} onApply={ctl.apply} onProjectChange={onProjectChange} hideSupplierManager />
          </TabsContent>
          <TabsContent value="insumos" className="mt-3">
            <MaterialsListTab project={project} comparison={ctl.active} onApply={ctl.apply} onProjectChange={onProjectChange} />
          </TabsContent>
          <TabsContent value="fornecedores" className="mt-3">
            <SuppliersTab project={project} onProjectChange={onProjectChange} />
          </TabsContent>
          <TabsContent value="pedido" className="mt-3">
            <PurchaseOrderTab project={project} comparison={ctl.active} />
          </TabsContent>
          <TabsContent value="estoque" className="mt-3">
            <StockTab project={project} onProjectChange={onProjectChange} />
          </TabsContent>
          <TabsContent value="historico" className="mt-3">
            <PriceHistoryTab project={project} />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
          Crie um grupo de compra para começar.
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
