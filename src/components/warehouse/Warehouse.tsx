import { useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LayoutDashboard, Boxes, ArrowLeftRight, ClipboardList, HardHat, ListChecks, FileBarChart, Warehouse as WarehouseIcon } from 'lucide-react';
import { ensureWarehouse, panelSummary } from '@/lib/warehouse';
import WarehousePanel from './WarehousePanel';
import WarehouseStockTab from './WarehouseStockTab';
import WarehouseMovementsTab from './WarehouseMovementsTab';
import WarehouseRequisitionsTab from './WarehouseRequisitionsTab';
import WarehouseEquipmentsTab from './WarehouseEquipmentsTab';
import WarehouseInventoryTab from './WarehouseInventoryTab';
import WarehouseReportsTab from './WarehouseReportsTab';

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
}

export default function Warehouse({ project, onProjectChange }: Props) {
  const [tab, setTab] = useState('painel');
  const ensured = useMemo(() => ensureWarehouse(project), [project]);
  // Garante migração na primeira renderização
  if (ensured !== project) {
    queueMicrotask(() => onProjectChange(ensured));
  }
  const summary = useMemo(() => panelSummary(ensured), [ensured]);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-3">
        <WarehouseIcon className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-bold">Estoque / Almoxarifado</h2>
        <span className="text-[11px] text-muted-foreground">
          Saldo total: <strong className="text-foreground">{summary.totalBalance.toLocaleString('pt-BR')}</strong>
          <span className="mx-1.5">·</span>
          A comprar: <strong className="text-warning">{summary.totalToPurchase.toLocaleString('pt-BR')}</strong>
          <span className="mx-1.5">·</span>
          Abaixo do mínimo: <strong className="text-destructive">{summary.underMinCount}</strong>
          <span className="mx-1.5">·</span>
          Termos abertos: <strong>{summary.openCustodyCount}</strong>
        </span>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="bg-muted h-9 flex-wrap">
          <TabsTrigger value="painel" className="text-xs"><LayoutDashboard className="w-3.5 h-3.5 mr-1" /> Painel</TabsTrigger>
          <TabsTrigger value="estoque" className="text-xs"><Boxes className="w-3.5 h-3.5 mr-1" /> Materiais</TabsTrigger>
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
    </div>
  );
}
