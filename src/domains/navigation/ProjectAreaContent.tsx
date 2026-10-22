import { type ComponentProps } from 'react';
import { type NavigateFunction } from 'react-router-dom';
import type { AppView, Project } from '@/types/project';
import type { OrgRole } from '@/lib/organizations';
import type { AuditUserInfo } from '@/lib/audit';
import type { WarehouseTab } from '@/lib/projectDataScope';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { scopeKey } from '@/lib/planTakeoff';
import { resolveObraConfig } from '@/lib/obraConfig';
import { logToProject } from '@/lib/audit';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import UndoButton from '@/components/UndoButton';

const Dashboard = lazyWithReload(() => import('@/components/Dashboard'));
const ManagementRoutine = lazyWithReload(() => import('@/components/OperationalManagementRoutine'));
const GanttChart = lazyWithReload(() => import('@/components/OperationalGanttChart'));
const DailyProductionWorkspace = lazyWithReload(() => import('@/components/DailyProductionWorkspace'));
const Measurement = lazyWithReload(() => import('@/components/Measurement'));
const Additive = lazyWithReload(() => import('@/components/Additive'));
const AdditiveSchedule = lazyWithReload(() => import('@/components/AdditiveSchedule'));
const RealCost = lazyWithReload(() => import('@/components/RealCost'));
const Materials = lazyWithReload(() => import('@/components/Materials'));
const WarehouseView = lazyWithReload(() => import('@/components/warehouse/Warehouse'));

type ProjectSetter = (next: Project | ((previous: Project) => Project)) => void;

export interface ProjectAreaContentProps {
  project: Project;
  safeCurrentView: AppView;
  currentViewDataReady: boolean;
  dataLoadError: string | null;
  onRetryDataLoad: () => void;
  role: OrgRole | undefined;
  editor: boolean;
  dailyReportEditor: boolean;
  warehouseEditor: boolean;
  auditActor: AuditUserInfo;
  orgId: string | undefined;
  userId: string | undefined;
  locationSearch: string;
  navigate: NavigateFunction;
  onProductionNavigation: () => void;
  onRoutineNavigation: () => void;
  productionWorkspaceInitialTab: 'production' | 'dailyReport';
  dailyReportInitialDate: string | undefined;
  dailyReportInitialFilter: string | undefined;
  dailyReportNavKey: number;
  independentMeasurementConfirmed: boolean;
  onIndependentReady: (projectId: string | null) => void;
  onOpenDailyReport: (dateISO: string, measurementFilter?: string) => void;
  onOpenProductionActivity: (taskId: string, dateISO: string) => void;
  canUndo: (view: AppView) => boolean;
  handleUndo: (view: AppView) => void;
  managementSetter: ProjectSetter;
  ganttSetter: ProjectSetter;
  tasksSetter: ProjectSetter;
  measurementSetter: ProjectSetter;
  dailyReportSetter: ProjectSetter;
  additiveSetter: ProjectSetter;
  additiveScheduleSetter: ProjectSetter;
  realCostSetter: ProjectSetter;
  materialsSetter: ProjectSetter;
  warehouseSetter: ProjectSetter;
  commitProductionCapture: ComponentProps<typeof DailyProductionWorkspace>['onCommitProductionCapture'];
  commitProjectNow: ComponentProps<typeof WarehouseView>['onCommitProject'];
  applyWarehouseCloudConfirmation: ComponentProps<typeof WarehouseView>['onCloudWarehouseOperationConfirmed'];
  prepareWarehouseRequisitionOperation: ComponentProps<typeof WarehouseView>['onPrepareCloudWarehouseOperation'];
  commitWarehouseRequisitionNow: ComponentProps<typeof WarehouseView>['onCommitCloudWarehouseOperation'];
  runCriticalWarehouseClientOperation: ComponentProps<typeof WarehouseView>['onRunCriticalCloudWarehouseOperation'];
  commitWarehouseScopedNow: ComponentProps<typeof WarehouseView>['onCommitWarehouseScoped'];
  commitAttachmentMigrationNow: ComponentProps<typeof WarehouseView>['onCommitAttachmentMigration'];
  warehouseTab: WarehouseTab;
  onWarehouseTabChange: (tab: WarehouseTab) => void;
}

export default function ProjectAreaContent({
  project, safeCurrentView, currentViewDataReady, dataLoadError, onRetryDataLoad,
  role, editor, dailyReportEditor, warehouseEditor, auditActor, orgId, userId,
  locationSearch, navigate, onProductionNavigation, onRoutineNavigation,
  productionWorkspaceInitialTab, dailyReportInitialDate, dailyReportInitialFilter,
  dailyReportNavKey, independentMeasurementConfirmed, onIndependentReady,
  onOpenDailyReport: handleOpenDailyReport,
  onOpenProductionActivity: handleOpenProductionActivity, canUndo, handleUndo,
  managementSetter, ganttSetter, tasksSetter, measurementSetter, dailyReportSetter,
  additiveSetter, additiveScheduleSetter, realCostSetter, materialsSetter,
  warehouseSetter, commitProductionCapture, commitProjectNow,
  applyWarehouseCloudConfirmation, prepareWarehouseRequisitionOperation,
  commitWarehouseRequisitionNow, runCriticalWarehouseClientOperation,
  commitWarehouseScopedNow, commitAttachmentMigrationNow, warehouseTab,
  onWarehouseTabChange,
}: ProjectAreaContentProps) {
  const productionRoutineNavigation = (active: 'production' | 'routine') => (
    <div className="border-b border-border bg-card px-3 pt-3 sm:px-4 lg:px-5">
      <div className="mx-auto flex max-w-[1800px] gap-1 rounded-lg bg-muted/50 p-1 sm:w-fit sm:mx-0">
        <Button
          type="button"
          variant={active === 'production' ? 'default' : 'ghost'}
          className="min-h-10 flex-1 sm:flex-none"
          onClick={onProductionNavigation}
        >
          Produção
        </Button>
        <Button
          type="button"
          variant={active === 'routine' ? 'default' : 'ghost'}
          className="min-h-10 flex-1 sm:flex-none"
          onClick={onRoutineNavigation}
        >
          Rotina semanal
        </Button>
      </div>
    </div>
  );


  if (!currentViewDataReady && dataLoadError) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
        <p className="font-semibold">Não foi possível carregar esta área.</p>
        <p className="text-sm text-muted-foreground">{dataLoadError}</p>
        <Button type="button" variant="outline" onClick={() => onRetryDataLoad()}>
          Tentar novamente
        </Button>
      </div>
    );
  }
  if (!currentViewDataReady && safeCurrentView !== 'warehouse') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 p-6 text-sm font-medium text-muted-foreground" role="status" aria-live="polite">
        <Loader2 className="h-5 w-5 animate-spin" />
        Carregando somente os dados desta área…
      </div>
    );
  }
  switch (safeCurrentView) {
    case 'dashboard':
      return <Dashboard project={project} undoButton={<UndoButton canUndo={canUndo('dashboard')} onUndo={() => handleUndo('dashboard')} />} />;
    case 'management':
      return (
        <>
          {productionRoutineNavigation('routine')}
          <ManagementRoutine
            project={project}
            onProjectChange={managementSetter}
            onOpenDailyReport={handleOpenDailyReport}
            onOpenProduction={handleOpenProductionActivity}
            readOnly={!editor}
            canRequestReschedule={role === 'owner' || role === 'admin' || role === 'engineer'}
            canApproveReschedule={role === 'owner' || role === 'admin'}
            auditActor={auditActor}
            initialWeek={new URLSearchParams(locationSearch).get('semana') || undefined}
            onWeekChange={date => navigate(`/obras/${project.id}/rotina?semana=${date}`, { replace: true })}
            undoButton={<UndoButton canUndo={canUndo('management')} onUndo={() => handleUndo('management')} />}
          />
        </>
      );
    case 'gantt':
      return <GanttChart
        project={project}
        onProjectChange={ganttSetter}
        readOnly={!editor}
        canRequestReschedule={role === 'owner' || role === 'admin' || role === 'engineer'}
        canApproveReschedule={role === 'owner' || role === 'admin'}
        auditActor={auditActor}
        calendarConfig={resolveObraConfig(project)}
        canManageCalendar={role === 'owner' || role === 'admin'}
        onCalendarConfigChange={config => ganttSetter(previous => logToProject({ ...previous, scheduleCalendar: config }, {
          ...auditActor, entityType: 'project', entityId: previous.id, action: 'updated',
          title: 'Calendário da obra atualizado',
          description: `Calendário operacional atualizado; ${config.exceptions?.length ?? 0} exceção(ões) de expediente ativa(s).`,
          before: previous.scheduleCalendar, after: config,
        }))}
        undoButton={<UndoButton canUndo={canUndo('gantt')} onUndo={() => handleUndo('gantt')} size="xs" />}
      />;
    case 'tasks':
      return (
        <>
          {productionRoutineNavigation('production')}
          <DailyProductionWorkspace
            auditActor={auditActor}
            takeoffStorageKey={userId && orgId ? scopeKey(orgId, userId, project.id) : undefined}
            project={project}
            initialTab={productionWorkspaceInitialTab}
            onProductionChange={tasksSetter}
            onCommitProductionCapture={commitProductionCapture}
            onDailyReportChange={dailyReportSetter}
            productionReadOnly={!editor}
            dailyReportReadOnly={!dailyReportEditor}
            dailyReportCanConclude={role === 'owner' || role === 'engineer'}
            dailyReportCanReopen={role === 'owner'}
            dailyReportCanClearDay={editor}
            dailyReportPhotoUploaderName={auditActor.userName}
            productionUndoButton={<UndoButton canUndo={canUndo('tasks')} onUndo={() => handleUndo('tasks')} />}
            dailyReportUndoButton={<UndoButton canUndo={canUndo('dailyReport')} onUndo={() => handleUndo('dailyReport')} />}
            dailyReportInitialDate={dailyReportInitialDate}
            dailyReportInitialFilter={dailyReportInitialFilter}
            dailyReportNavKey={dailyReportNavKey}
            productionFocusTaskId={new URLSearchParams(locationSearch).get('atividade') || undefined}
            productionFocusDate={new URLSearchParams(locationSearch).get('data') || undefined}
          />
        </>
      );
    case 'measurement':
      return <Measurement independentConfirmed={independentMeasurementConfirmed} onIndependentReady={onIndependentReady} project={project} onProjectChange={measurementSetter} undoButton={<UndoButton canUndo={canUndo('measurement')} onUndo={() => handleUndo('measurement')} />} onOpenDailyReport={handleOpenDailyReport} />;
    case 'dailyReport':
      return (
        <DailyProductionWorkspace
          auditActor={auditActor}
          project={project}
          initialTab="dailyReport"
          onProductionChange={tasksSetter}
          onDailyReportChange={dailyReportSetter}
          productionReadOnly={!editor}
          dailyReportReadOnly={!dailyReportEditor}
          dailyReportCanConclude={role === 'owner' || role === 'engineer'}
          dailyReportCanReopen={role === 'owner'}
          dailyReportCanClearDay={editor}
          dailyReportPhotoUploaderName={auditActor.userName}
          productionUndoButton={<UndoButton canUndo={canUndo('tasks')} onUndo={() => handleUndo('tasks')} />}
          dailyReportUndoButton={<UndoButton canUndo={canUndo('dailyReport')} onUndo={() => handleUndo('dailyReport')} />}
          dailyReportInitialDate={dailyReportInitialDate}
          dailyReportInitialFilter={dailyReportInitialFilter}
          dailyReportNavKey={dailyReportNavKey}
        />
      );
    case 'additive':
      return <Additive project={project} onProjectChange={additiveSetter} canFormalize={role === 'owner' || role === 'admin'} undoButton={<UndoButton canUndo={canUndo('additive')} onUndo={() => handleUndo('additive')} />} />;
    case 'additiveSchedule':
      return <AdditiveSchedule project={project} onProjectChange={additiveScheduleSetter} canManageCalendar={role === 'owner' || role === 'admin'} auditActor={auditActor} undoButton={<UndoButton canUndo={canUndo('additiveSchedule')} onUndo={() => handleUndo('additiveSchedule')} />} />;
    case 'realCost':
      return <RealCost project={project} onProjectChange={realCostSetter} canManageSubcontracts={role === 'owner' || role === 'admin'} canDeleteSubcontractHistory={role === 'owner'} auditActor={auditActor} />;
    case 'materials':
      return <Materials project={project} onProjectChange={materialsSetter} onCommitWarehouseScoped={commitWarehouseScopedNow} auditActor={auditActor} />;
    case 'warehouse':
      return (
        <WarehouseView
          project={project}
          onProjectChange={warehouseSetter}
          onCommitProject={commitProjectNow}
          onCloudWarehouseOperationConfirmed={applyWarehouseCloudConfirmation}
          onPrepareCloudWarehouseOperation={prepareWarehouseRequisitionOperation}
          onCommitCloudWarehouseOperation={commitWarehouseRequisitionNow}
          onRunCriticalCloudWarehouseOperation={runCriticalWarehouseClientOperation}
          onCommitWarehouseScoped={commitWarehouseScopedNow}
          canManageFiscalNotes={warehouseEditor}
          canReviewFiscalCosts={role === 'owner' || role === 'admin'}
          canViewPanel={role !== 'warehouse_operator' && role !== 'engineer'}
          canApproveInventory={role === 'owner' || role === 'admin'}
          canArchiveWarehouseRecords={warehouseEditor}
          canEditPostedWarehouseRecords={role === 'owner'}
          canCorrectDeliveredRequisitions={warehouseEditor}
          canSupplementRequisitions={warehouseEditor}
          canCancelDeliveredRequisitions={warehouseEditor}
          canDeleteWarehouseRecords={role === 'owner'}
          canManageEquipmentGroups={role === 'owner' || role === 'warehouse_operator'}
          canOptimizeStorage={role === 'owner'}
          onCommitAttachmentMigration={commitAttachmentMigrationNow}
          storageMaintenanceOrganizationId={orgId}
          auditActor={auditActor}
          activeTab={warehouseTab}
          onActiveTabChange={onWarehouseTabChange}
          isTabDataReady={currentViewDataReady}
        />
      );
  }
}
