import { useMemo, useState } from 'react';
import { Project } from '@/types/project';
import { useMaterialComparisons } from '@/hooks/useMaterialComparisons';
import * as MC from '@/lib/materialComparisons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, ListChecks, Boxes, Truck, History, ShoppingCart, Trash2, Lock } from 'lucide-react';
import MaterialsListTab from './materials/MaterialsListTab';
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
  const [tab, setTab] = useState('materiais');

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

  const diagnostics = useMemo(
    () => MC.suggestMaterialsWithDiagnostics(project).diagnostics,
    [project],
  );

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Lista de Material</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Comparativos de preços, fornecedores e plano otimizado de compra.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Nome do comparativo (ex.: Tubos e conexões)"
            className="w-72"
            onKeyDown={e => {
              if (e.key === 'Enter' && newName.trim()) {
                ctl.createNew(newName.trim());
                setNewName('');
              }
            }}
          />
          <Button
            size="sm"
            onClick={() => {
              if (!newName.trim()) return;
              ctl.createNew(newName.trim());
              setNewName('');
            }}
          >
            <Plus className="w-4 h-4 mr-1" /> Novo comparativo
          </Button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Card label="Comparativos" value={summary.count.toString()} />
        <Card label="Em aberto" value={summary.open.toString()} />
        <Card label="Fechados" value={summary.closed.toString()} />
        <Card label="Economia estimada" value={`R$ ${summary.totalEconomy.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`} accent="text-success" />
      </div>

      {/* Diagnostics */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground bg-muted/30 border border-border rounded-lg px-3 py-2">
        <span><strong className="text-foreground">{diagnostics.baseCompositionsWithAnalytic}</strong> composições base c/ analítico</span>
        <span><strong className="text-foreground">{diagnostics.baseAnalyticInputs}</strong> insumos base</span>
        <span><strong className="text-foreground">{diagnostics.contractedAdditivesRead}</strong> aditivos contratados lidos</span>
        <span><strong className="text-foreground">{diagnostics.taskMaterials}</strong> materiais de tarefa</span>
        <span><strong className="text-foreground">{diagnostics.syntheticCompositionsIgnored}</strong> composições sintéticas ignoradas</span>
        {diagnostics.baseCompositionsWithoutAnalytic > 0 && (
          <span className="text-warning"><strong>{diagnostics.baseCompositionsWithoutAnalytic}</strong> composições base sem analítico</span>
        )}
      </div>

      {/* Comparison selector */}
      <div className="flex flex-wrap items-center gap-2 bg-card border border-border rounded-xl p-3">
        <span className="text-xs text-muted-foreground uppercase tracking-wide">Comparativo ativo:</span>
        {ctl.comparisons.length === 0 && (
          <span className="text-xs text-muted-foreground italic">Nenhum comparativo. Crie o primeiro acima.</span>
        )}
        {ctl.comparisons.map(c => (
          <button
            key={c.id}
            onClick={() => ctl.setActiveId(c.id)}
            className={`group inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              ctl.activeId === c.id
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-foreground border-border hover:bg-muted'
            }`}
          >
            <span className="truncate max-w-[180px]">{c.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              ctl.activeId === c.id ? 'bg-primary-foreground/20' : 'bg-muted'
            }`}>
              {MC.STATUS_LABEL[c.status]}
            </span>
          </button>
        ))}
        {ctl.active && (
          <div className="ml-auto flex items-center gap-2">
            {ctl.active.status !== 'fechado' && ctl.active.status !== 'comprado' && (
              <Button size="sm" variant="outline" onClick={() => ctl.close(ctl.active!.id)}>
                <Lock className="w-3.5 h-3.5 mr-1" /> Fechar cotação
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => {
              if (confirm(`Excluir o comparativo "${ctl.active!.name}"?`)) ctl.remove(ctl.active!.id);
            }}>
              <Trash2 className="w-3.5 h-3.5 mr-1" /> Excluir
            </Button>
          </div>
        )}
      </div>

      {/* Inner tabs */}
      {ctl.active ? (
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="bg-muted">
            <TabsTrigger value="materiais"><Boxes className="w-3.5 h-3.5 mr-1" /> Materiais</TabsTrigger>
            <TabsTrigger value="comparativo"><ListChecks className="w-3.5 h-3.5 mr-1" /> Comparativo</TabsTrigger>
            <TabsTrigger value="fornecedores"><Truck className="w-3.5 h-3.5 mr-1" /> Fornecedores</TabsTrigger>
            <TabsTrigger value="historico"><History className="w-3.5 h-3.5 mr-1" /> Histórico</TabsTrigger>
            <TabsTrigger value="pedido"><ShoppingCart className="w-3.5 h-3.5 mr-1" /> Pedido de compra</TabsTrigger>
          </TabsList>

          <TabsContent value="materiais" className="mt-4">
            <MaterialsListTab project={project} comparison={ctl.active} onApply={ctl.apply} />
          </TabsContent>
          <TabsContent value="comparativo" className="mt-4">
            <ComparisonsTab comparison={ctl.active} onApply={ctl.apply} />
          </TabsContent>
          <TabsContent value="fornecedores" className="mt-4">
            <SuppliersTab comparison={ctl.active} onApply={ctl.apply} />
          </TabsContent>
          <TabsContent value="historico" className="mt-4">
            <PriceHistoryTab project={project} />
          </TabsContent>
          <TabsContent value="pedido" className="mt-4">
            <PurchaseOrderTab comparison={ctl.active} />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
          Crie um comparativo para começar a lançar fornecedores, itens e preços.
        </div>
      )}
    </div>
  );
}

function Card({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className={`text-xl font-bold mt-1 ${accent ?? 'text-foreground'}`}>{value}</div>
    </div>
  );
}
