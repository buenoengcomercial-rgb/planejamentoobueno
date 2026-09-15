import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { Project, WarehouseAuditActor } from '@/types/project';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LayoutDashboard, Boxes, ArrowLeftRight, ClipboardList, HardHat, ListChecks, Warehouse as WarehouseIcon, ReceiptText, ClipboardCheck } from 'lucide-react';
import { ensureWarehouse, panelSummary } from '@/lib/warehouse';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { scheduleIdlePreload } from '@/lib/idlePreload';
import './warehouse-visual.css';
import type { WarehouseCloudCommitResult, WarehouseCloudOperation } from '@/lib/warehouseCloudCommit';
import type { WarehouseScopedDomain } from '@/lib/warehouseScopedCommit';
import { toast } from 'sonner';
import {
  readWarehouseTab,
  warehouseTabStorageKey,
  type WarehouseTab,
} from '@/lib/projectDataScope';

const loadWarehousePanel = () => import('./WarehousePanel');
const loadWarehouseStockTab = () => import('./WarehouseStockTab');
const loadWarehouseMovementsTab = () => import('./WarehouseMovementsTab');
const loadWarehouseRequisitionsTab = () => import('./WarehouseRequisitionsTab');
const loadWarehouseEquipmentsTab = () => import('./WarehouseEquipmentsTab');
const loadWarehouseInventoryTab = () => import('./WarehouseInventoryTab');
const loadWarehouseFiscalNotesTab = () => import('./WarehouseFiscalNotesTab');
const loadWarehouseBudgetMaterialsTab = () => import('./WarehouseBudgetMaterialsTab');
const loadWarehouseWithdrawnMaterialsTab = () => import('./WarehouseWithdrawnMaterialsTab');

const WarehousePanel = lazyWithReload(loadWarehousePanel);
const WarehouseStockTab = lazyWithReload(loadWarehouseStockTab);
const WarehouseMovementsTab = lazyWithReload(loadWarehouseMovementsTab);
const WarehouseRequisitionsTab = lazyWithReload(loadWarehouseRequisitionsTab);
const WarehouseEquipmentsTab = lazyWithReload(loadWarehouseEquipmentsTab);
const WarehouseInventoryTab = lazyWithReload(loadWarehouseInventoryTab);
const WarehouseFiscalNotesTab = lazyWithReload(loadWarehouseFiscalNotesTab);
const WarehouseBudgetMaterialsTab = lazyWithReload(loadWarehouseBudgetMaterialsTab);
const WarehouseWithdrawnMaterialsTab = lazyWithReload(loadWarehouseWithdrawnMaterialsTab);
const AttachmentOptimizationPanel = lazyWithReload(() => import('./AttachmentOptimizationPanel'));
const GlobalStorageMaintenancePanel = lazyWithReload(() => import('./GlobalStorageMaintenancePanel'));

function WarehouseAreaFallback() {
  return <div className="flex min-h-32 items-center justify-center rounded-xl border bg-card p-6 text-sm font-medium text-muted-foreground" role="status" aria-live="polite">Carregando área do Almoxarifado...</div>;
}

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

const NEXT_WAREHOUSE_TAB_PRELOAD: Record<WarehouseTab, () => Promise<unknown>> = {
  painel: loadWarehouseRequisitionsTab,
  notas: loadWarehouseStockTab,
  requisicoes: loadWarehouseWithdrawnMaterialsTab,
  'materiais-retirados': loadWarehouseRequisitionsTab,
  'materiais-orcamento': loadWarehouseStockTab,
  estoque: loadWarehouseFiscalNotesTab,
  equipamentos: loadWarehouseInventoryTab,
  movimentos: loadWarehouseInventoryTab,
  inventario: loadWarehouseMovementsTab,
};

interface Props {
  project: Project;
  onProjectChange: (next: Project) => void;
  onCommitProject?: (next: Project) => Promise<void>;
  onCloudWarehouseOperationConfirmed?: (confirmation: WarehouseCloudCommitResult) => void | Promise<void>;
  onPrepareCloudWarehouseOperation?: () => void | Promise<void>;
  onCommitCloudWarehouseOperation?: (
    before: Project,
    after: Project,
    operation: WarehouseCloudOperation,
  ) => Promise<WarehouseCloudCommitResult>;
  onRunCriticalCloudWarehouseOperation?: <T>(operation: () => Promise<T>) => Promise<T>;
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
  activeTab?: WarehouseTab;
  onActiveTabChange?: (tab: WarehouseTab) => void;
  isTabDataReady?: boolean;
}

export default function Warehouse({ project, onProjectChange, onCommitProject, onCloudWarehouseOperationConfirmed, onPrepareCloudWarehouseOperation, onCommitCloudWarehouseOperation, onRunCriticalCloudWarehouseOperation, onCommitWarehouseScoped, onSaveStorageMaintenanceProject, storageMaintenanceOrganizationId, canManageFiscalNotes = true, canReviewFiscalCosts = true, canViewPanel = true, canApproveInventory = true, canArchiveWarehouseRecords = true, canEditPostedWarehouseRecords = false, canSupplementRequisitions = false, canDeleteWarehouseRecords = false, canManageEquipmentGroups = true, canOptimizeStorage = false, auditActor, activeTab, onActiveTabChange, isTabDataReady = true }: Props) {
  const [internalTab, setInternalTab] = useState<WarehouseTab>(() => readWarehouseTab(project.id, canViewPanel));
  const tab = activeTab ?? internalTab;
  const setTab = useCallback((next: WarehouseTab) => {
    setInternalTab(next);
    onActiveTabChange?.(next);
  }, [onActiveTabChange]);
  const ensured = useMemo(() => ensureWarehouse(project), [project]);
  useEffect(() => {
    if (ensured !== project) onProjectChange(ensured);
  }, [ensured, project, onProjectChange]);
  useEffect(() => {
    if (!canViewPanel && tab === 'painel') setTab('notas');
  }, [canViewPanel, setTab, tab]);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(warehouseTabStorageKey(project.id), tab);
    } catch {
      // A navegação continua funcional quando o armazenamento da sessão não está disponível.
    }
  }, [project.id, tab]);
  useEffect(() => scheduleIdlePreload(NEXT_WAREHOUSE_TAB_PRELOAD[tab]), [tab]);
  // O resumo exige várias coleções de todo o Almoxarifado. Fora do Painel,
  // não deixe esses indicadores bloquearem a subaba operacional escolhida.
  const summary = useMemo(() => tab === 'painel' ? panelSummary(ensured) : null, [ensured, tab]);
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
          {summary && (
            <span className="text-xs text-muted-foreground">
              Abaixo do mínimo: <strong className="text-destructive">{summary.underMinCount}</strong>
              <span className="mx-1.5">·</span>
              Termos abertos: <strong className="text-foreground">{summary.openCustodyCount}</strong>
            </span>
          )}
          {canOptimizeStorage && <Suspense fallback={null}><AttachmentOptimizationPanel project={ensured} onProjectChange={onProjectChange} onCommitProject={onCommitProject} /></Suspense>}
          {canOptimizeStorage && onSaveStorageMaintenanceProject && storageMaintenanceOrganizationId && <Suspense fallback={null}><GlobalStorageMaintenancePanel currentProject={ensured} onCurrentProjectChange={onProjectChange} saveProject={onSaveStorageMaintenanceProject} organizationId={storageMaintenanceOrganizationId} /></Suspense>}
        </div>
      </div>

      <Tabs value={tab} onValueChange={value => setTab(value as WarehouseTab)} className="w-full">
        <div className="lg:hidden">
          <label htmlFor="warehouse-mobile-tab" className="mb-1.5 block text-xs font-semibold text-muted-foreground">Área do almoxarifado</label>
          <select
            id="warehouse-mobile-tab"
            className="min-h-12 w-full rounded-lg border-2 border-primary/30 bg-card px-3 text-base font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={tab}
            onChange={event => setTab(event.target.value as WarehouseTab)}
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

        {isTabDataReady ? (
          <Suspense fallback={<WarehouseAreaFallback />}>
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
              <WarehouseRequisitionsTab project={ensured} onProjectChange={onProjectChange} onCloudOperationConfirmed={onCloudWarehouseOperationConfirmed} onPrepareCloudOperation={onPrepareCloudWarehouseOperation} onCommitCloudOperation={onCommitCloudWarehouseOperation} onRunCriticalCloudOperation={onRunCriticalCloudWarehouseOperation} onCommitWarehouseScoped={onCommitWarehouseScoped} auditActor={auditActor} canDelete={canDeleteWarehouseRecords} canEdit={canEditPostedWarehouseRecords} canSupplement={canSupplementRequisitions} />
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
          </Suspense>
        ) : (
          <WarehouseAreaFallback />
        )}
      </Tabs>
    </div>
  );
}
