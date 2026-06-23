import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LayoutDashboard, Boxes, ArrowLeftRight, ClipboardList, HardHat, ListChecks, FileBarChart, Warehouse as WarehouseIcon, RotateCcw, ReceiptText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { clearWarehouse, ensureWarehouse, panelSummary } from '@/lib/warehouse';
import { cn } from '@/lib/utils';
import WarehousePanel from './WarehousePanel';
import WarehouseStockTab from './WarehouseStockTab';
import WarehouseMovementsTab from './WarehouseMovementsTab';
import WarehouseRequisitionsTab from './WarehouseRequisitionsTab';
import WarehouseEquipmentsTab from './WarehouseEquipmentsTab';
import WarehouseInventoryTab from './WarehouseInventoryTab';
import WarehouseReportsTab from './WarehouseReportsTab';
import WarehouseFiscalNotesTab from './WarehouseFiscalNotesTab';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
}

export default function Warehouse({ project, onProjectChange }: Props) {
  const [tab, setTab] = useState('painel');
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const ensured = useMemo(() => ensureWarehouse(project), [project]);
  useEffect(() => {
    if (ensured !== project) onProjectChange(ensured);
  }, [ensured, project, onProjectChange]);
  const summary = useMemo(() => panelSummary(ensured), [ensured]);

  const kpis = [
    { label: 'Planejado', value: summary.totalPlanned },
    { label: 'Comprado', value: summary.totalPurchased, tone: 'primary' as const },
    { label: 'Recebido', value: summary.totalReceived, tone: 'ok' as const },
    { label: 'Retirado', value: summary.totalWithdrawn },
    { label: 'Saldo físico', value: summary.totalBalance, tone: 'primary' as const, strong: true },
    { label: 'A comprar', value: summary.totalToPurchase, tone: 'warn' as const },
  ];
  const toneCls = (t?: 'primary' | 'ok' | 'warn') =>
    t === 'primary' ? 'text-primary' : t === 'ok' ? 'text-success' : t === 'warn' ? 'text-warning' : 'text-foreground';

  const handleClearWarehouse = () => {
    confirm(
      {
        title: 'Limpar almoxarifado?',
        description: (
          <div className="space-y-2">
            <p>
              Esta ação remove entradas, retiradas, devoluções, itens avulsos, notas fiscais, requisições,
              termos de cautela, locais e configurações do almoxarifado.
            </p>
            <p className="font-medium">
              Não remove equipamentos cadastrados, Lista de Material, pedidos confirmados, Medição, Aditivo ou Custo Real.
            </p>
          </div>
        ),
        confirmLabel: 'Limpar almoxarifado',
      },
      () => onProjectChange(clearWarehouse(ensured)),
    );
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3">
        <WarehouseIcon className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-bold">Estoque / Almoxarifado</h2>
        <span className="ml-auto text-[11px] text-muted-foreground">
          Abaixo do mínimo: <strong className="text-destructive">{summary.underMinCount}</strong>
          <span className="mx-1.5">·</span>
          Termos abertos: <strong className="text-foreground">{summary.openCustodyCount}</strong>
        </span>
        <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={handleClearWarehouse}>
          <RotateCcw className="w-3.5 h-3.5 mr-1" />
          Limpar almoxarifado
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {kpis.map(k => (
          <div key={k.label} className="bg-card border border-border rounded-md px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{k.label}</div>
            <div className={cn('font-bold tabular-nums', k.strong ? 'text-xl' : 'text-base', toneCls(k.tone))}>
              {k.value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}
            </div>
          </div>
        ))}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="bg-muted h-9 flex-wrap">
          <TabsTrigger value="painel" className="text-xs"><LayoutDashboard className="w-3.5 h-3.5 mr-1" /> Painel</TabsTrigger>
          <TabsTrigger value="estoque" className="text-xs"><Boxes className="w-3.5 h-3.5 mr-1" /> Materiais</TabsTrigger>
          <TabsTrigger value="notas" className="text-xs"><ReceiptText className="w-3.5 h-3.5 mr-1" /> Notas fiscais</TabsTrigger>
          <TabsTrigger value="movimentos" className="text-xs"><ArrowLeftRight className="w-3.5 h-3.5 mr-1" /> Movimentações</TabsTrigger>
          <TabsTrigger value="requisicoes" className="text-xs"><ClipboardList className="w-3.5 h-3.5 mr-1" /> Requisições</TabsTrigger>
          <TabsTrigger value="equipamentos" className="text-xs"><HardHat className="w-3.5 h-3.5 mr-1" /> Equipamentos</TabsTrigger>
          <TabsTrigger value="inventario" className="text-xs"><ListChecks className="w-3.5 h-3.5 mr-1" /> Inventário</TabsTrigger>
          <TabsTrigger value="relatorios" className="text-xs"><FileBarChart className="w-3.5 h-3.5 mr-1" /> Relatórios</TabsTrigger>
        </TabsList>

        <TabsContent value="painel" className="mt-3">
          <WarehousePanel project={ensured} />
        </TabsContent>
        <TabsContent value="estoque" className="mt-3">
          <WarehouseStockTab project={ensured} onProjectChange={onProjectChange} />
        </TabsContent>
        <TabsContent value="notas" className="mt-3">
          <WarehouseFiscalNotesTab project={ensured} onProjectChange={onProjectChange} />
        </TabsContent>
        <TabsContent value="movimentos" className="mt-3">
          <WarehouseMovementsTab project={ensured} onProjectChange={onProjectChange} />
        </TabsContent>
        <TabsContent value="requisicoes" className="mt-3">
          <WarehouseRequisitionsTab project={ensured} onProjectChange={onProjectChange} />
        </TabsContent>
        <TabsContent value="equipamentos" className="mt-3">
          <WarehouseEquipmentsTab project={ensured} onProjectChange={onProjectChange} />
        </TabsContent>
        <TabsContent value="inventario" className="mt-3">
          <WarehouseInventoryTab project={ensured} onProjectChange={onProjectChange} />
        </TabsContent>
        <TabsContent value="relatorios" className="mt-3">
          <WarehouseReportsTab project={ensured} />
        </TabsContent>
      </Tabs>
      {confirmDialog}
    </div>
  );
}
