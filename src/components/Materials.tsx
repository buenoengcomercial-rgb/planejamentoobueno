import { useMemo, useState } from 'react';
import { Project } from '@/types/project';
import { useMaterialComparisons } from '@/hooks/useMaterialComparisons';
import * as MC from '@/lib/materialComparisons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, ListChecks, Boxes, Truck, History, ShoppingCart, Trash2, Lock, Link2 } from 'lucide-react';
import MaterialsListTab from './materials/MaterialsListTab';
import LinkedItemsTab from './materials/LinkedItemsTab';
import ComparisonsTab from './materials/ComparisonsTab';
import SuppliersTab from './materials/SuppliersTab';
import PriceHistoryTab from './materials/PriceHistoryTab';
import PurchaseOrderTab from './materials/PurchaseOrderTab';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
}

export default function Materials({ project, onProjectChange }: Props) {
  const ctl = useMaterialComparisons(project, onProjectChange);
  const [newName, setNewName] = useState('');
  const [tab, setTab] = useState('insumos');

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

  return (
    <div className="p-4 space-y-3">
      {/* Compact header */}
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
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Novo comparativo"
            className="h-8 w-56 text-xs"
            onKeyDown={e => {
              if (e.key === 'Enter' && newName.trim()) {
                ctl.createNew(newName.trim());
                setNewName('');
              }
            }}
          />
          <Button
            size="sm"
            className="h-8"
            onClick={() => {
              if (!newName.trim()) return;
              ctl.createNew(newName.trim());
              setNewName('');
            }}
          >
            <Plus className="w-3.5 h-3.5 mr-1" /> Novo
          </Button>
        </div>
      </div>

      {/* Comparison selector – compact */}
      <div className="flex flex-wrap items-center gap-1.5 bg-card border border-border rounded-lg px-2 py-1.5">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold mr-1">Ativo:</span>
        {ctl.comparisons.length === 0 && (
          <span className="text-[11px] text-muted-foreground italic">Nenhum comparativo. Crie acima.</span>
        )}
        {ctl.comparisons.map(c => (
          <button
            key={c.id}
            onClick={() => ctl.setActiveId(c.id)}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border transition-colors ${
              ctl.activeId === c.id
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-foreground border-border hover:bg-muted'
            }`}
          >
            <span className="truncate max-w-[160px]">{c.name}</span>
            <span className={`text-[9px] px-1 py-0.5 rounded ${ctl.activeId === c.id ? 'bg-primary-foreground/20' : 'bg-muted'}`}>
              {MC.STATUS_LABEL[c.status]}
            </span>
          </button>
        ))}
        {ctl.active && (
          <div className="ml-auto flex items-center gap-1">
            {ctl.active.status !== 'fechado' && ctl.active.status !== 'comprado' && (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => ctl.close(ctl.active!.id)}>
                <Lock className="w-3 h-3 mr-1" /> Fechar
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 text-[11px] text-destructive" onClick={() => {
              if (confirm(`Excluir o comparativo "${ctl.active!.name}"?`)) ctl.remove(ctl.active!.id);
            }}>
              <Trash2 className="w-3 h-3 mr-1" /> Excluir
            </Button>
          </div>
        )}
      </div>

      {/* Inner tabs */}
      {ctl.active ? (
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="bg-muted h-9">
            <TabsTrigger value="insumos" className="text-xs"><Boxes className="w-3.5 h-3.5 mr-1" /> Insumos do Projeto</TabsTrigger>
            <TabsTrigger value="vinculados" className="text-xs"><Link2 className="w-3.5 h-3.5 mr-1" /> Vinculados ({ctl.active.items.length})</TabsTrigger>
            <TabsTrigger value="comparativo" className="text-xs"><ListChecks className="w-3.5 h-3.5 mr-1" /> Comparativo</TabsTrigger>
            <TabsTrigger value="fornecedores" className="text-xs"><Truck className="w-3.5 h-3.5 mr-1" /> Fornecedores</TabsTrigger>
            <TabsTrigger value="historico" className="text-xs"><History className="w-3.5 h-3.5 mr-1" /> Histórico</TabsTrigger>
            <TabsTrigger value="pedido" className="text-xs"><ShoppingCart className="w-3.5 h-3.5 mr-1" /> Pedido</TabsTrigger>
          </TabsList>

          <TabsContent value="insumos" className="mt-3">
            <MaterialsListTab project={project} comparison={ctl.active} onApply={ctl.apply} onProjectChange={onProjectChange} />
          </TabsContent>
          <TabsContent value="vinculados" className="mt-3">
            <LinkedItemsTab project={project} comparison={ctl.active} onApply={ctl.apply} onProjectChange={onProjectChange} />
          </TabsContent>
          <TabsContent value="comparativo" className="mt-3">
            <ComparisonsTab comparison={ctl.active} onApply={ctl.apply} />
          </TabsContent>
          <TabsContent value="fornecedores" className="mt-3">
            <SuppliersTab comparison={ctl.active} onApply={ctl.apply} />
          </TabsContent>
          <TabsContent value="historico" className="mt-3">
            <PriceHistoryTab project={project} />
          </TabsContent>
          <TabsContent value="pedido" className="mt-3">
            <PurchaseOrderTab comparison={ctl.active} />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
          Crie um comparativo para começar.
        </div>
      )}
    </div>
  );
}
