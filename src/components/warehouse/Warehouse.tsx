import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project, WarehouseAuditActor } from '@/types/project';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LayoutDashboard, Boxes, ArrowLeftRight, ClipboardList, HardHat, ListChecks, Warehouse as WarehouseIcon, ReceiptText, ClipboardCheck } from 'lucide-react';
import { ensureWarehouse, panelSummary } from '@/lib/warehouse';
import WarehousePanel from './WarehousePanel';
import WarehouseStockTab from './WarehouseStockTab';
import WarehouseMovementsTab from './WarehouseMovementsTab';
import WarehouseRequisitionsTab from './WarehouseRequisitionsTab';
import WarehouseEquipmentsTab from './WarehouseEquipmentsTab';
import WarehouseInventoryTab from './WarehouseInventoryTab';
import WarehouseFiscalNotesTab from './WarehouseFiscalNotesTab';
import WarehouseBudgetMaterialsTab from './WarehouseBudgetMaterialsTab';
import WarehouseWithdrawnMaterialsTab from './WarehouseWithdrawnMaterialsTab';
import AttachmentOptimizationPanel from './AttachmentOptimizationPanel';
import GlobalStorageMaintenancePanel from './GlobalStorageMaintenancePanel';
import './warehouse-visual.css';
import type { WarehouseCloudCommitResult } from '@/lib/warehouseCloudCommit';
import type { WarehouseScopedDomain } from '@/lib/warehouseScopedCommit';
import { toast } from 'sonner';

const WAREHOUSE_TABS = [
  { value: 'painel', label: 'Painel', icon: LayoutDashboard },
  { value: 'notas', label: 'Entrada', icon: ReceiptText },
  { value: 'requisicoes', label: 'Retiradas e devoluções', icon: ClipboardList },
  { value: 'materiais-retirados', label: 'Materiais retirados', icon: ClipboardList },
  { value: 'materiais-orcamento', label: 'Materiais do orçamento', icon: ClipboardCheck },
  { value: 'estoque', label: 'Materiais', icon: Boxes },
  { value: 'equipamentos', label: 'Equipamentos', icon: HardHat },
  { value: 'movimentos', label: 'Movimentações', icon: ArrowLeftRight },
  { value: 'inventario', label: 'Inventário', icon: ListChecks },
] as const;

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
  onCommitProject?: (next: Project) => Promise<void>;
  onCloudWarehouseOperationConfirmed?: (confirmation: WarehouseCloudCommitResult) => void | Promise<void>;
  onPrepareCloudWarehouseOperation?: () => void | Promise<void>;
  onCommitWarehouseScoped?: (next: Project, domain: WarehouseScopedDomain) => Promise<Project>;
  canManageFiscalNotes?: boolean;
  canReviewFiscalCosts?: boolean;
  canViewPanel?: boolean;
  canApproveInventory?: boolean;
  canArchiveWarehouseRecords?: boolean;
  canEditPostedWarehouseRecords?: boolean;
  canSupplementRequisitions?: boolean;
  canDeleteWarehouseRecords?: boolean;
  canManageEquipmentGroups?: boolean;
  canOptimizeStorage?: boolean;
  onSaveStorageMaintenanceProject?: (project: Project, expectedUpdatedAt: string) => Promise<string>;
  storageMaintenanceOrganizationId?: string;
  auditActor?: WarehouseAuditActor;
}

export default function Warehouse({ project, onProjectChange, onCommitProject, onCloudWarehouseOperationConfirmed, onPrepareCloudWarehouseOperation, onCommitWarehouseScoped, onSaveStorageMaintenanceProject, storageMaintenanceOrganizationId, canManageFiscalNotes = true, canReviewFiscalCosts = true, canViewPanel = true, canApproveInventory = true, canArchiveWarehouseRecords = true, canEditPostedWarehouseRecords = false, canSupplementRequisitions = false, canDeleteWarehouseRecords = false, canManageEquipmentGroups = true, canOptimizeStorage = false, auditActor }: Props) {
  const [tab, setTab] = useState(() => canViewPanel ? 'painel' : 'notas');
  const ensured = useMemo(() => ensureWarehouse(project), [project]);
  useEffect(() => {
    if (ensured !== project) onProjectChange(ensured);
  }, [ensured, project, onProjectChange]);
  useEffect(() => {
    if (!canViewPanel && tab === 'painel') setTab('notas');
  }, [canViewPanel, tab]);
  const summary = useMemo(() => panelSummary(ensured), [ensured]);
  const visibleTabs = canViewPanel
    ? WAREHOUSE_TABS
    : WAREHOUSE_TABS.filter(item => item.value !== 'painel');
  const commitChildChange = useCallback((next: Project, domain: WarehouseScopedDomain) => {
    if (!onCommitWarehouseScoped) {
      toast.error('A transação segura do Almoxarifado ainda não está disponível. Nada foi gravado.');
      return;
    }
    void onCommitWarehouseScoped(next, domain).catch(error => toast.error((error as Error).message));
  }, [onCommitWarehouseScoped]);
  const commitReceiptChildChange = useCallback(
    (next: Project) => commitChildChange(next, 'receipt'),
    [commitChildChange],
  );
  const commitEquipmentChildChange = useCallback(
    (next: Project) => commitChildChange(next, 'catalog'),
    [commitChildChange],
  );

  return (
    <div className="warehouse-ui space-y-4 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-4">
      <div className="flex flex-wrap items-start gap-3 rounded-xl border border-primary/15 bg-gradient-to-r from-primary/10 via-card to-card p-4 shadow-sm">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <WarehouseIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0">
          <h2 className="text-xl font-extrabold sm:text-2xl">Estoque e Almoxarifado</h2>
          <p className="mt-1 text-sm font-medium text-muted-foreground">Escolha uma área para consultar ou registrar uma operação.</p>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
        <span className="text-xs text-muted-foreground">
          Abaixo do mínimo: <strong className="text-destructive">{summary.underMinCount}</strong>
          <span className="mx-1.5">·</span>
          Termos abertos: <strong className="text-foreground">{summary.openCustodyCount}</strong>
        </span>
        {canOptimizeStorage && <AttachmentOptimizationPanel project={ensured} onProjectChange={onProjectChange} onCommitProject={onCommitProject} />}
        {canOptimizeStorage && onSaveStorageMaintenanceProject && storageMaintenanceOrganizationId && <GlobalStorageMaintenancePanel currentProject={ensured} onCurrentProjectChange={onProjectChange} saveProject={onSaveStorageMaintenanceProject} organizationId={storageMaintenanceOrganizationId} />}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <div className="lg:hidden">
          <label htmlFor="warehouse-mobile-tab" className="mb-1.5 block text-xs font-semibold text-muted-foreground">Área do almoxarifado</label>
          <select
            id="warehouse-mobile-tab"
            className="min-h-12 w-full rounded-lg border-2 border-primary/30 bg-card px-3 text-base font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={tab}
            onChange={event => setTab(event.target.value)}
          >
            {visibleTabs.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
        <TabsList className="hidden h-auto min-h-12 w-full justify-start overflow-x-auto rounded-xl border bg-muted/70 p-1.5 shadow-sm lg:flex">
          {visibleTabs.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="min-h-11 rounded-lg px-3 text-xs font-bold data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Icon className="mr-1 h-3.5 w-3.5" /> {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {canViewPanel && (
          <TabsContent value="painel" className="mt-3">
            <WarehousePanel project={ensured} onProjectChange={onProjectChange} onCommitWarehouseScoped={onCommitWarehouseScoped} auditActor={auditActor} />
          </TabsContent>
        )}
        <TabsContent value="notas" className="mt-3">
          <WarehouseFiscalNotesTab
            project={ensured}
            onProjectChange={commitReceiptChildChange}
            onCommitProject={onCommitProject}
            onCommitWarehouseScoped={onCommitWarehouseScoped}
            canManage={canManageFiscalNotes}
            canReviewCosts={canReviewFiscalCosts}
            canEditPosted={canEditPostedWarehouseRecords}
            canDelete={canDeleteWarehouseRecords}
            canReviewPackagingConversions={canEditPostedWarehouseRecords}
            auditActor={auditActor}
          />
        </TabsContent>
        <TabsContent value="requisicoes" className="mt-3">
          <WarehouseRequisitionsTab project={ensured} onProjectChange={onProjectChange} onCloudOperationConfirmed={onCloudWarehouseOperationConfirmed} onPrepareCloudOperation={onPrepareCloudWarehouseOperation} onCommitWarehouseScoped={onCommitWarehouseScoped} auditActor={auditActor} canDelete={canDeleteWarehouseRecords} canEdit={canEditPostedWarehouseRecords} canSupplement={canSupplementRequisitions} />
        </TabsContent>
        <TabsContent value="materiais-retirados" className="mt-3">
          <WarehouseWithdrawnMaterialsTab project={ensured} />
        </TabsContent>
        <TabsContent value="equipamentos" className="mt-3">
          <WarehouseEquipmentsTab project={ensured} onProjectChange={commitEquipmentChildChange} onCommitWarehouseScoped={onCommitWarehouseScoped} auditActor={auditActor} canArchive={canArchiveWarehouseRecords} canDelete={canDeleteWarehouseRecords} canManageGroups={canManageEquipmentGroups} canEdit={canArchiveWarehouseRecords} />
        </TabsContent>
        <TabsContent value="estoque" className="mt-3">
          <WarehouseStockTab onNewEntry={() => setTab('notas')} project={ensured} onProjectChange={onProjectChange} onCommitWarehouseScoped={onCommitWarehouseScoped} auditActor={auditActor} canArchive={canArchiveWarehouseRecords} canDelete={canDeleteWarehouseRecords} />
        </TabsContent>
        <TabsContent value="materiais-orcamento" className="mt-3">
          <WarehouseBudgetMaterialsTab project={ensured} />
        </TabsContent>
        <TabsContent value="movimentos" className="mt-3">
          <WarehouseMovementsTab project={ensured} onProjectChange={onProjectChange} auditActor={auditActor} />
        </TabsContent>
        <TabsContent value="inventario" className="mt-3">
          <WarehouseInventoryTab project={ensured} onProjectChange={onProjectChange} onCommitWarehouseScoped={onCommitWarehouseScoped} auditActor={auditActor} canApprove={canApproveInventory} canDelete={canDeleteWarehouseRecords} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
