import { useEffect, useMemo, useState } from 'react';
import type { Project, WarehouseAuditActor } from '@/types/project';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LayoutDashboard, Boxes, ArrowLeftRight, ClipboardList, HardHat, ListChecks, FileBarChart, Warehouse as WarehouseIcon, RotateCcw, ReceiptText, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { clearWarehouse, ensureWarehouse, panelSummary } from '@/lib/warehouse';
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
  canManageFiscalNotes?: boolean;
  auditActor?: WarehouseAuditActor;
}

export default function Warehouse({ project, onProjectChange, canManageFiscalNotes = true, auditActor }: Props) {
  const [tab, setTab] = useState('painel');
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const ensured = useMemo(() => ensureWarehouse(project), [project]);
  useEffect(() => {
    if (ensured !== project) onProjectChange(ensured);
  }, [ensured, project, onProjectChange]);
  const summary = useMemo(() => panelSummary(ensured), [ensured]);

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
      <div className="flex flex-wrap items-start gap-3">
        <WarehouseIcon className="w-5 h-5 text-primary" />
        <div>
          <h2 className="text-xl font-bold">Estoque e Almoxarifado</h2>
          <p className="mt-1 text-sm text-muted-foreground">Recebimentos, retiradas, requisições e controle físico dos materiais.</p>
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          Abaixo do mínimo: <strong className="text-destructive">{summary.underMinCount}</strong>
          <span className="mx-1.5">·</span>
          Termos abertos: <strong className="text-foreground">{summary.openCustodyCount}</strong>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="min-h-10"><Settings2 className="mr-1.5 h-4 w-4" /> Administração</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={handleClearWarehouse}>
              <RotateCcw className="mr-2 h-4 w-4" /> Limpar almoxarifado
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="h-11 w-full justify-start overflow-x-auto bg-muted">
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
          <WarehousePanel project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="estoque" className="mt-3">
          <WarehouseStockTab project={ensured} onProjectChange={onProjectChange} />
        </TabsContent>
        <TabsContent value="notas" className="mt-3">
          <WarehouseFiscalNotesTab
            project={ensured}
            onProjectChange={onProjectChange}
            canManage={canManageFiscalNotes}
            auditActor={auditActor}
          />
        </TabsContent>
        <TabsContent value="movimentos" className="mt-3">
          <WarehouseMovementsTab project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="requisicoes" className="mt-3">
          <WarehouseRequisitionsTab project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="equipamentos" className="mt-3">
          <WarehouseEquipmentsTab project={ensured} onProjectChange={onProjectChange} />
        </TabsContent>
        <TabsContent value="inventario" className="mt-3">
          <WarehouseInventoryTab project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="relatorios" className="mt-3">
          <WarehouseReportsTab project={ensured} />
        </TabsContent>
      </Tabs>
      {confirmDialog}
    </div>
  );
}
