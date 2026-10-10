import { readCaptureDraft, writeCaptureDraft } from '@/lib/productionCaptureDraft';
import type { ProductionCaptureChange } from '@/lib/planTakeoff';
import { syncProductionAtomically, stripNormalizedCollections } from '@/lib/projectSync';
import { applyProjectOperation, auditProjectReversal } from '@/lib/projectOperations';
import { scopeKey } from '@/lib/planTakeoff';
import { OpeningError } from '@/components/OpeningError';
import { withReadDeadline } from '@/lib/readDeadline';
import { useState, useMemo, useEffect, useDeferredValue, useCallback, useRef, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { AppView, DailyReport, Project, WarehouseRequisition } from '@/types/project';
import AppSidebar from '@/components/AppSidebar';
import UndoButton from '@/components/UndoButton';
import SaveStatusIndicator, { SaveStatus } from '@/components/SaveStatusIndicator';
import { recordSyncDiagnostic } from '@/lib/syncDiagnostics';
import MigrationDialog from '@/components/MigrationDialog';
import { Menu, X, Loader2, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { applyRupToProject, applyDailyLogsToProject, calculateCPM, captureBaseline, syncBaselineWithRup, settleAllDependencies } from '@/lib/calculations';
import { resolveObraConfig } from '@/lib/obraConfig';
import { flushPendingEditCommits } from '@/lib/pendingEditCommits';
import { getPendingFormNames } from '@/lib/pendingFormNavigation';
import { cloudRetryDelay, isTransientCloudError } from '@/lib/cloudRetry';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { scheduleIdlePreload } from '@/lib/idlePreload';
import { applyUndoOperation, createUndoOperation, type UndoOperation } from '@/lib/operationUndo';
import { auditUndoProductionDeletions, assertProductionDeletionSafe, productionDeletionState } from '@/lib/productionDeletionSafety';
import { protectDailyReportDraft, readDailyReportDrafts, clearDailyReportDraft, type DailyReportDraft } from '@/lib/dailyReportDrafts';
import DailyReportDraftRecovery from '@/components/DailyReportDraftRecovery';
import { getMeasurementWorkStartDate, synchronizeProjectScheduleToWorkStart } from '@/lib/workStartDate';
import { repairProjectAnalyticLinks } from '@/lib/analyticLinks';
import { logToProject, userInfoFromSupabaseUser } from '@/lib/audit';
import { todayISO } from '@/lib/weeklyRoutine';

// Lazy load: cada aba só baixa seu bundle quando aberta pela primeira vez.
// Usa lazyWithReload para recuperar automaticamente de chunks obsoletos após deploy.
const loadDashboard = () => import('@/components/Dashboard');
const loadManagementRoutine = () => import('@/components/OperationalManagementRoutine');
const loadGanttChart = () => import('@/components/OperationalGanttChart');
const loadMeasurement = () => import('@/components/Measurement');
const loadDailyProductionWorkspace = () => import('@/components/DailyProductionWorkspace');
const loadTaskList = () => import('@/components/TaskList');
const loadDailyReport = () => import('@/components/DailyReport');
const loadAdditive = () => import('@/components/Additive');
const loadAdditiveSchedule = () => import('@/components/AdditiveSchedule');
const loadRealCost = () => import('@/components/RealCost');
const loadMaterials = () => import('@/components/Materials');
const loadWarehouse = () => import('@/components/warehouse/Warehouse');

const Dashboard = lazyWithReload(loadDashboard);
const ManagementRoutine = lazyWithReload(loadManagementRoutine);
const GanttChart = lazyWithReload(loadGanttChart);
const Measurement = lazyWithReload(loadMeasurement);
const DailyProductionWorkspace = lazyWithReload(loadDailyProductionWorkspace);
const Additive = lazyWithReload(loadAdditive);
const AdditiveSchedule = lazyWithReload(loadAdditiveSchedule);
const RealCost = lazyWithReload(loadRealCost);
const Materials = lazyWithReload(loadMaterials);
const WarehouseView = lazyWithReload(loadWarehouse);
const ImportSyntheticDialog = lazyWithReload(() => import('@/components/ImportSyntheticDialog'));
const CloudDraftConflictDialog = lazyWithReload(() => import('@/components/CloudDraftConflictDialog'));
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { canAccessAppView, canCreateProject, canDeleteProject, canEditDailyReport, canEditProject, canEditWarehouse, getRestrictedFallbackView, ROLE_LABELS } from '@/lib/organizations';
import { Button } from '@/components/ui/button';
import {
  listCloudProjects,
  loadCloudProjectRecord,
  upsertCloudProject,
  createCloudProject,
  renameCloudProject,
  duplicateCloudProject,
  deleteCloudProject,
  deleteCloudProjectAsOwner,
  generateUniqueCloudName,
  getSampleSeed,
  CloudProjectConflictError,
  CloudProjectPartialSyncError,
  CloudProjectMeta,
  confirmCloudProjectRecord,
  discardCloudProjectRecord,
  getCloudProjectVersion,
  type CloudProjectRecord,
  type CloudProjectVersion,
} from '@/lib/cloudProjects';
import {
  clearProjectDraft,
  createProjectDraft,
  inspectProjectDraft,
  projectHasLocalChanges,
  readStoredProjectDraft,
  resolveRemoteVersionAction,
  serializeProject,
  writeProjectDraft,
} from '@/lib/cloudProjectDraftCore';
import { preloadIndexedDbProjectDraft, supportsIndexedDbDrafts, writeIndexedDbProjectDraft } from '@/lib/cloudDraftIndexedDb';
import type { ProjectMeta } from '@/lib/projectStorage';
import { supabase } from '@/integrations/supabase/client';
import { loadOpenDailyReport, saveOpenDailyReport } from '@/lib/dailyReportCloudSync';
import {
  commitWarehouseOperation,
  mergeWarehouseCloudCommit,
  type WarehouseCloudCommitResult,
  type WarehouseCloudOperation,
} from '@/lib/warehouseCloudCommit';
import type {
  WarehouseScopedCommitResult,
  WarehouseScopedDomain,
} from '@/lib/warehouseScopedCommit';
import {
  confirmHydratedProjectCollections,
  confirmProjectCollectionsSnapshot,
  discardHydratedProjectCollections,
  getHydratedProjectCollections,
  getChangedProjectCollections,
  hasProjectMetadataChanges,
  getLoadedProjectCollections,
  getMissingProjectCollections,
  hydrateProjectFromCloud,
  mergeHydratedProjectCollections,
  mergeProjectRecordsThreeWay,
  mergeProjectMetadata,
  ProjectHydrationError,
  ProjectSnapshotUnavailableError,
} from '@/lib/projectSync';
import {
  PROJECT_COLLECTION_KEYS,
  PROJECT_REALTIME_TABLES,
  WAREHOUSE_REMOTE_SYNC_COLLECTIONS,
  WORK_START_COLLECTIONS,
  hasRemoteWarehouseVersionAdvance,
  normalizeProjectCollections,
  projectAreasForCollections,
  projectCollectionsForRealtimeTable,
  projectCollectionsForView,
  readWarehouseTab,
  type ProjectCollectionKey,
  type WarehouseTab,
} from '@/lib/projectDataScope';

const UNDO_LIMIT = 20;
const SAVE_DEBOUNCE_MS = 4000;
const LOCAL_DRAFT_DEBOUNCE_MS = 900;
const REMOTE_VERSION_POLL_MS = 15000;
const UI_SESSION_VERSION = 1;
const APP_UI_SESSION_KEY = 'obraplanner:ui-session';

function includePendingDraftCollections(
  projectId: string,
  requested: readonly ProjectCollectionKey[],
): ProjectCollectionKey[] {
  const stored = readStoredProjectDraft(projectId);
  if (!stored?.loadedCollections?.length) return [...requested];
  const pending = PROJECT_COLLECTION_KEYS.filter(key => key !== 'auditLogs' && stored.loadedCollections?.includes(key));
  return [...new Set([...requested, ...pending])];
}

type WarehousePrepareScope = WarehouseScopedDomain | 'requisition';
const WAREHOUSE_OPERATION_COLLECTIONS: Record<WarehousePrepareScope, readonly ProjectCollectionKey[]> = {
  receipt: ['warehouseMovements', 'stockMovements'],
  custody: ['warehouseMovements', 'stockMovements', 'warehouseCustody'],
  inventory: ['warehouseMovements', 'stockMovements'],
  adjustment: ['warehouseMovements', 'stockMovements'],
  catalog: ['warehouseMovements', 'stockMovements'],
  requisition: [
    'warehouseMovements',
    'warehouseRequisitions',
    'stockMovements',
    'dailyReports',
  ],
};
const APP_VIEWS: AppView[] = ['dashboard', 'management', 'gantt', 'tasks', 'measurement', 'dailyReport', 'additive', 'additiveSchedule', 'realCost', 'materials', 'warehouse'];

const NEXT_VIEW_PRELOAD: Record<AppView, { view: AppView; load: () => Promise<unknown> }> = {
  dashboard: { view: 'management', load: loadManagementRoutine },
  management: { view: 'tasks', load: () => Promise.all([loadDailyProductionWorkspace(), loadTaskList()]) },
  gantt: { view: 'tasks', load: () => Promise.all([loadDailyProductionWorkspace(), loadTaskList()]) },
  tasks: { view: 'dailyReport', load: loadDailyReport },
  dailyReport: { view: 'tasks', load: loadTaskList },
  measurement: { view: 'realCost', load: loadRealCost },
  additive: { view: 'additiveSchedule', load: loadAdditiveSchedule },
  additiveSchedule: { view: 'additive', load: loadAdditive },
  realCost: { view: 'measurement', load: loadMeasurement },
  materials: { view: 'warehouse', load: loadWarehouse },
  warehouse: { view: 'materials', load: loadMaterials },
};

const VIEW_ROUTE: Record<AppView, string> = {
  dashboard: 'dashboard',
  management: 'rotina',
  gantt: 'cronograma',
  tasks: 'producao',
  dailyReport: 'diario',
  measurement: 'medicao',
  additive: 'aditivo',
  additiveSchedule: 'cronograma-aditivo',
  realCost: 'custos',
  materials: 'materiais',
  warehouse: 'almoxarifado',
};

const ROUTE_VIEW: Record<string, AppView> = {
  ...Object.fromEntries(Object.entries(VIEW_ROUTE).map(([view, route]) => [route, view])),
  // Links antigos da aba independente abrem o lançamento da Produção.
  levantamento: 'tasks',
};

type UndoStacks = Record<AppView, UndoOperation[]>;

function reportForDate(project: Project, date: string): DailyReport | undefined {
  return (project.dailyReports ?? []).find(report => report.date === date);
}

function replaceReportForDate(project: Project, date: string, report: DailyReport | null): Project {
  const withoutDate = (project.dailyReports ?? []).filter(item => item.date !== date);
  return { ...project, dailyReports: report ? [...withoutDate, report] : withoutDate };
}

function replaceSavedDailyReport(serialized: string | null, date: string, report: DailyReport | null): string | null {
  if (!serialized) return serialized;
  try {
    return serializeProject(replaceReportForDate(JSON.parse(serialized) as Project, date, report));
  } catch {
    return serialized;
  }
}

function createDraftProject(name = ''): Project {
  const today = new Date().toISOString().split('T')[0];
  return {
    id: crypto.randomUUID(),
    name,
    startDate: today,
    endDate: today,
    phases: [],
    totalBudget: 0,
  };
}

interface AppUiSession {
  version: typeof UI_SESSION_VERSION;
  projectId?: string;
  view?: AppView;
  mainScrollTop?: number;
  mainScrollLeft?: number;
  windowScrollX?: number;
  windowScrollY?: number;
  updatedAt: string;
}

function isAppView(value: unknown): value is AppView {
  return typeof value === 'string' && APP_VIEWS.includes(value as AppView);
}

function readAppUiSession(): AppUiSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(APP_UI_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Omit<AppUiSession, 'view'> & { view?: unknown };
    if (parsed.version !== UI_SESSION_VERSION) return null;
    if (parsed.view === 'planTakeoff') return { ...parsed, view: 'tasks' };
    if (parsed.view && !isAppView(parsed.view)) return null;
    return { ...parsed, view: isAppView(parsed.view) ? parsed.view : undefined };
  } catch {
    return null;
  }
}

function writeAppUiSession(patch: Partial<AppUiSession>) {
  if (typeof window === 'undefined') return;
  try {
    const previous = readAppUiSession();
    localStorage.setItem(APP_UI_SESSION_KEY, JSON.stringify({
      version: UI_SESSION_VERSION,
      ...previous,
      ...patch,
      updatedAt: new Date().toISOString(),
    } satisfies AppUiSession));
  } catch {
    // Sessao visual e apenas conforto operacional; falha aqui nao deve travar a obra.
  }
}

function readInitialView(routeView?: string): AppView {
  return (routeView && ROUTE_VIEW[routeView]) || readAppUiSession()?.view || 'dashboard';
}

export default function Index() {
  const { user, loading: authLoading, error: authError, reload: reloadAuth, signOut } = useAuth();
  const auditActor = useMemo(() => userInfoFromSupabaseUser(user), [user]);
  const { membership, loading: orgLoading, error: orgError, reload: reloadOrganization } = useOrganization();
  const navigate = useNavigate();
  const location = useLocation();
  const { routeProjectId, routeView } = useParams<{ routeProjectId: string; routeView: string }>();
  const initialRouteProjectIdRef = useRef(routeProjectId);
  const initialViewRef = useRef<AppView>(readInitialView(routeView));

  const [currentView, setCurrentView] = useState<AppView>(initialViewRef.current);
  const [rawProject, setRawProject] = useState<Project | null>(null);
  const [cloudList, setCloudList] = useState<CloudProjectMeta[]>([]);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootRetry, setBootRetry] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [dailyReportSaveErrors, setDailyReportSaveErrors] = useState<Record<string, string>>({});
  const [dailyReportDrafts, setDailyReportDrafts] = useState<Record<string, DailyReportDraft>>({});
  const dailyReportDraftsRef = useRef<Record<string, DailyReportDraft>>({});
  const [dailyReportRecoveryBusy, setDailyReportRecoveryBusy] = useState(false);
  const [currentProjectUpdatedAt, setCurrentProjectUpdatedAt] = useState<string | null>(null);
  const [lastCloudConfirmedAt, setLastCloudConfirmedAt] = useState<string | null>(null);
  const [lastRemoteCheckAt, setLastRemoteCheckAt] = useState<string | null>(null);
  const [remoteUpdateAt, setRemoteUpdateAt] = useState<string | null>(null);
  const [pendingRemoteAreas, setPendingRemoteAreas] = useState<string[]>([]);
  const [remoteDirtyRevision, setRemoteDirtyRevision] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dailyReportInitialDate, setDailyReportInitialDate] = useState<string | undefined>(undefined);
  const [dailyReportInitialFilter, setDailyReportInitialFilter] = useState<string | undefined>(undefined);
  const [dailyReportNavKey, setDailyReportNavKey] = useState(0);
  const [productionWorkspaceInitialTab, setProductionWorkspaceInitialTab] = useState<'production' | 'dailyReport'>('production');
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [draftProjectForImport, setDraftProjectForImport] = useState<Project | null>(null);
  const [warehouseTab, setWarehouseTab] = useState<WarehouseTab>('painel');
  const [dataLoadError, setDataLoadError] = useState<string | null>(null);
  const [dataLoadRetry, setDataLoadRetry] = useState(0);
  const [partialSyncIssue, setPartialSyncIssue] = useState<{
    projectId: string;
    draftProtected: boolean;
  } | null>(null);
  const [partialSyncRetrying, setPartialSyncRetrying] = useState(false);
  const [saveRetryTick, setSaveRetryTick] = useState(0);
  const [draftConflictProjectId, setDraftConflictProjectId] = useState<string | null>(null);
  const [diaryConflictDismissed, setDiaryConflictDismissed] = useState(false);
  const [draftConflictResolving, setDraftConflictResolving] = useState(false);
  const [recoveredDraftSaveRevision, setRecoveredDraftSaveRevision] = useState(0);
  const { confirm: confirmDiscardPendingForm, dialog: pendingFormDialog } = useConfirmDelete();

  const openAfterPendingFormCheck = useCallback((open: () => void) => {
    const pendingForms = getPendingFormNames();
    if (pendingForms.length === 0) {
      open();
      return;
    }
    confirmDiscardPendingForm({
      title: 'Sair com formulário em preenchimento?',
      description: `Há alterações não confirmadas em ${pendingForms.join(', ')}. Deseja descartá-las e continuar?`,
      confirmLabel: 'Descartar e sair',
      cancelLabel: 'Continuar preenchendo',
    }, open);
  }, [confirmDiscardPendingForm]);

  const handleOpenDailyReport = useCallback((dateISO: string, measurementFilter?: string) => {
    openAfterPendingFormCheck(() => {
      setDailyReportInitialDate(dateISO);
      setDailyReportInitialFilter(measurementFilter);
      setDailyReportNavKey(k => k + 1); // força re-aplicação mesmo se valores se repetirem
      setProductionWorkspaceInitialTab('dailyReport');
      setCurrentView('dailyReport');
      setSidebarOpen(false);
      const projectId = rawProjectRef.current?.id;
      if (projectId) navigate(`/obras/${projectId}/diario?data=${dateISO}`);
    });
  }, [navigate, openAfterPendingFormCheck]);

  const handleOpenProductionActivity = useCallback((taskId: string, dateISO: string) => {
    openAfterPendingFormCheck(() => {
      setProductionWorkspaceInitialTab('production');
      setCurrentView('tasks');
      setSidebarOpen(false);
      const projectId = rawProjectRef.current?.id;
      if (projectId) navigate(`/obras/${projectId}/producao?atividade=${encodeURIComponent(taskId)}&data=${encodeURIComponent(dateISO)}`);
    });
  }, [navigate, openAfterPendingFormCheck]);

  const undoStacksRef = useRef<UndoStacks>({ dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], additiveSchedule: [], realCost: [], materials: [], warehouse: [] });
  const [undoVersion, setUndoVersion] = useState(0);
  const rawProjectRef = useRef<Project | null>(null);
  const productionCaptureBusyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const saveRetryTimerRef = useRef<number | null>(null);
  const saveRetryAttemptRef = useRef(0);
  const saveRetryProjectJsonRef = useRef<string | null>(null);
  const partialSyncRetryAttemptRef = useRef(0);
  const partialSyncRetryableRef = useRef(false);
  const draftWriteTimerRef = useRef<number | null>(null);
  const pendingDraftRef = useRef<{ project: Project; baseUpdatedAt: string | null } | null>(null);
  const initialLoadRef = useRef(false);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const warehouseClientOperationInFlightRef = useRef<Promise<unknown> | null>(null);
  const warehouseOperationInFlightRef = useRef<Promise<WarehouseCloudCommitResult> | null>(null);
  const warehouseScopedOperationInFlightRef = useRef<Promise<Project> | null>(null);
  const warehouseLockedRouteRef = useRef<string | null>(null);
  const navigationInFlightRef = useRef(false);
  const currentRouteRef = useRef(`${location.pathname}${location.search}`);
  currentRouteRef.current = `${location.pathname}${location.search}`;
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const dailyReportSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingDailyReportSavesRef = useRef(0);
  const pendingRealtimeDailyReportsRef = useRef<Map<string, { projectId: string; report: DailyReport }>>(new Map());
  const realtimeDailyReportTimerRef = useRef<number | null>(null);
  const refreshDailyReportFromRealtimeRef = useRef<(incoming: DailyReport) => void>(() => undefined);
  const checkRemoteProjectVersionRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshProjectFromRealtimeRef = useRef<(sources: readonly string[]) => Promise<void>>(async () => undefined);
  const currentProjectUpdatedAtRef = useRef<string | null>(null);
  const saveRequestSeqRef = useRef(0);
  const lastSavedProjectJsonRef = useRef<string | null>(null);
  const skipNextAutoSaveRef = useRef(false);
  const conflictDetectedRef = useRef(false);
  const conflictingDraftRef = useRef<{ project: Project; baseUpdatedAt: string | null } | null>(null);
  const remoteCheckInFlightRef = useRef(false);
  const realtimeRefreshTimerRef = useRef<number | null>(null);
  const pendingRealtimeSourcesRef = useRef<Set<string>>(new Set());
  const ownWarehouseRealtimeRowsRef = useRef<Map<string, number>>(new Map());
  const currentWarehouseVersionRef = useRef<number | null>(null);
  // Mantém a última versão observada mesmo quando uma tela legado força a
  // próxima operação crítica a reler a versão antes de gravar.
  const lastObservedWarehouseVersionRef = useRef<number | null>(null);
  const realtimeConnectedRef = useRef(false);
  const remoteDirtyCollectionsRef = useRef<Map<string, Set<ProjectCollectionKey>>>(new Map());
  const backgroundRefreshingCollectionsRef = useRef<Map<string, Set<ProjectCollectionKey>>>(new Map());
  // Mantém a origem detalhada do evento enquanto o debounce/autosave está em
  // curso. Não é estado de UI: impede que uma área em edição pareça incompleta
  // antes de sabermos se ela precisa de rebase ou de conflito explícito.
  const pendingRealtimeCollectionsRef = useRef<Map<string, Set<ProjectCollectionKey>>>(new Map());
  const localDirtyCollectionsRef = useRef<Map<string, Set<ProjectCollectionKey>>>(new Map());
  const localMetadataDirtyRef = useRef<Set<string>>(new Set());
  const dataLoadSequenceRef = useRef(0);
  const projectOpenSequenceRef = useRef(0);
  const activeDataScopeKeyRef = useRef('');
  const partialSyncPendingRef = useRef<{
    projectId: string;
    loadedCollections: ProjectCollectionKey[];
    project: Project;
    draftProtected: boolean;
  } | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const restoredUiSessionRef = useRef<string | null>(null);
  const uiSessionSaverReadyRef = useRef<string | null>(null);

  const orgId = membership?.organization.id;
  const role = membership?.role;
  const editor = role ? canEditProject(role) : false;
  const dailyReportEditor = role ? canEditDailyReport(role) : false;
  const warehouseEditor = role ? canEditWarehouse(role) : false;
  const canViewWarehousePanel = role !== 'warehouse_operator' && role !== 'engineer';
  const canPersistProject = editor || dailyReportEditor || warehouseEditor;
  const creator = role ? canCreateProject(role) : false;
  const remover = role ? canDeleteProject(role) : false;
  const restrictedFallbackView: AppView = role ? getRestrictedFallbackView(role) : 'gantt';

  const cancelScheduledDraft = useCallback((projectId?: string) => {
    const pending = pendingDraftRef.current;
    if (!pending || (projectId && pending.project.id !== projectId)) return;
    if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
    draftWriteTimerRef.current = null;
    pendingDraftRef.current = null;
  }, []);

  const writeProtectedProjectDraft = useCallback((project: Project, baseUpdatedAt: string | null) => {
    const partial = partialSyncPendingRef.current?.projectId === project.id
      ? partialSyncPendingRef.current
      : null;
    const loadedCollections = partial?.loadedCollections ?? getLoadedProjectCollections(project.id);
    const stored = writeProjectDraft(project, baseUpdatedAt, undefined, partial ? {
      pendingNormalizedSync: true,
      loadedCollections,
    } : { loadedCollections });
    if (!stored && supportsIndexedDbDrafts()) {
      const candidate = createProjectDraft(project, baseUpdatedAt, partial ? {
        pendingNormalizedSync: true, loadedCollections,
      } : { loadedCollections });
      void writeIndexedDbProjectDraft(candidate).then(confirmed => {
        if (!confirmed) return;
        const current = partialSyncPendingRef.current;
        if (current?.projectId === project.id && !current.draftProtected) {
          partialSyncPendingRef.current = { ...current, draftProtected: true };
          setPartialSyncIssue({ projectId: project.id, draftProtected: true });
        }
        if (conflictDetectedRef.current && rawProjectRef.current?.id === project.id) setSaveStatus('conflict');
      });
    }
    if (partial && stored && !partial.draftProtected) {
      partialSyncPendingRef.current = { ...partial, draftProtected: true };
      setPartialSyncIssue({ projectId: project.id, draftProtected: true });
    }
    return stored;
  }, []);

  const mergeConfirmedDailyReportIntoPartialSync = useCallback((
    projectId: string,
    date: string,
    report: DailyReport | null,
  ) => {
    const pending = partialSyncPendingRef.current;
    if (!pending || pending.projectId !== projectId) return;
    const pendingProject = replaceReportForDate(pending.project, date, report);
    partialSyncPendingRef.current = { ...pending, project: pendingProject, draftProtected: false };
    const draft = writeProtectedProjectDraft(pendingProject, currentProjectUpdatedAtRef.current);
    const current = partialSyncPendingRef.current;
    if (current?.projectId === projectId) {
      partialSyncPendingRef.current = { ...current, draftProtected: !!draft };
      setPartialSyncIssue({ projectId, draftProtected: !!draft });
    }
  }, [writeProtectedProjectDraft]);

  const scheduleProjectDraft = useCallback((nextProject: Project, baseUpdatedAt: string | null) => {
    const pending = pendingDraftRef.current;
    if (pending && pending.project.id !== nextProject.id) {
      if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
      writeProtectedProjectDraft(pending.project, pending.baseUpdatedAt);
    }
    if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
    pendingDraftRef.current = { project: nextProject, baseUpdatedAt };
    draftWriteTimerRef.current = window.setTimeout(() => {
      const draft = pendingDraftRef.current;
      draftWriteTimerRef.current = null;
      pendingDraftRef.current = null;
      if (draft) {
        if (!supportsIndexedDbDrafts()) {
          writeProtectedProjectDraft(draft.project, draft.baseUpdatedAt);
          return;
        }
        const partial = partialSyncPendingRef.current?.projectId === draft.project.id
          ? partialSyncPendingRef.current : null;
        const candidate = createProjectDraft(draft.project, draft.baseUpdatedAt, {
          pendingNormalizedSync: !!partial,
          loadedCollections: partial?.loadedCollections ?? getLoadedProjectCollections(draft.project.id),
        });
        void writeIndexedDbProjectDraft(candidate).then(confirmed => {
          if (!confirmed) writeProtectedProjectDraft(draft.project, draft.baseUpdatedAt);
        });
      }
    }, LOCAL_DRAFT_DEBOUNCE_MS);
  }, [writeProtectedProjectDraft]);

  const discardProjectDraft = useCallback((projectId: string) => {
    cancelScheduledDraft(projectId);
    clearProjectDraft(projectId);
  }, [cancelScheduledDraft]);

  useEffect(() => () => cancelScheduledDraft(), [cancelScheduledDraft]);
  const safeCurrentView: AppView = role && !canAccessAppView(role, currentView) ? restrictedFallbackView : currentView;
  const allowedViews = role ? APP_VIEWS.filter(view => canAccessAppView(role, view)) : undefined;
  const requiredProjectCollections = useMemo(
    () => projectCollectionsForView(safeCurrentView, warehouseTab),
    [safeCurrentView, warehouseTab],
  );
  const requiredProjectCollectionsKey = requiredProjectCollections.join('|');
  activeDataScopeKeyRef.current = requiredProjectCollectionsKey;
  // Um evento de outra área não hidrata a tela atual. A coleção fica marcada
  // até o usuário entrar na área correspondente; então a hidratação normal
  // busca somente aquele domínio e mantém filtros, formulários e scroll.
  void remoteDirtyRevision;
  const staleCurrentViewCollections = rawProject
    ? requiredProjectCollections.filter(collection => remoteDirtyCollectionsRef.current.get(rawProject.id)?.has(collection))
    : [];
  const missingProjectCollections = rawProject
    ? getMissingProjectCollections(rawProject.id, requiredProjectCollections)
    : requiredProjectCollections;
  const backgroundRefreshing = rawProject
    ? backgroundRefreshingCollectionsRef.current.get(rawProject.id)
    : undefined;
  const locallyDirty = localDirtyCollectionsRef.current.get(rawProject?.id ?? '');
  const productionLocallyDirty = ['taskDailyLogs', 'eapChapters', 'tasks']
    .some(collection => locallyDirty?.has(collection as ProjectCollectionKey));
  const collectionsToHydrate = normalizeProjectCollections([
    ...missingProjectCollections,
    ...staleCurrentViewCollections,
  ]).filter(collection => !backgroundRefreshing?.has(collection)
    && !locallyDirty?.has(collection)
    && !(productionLocallyDirty && ['taskDailyLogs', 'eapChapters', 'tasks'].includes(collection)));
  const currentViewDataReady = !!rawProject && missingProjectCollections.length === 0;

  const refreshPendingRemoteAreas = useCallback((projectId: string) => {
    const dirty = [...(remoteDirtyCollectionsRef.current.get(projectId) ?? [])];
    setPendingRemoteAreas(projectAreasForCollections(dirty));
  }, []);

  const markRemoteCollections = useCallback((projectId: string, collections: readonly ProjectCollectionKey[]) => {
    const normalized = normalizeProjectCollections(collections);
    if (normalized.length === 0) return;
    const dirty = remoteDirtyCollectionsRef.current.get(projectId) ?? new Set<ProjectCollectionKey>();
    normalized.forEach(collection => dirty.add(collection));
    remoteDirtyCollectionsRef.current.set(projectId, dirty);
    refreshPendingRemoteAreas(projectId);
    setRemoteDirtyRevision(revision => revision + 1);
    setRemoteUpdateAt(new Date().toISOString());
  }, [refreshPendingRemoteAreas]);

  const clearRemoteCollections = useCallback((projectId: string, collections: readonly ProjectCollectionKey[]) => {
    const dirty = remoteDirtyCollectionsRef.current.get(projectId);
    if (!dirty) return;
    normalizeProjectCollections(collections).forEach(collection => dirty.delete(collection));
    if (dirty.size === 0) remoteDirtyCollectionsRef.current.delete(projectId);
    refreshPendingRemoteAreas(projectId);
    setRemoteDirtyRevision(revision => revision + 1);
  }, [refreshPendingRemoteAreas]);

  const clearPendingRealtimeCollections = useCallback((projectId: string, collections: readonly ProjectCollectionKey[]) => {
    const pending = pendingRealtimeCollectionsRef.current.get(projectId);
    if (!pending) return;
    normalizeProjectCollections(collections).forEach(collection => pending.delete(collection));
    if (pending.size === 0) pendingRealtimeCollectionsRef.current.delete(projectId);
  }, []);

  const markLocalProjectChanges = useCallback((before: Project, after: Project) => {
    const changed = getChangedProjectCollections(before, after);
    if (changed.length > 0) {
      const dirty = localDirtyCollectionsRef.current.get(after.id) ?? new Set<ProjectCollectionKey>();
      changed.forEach(collection => dirty.add(collection));
      localDirtyCollectionsRef.current.set(after.id, dirty);
    }
    if (hasProjectMetadataChanges(before, after)) localMetadataDirtyRef.current.add(after.id);
  }, []);

  const clearLocalProjectCollections = useCallback((projectId: string, collections?: readonly ProjectCollectionKey[]) => {
    if (!collections) {
      localDirtyCollectionsRef.current.delete(projectId);
      localMetadataDirtyRef.current.delete(projectId);
      return;
    }
    const dirty = localDirtyCollectionsRef.current.get(projectId);
    if (!dirty) return;
    normalizeProjectCollections(collections).forEach(collection => dirty.delete(collection));
    if (dirty.size === 0) localDirtyCollectionsRef.current.delete(projectId);
  }, []);

  const hasLocalCollectionConflict = useCallback((projectId: string, collections: readonly ProjectCollectionKey[]) => {
    const local = localDirtyCollectionsRef.current.get(projectId);
    if (!local) return false;
    return normalizeProjectCollections(collections).some(collection => local.has(collection));
  }, []);

  const synchronizeLoadedProjectSchedule = useCallback((candidate: Project) => (
    getMissingProjectCollections(candidate.id, WORK_START_COLLECTIONS).length === 0
      ? synchronizeProjectScheduleToWorkStart(candidate)
      : candidate
  ), []);

  useEffect(() => {
    if (!authLoading && !authError && !user) navigate('/auth', { replace: true });
  }, [authLoading, authError, user, navigate]);

  useEffect(() => {
    const requestedView = routeView ? ROUTE_VIEW[routeView] : undefined;
    const routedView = requestedView && role && !canAccessAppView(role, requestedView)
      ? restrictedFallbackView
      : requestedView;
    const lockedWarehouseRoute = warehouseLockedRouteRef.current;
    const browserRoute = `${location.pathname}${location.search}`;
    if (lockedWarehouseRoute && browserRoute !== lockedWarehouseRoute) {
      navigate(lockedWarehouseRoute, { replace: true });
      toast.warning('Aguarde a confirmação da operação do Almoxarifado na nuvem.');
      return;
    }
    if (routedView) setCurrentView(previous => previous === routedView ? previous : routedView);
    if (routedView === 'dailyReport') {
      const date = new URLSearchParams(location.search).get('data') || undefined;
      if (date) {
        setDailyReportInitialDate(date);
        setDailyReportNavKey(key => key + 1);
      }
      setProductionWorkspaceInitialTab('dailyReport');
    }
  }, [routeView, location.pathname, location.search, navigate, role, restrictedFallbackView]);

  useEffect(() => {
    const restoreWarehouseRoute = () => {
      const lockedWarehouseRoute = warehouseLockedRouteRef.current;
      if (!lockedWarehouseRoute) return;
      navigate(lockedWarehouseRoute, { replace: true });
      toast.warning('Aguarde a confirmação da operação do Almoxarifado na nuvem.');
    };
    window.addEventListener('popstate', restoreWarehouseRoute);
    return () => window.removeEventListener('popstate', restoreWarehouseRoute);
  }, [navigate]);

  useEffect(() => {
    if (role && !canAccessAppView(role, currentView)) setCurrentView(restrictedFallbackView);
  }, [currentView, restrictedFallbackView, role]);

  useEffect(() => {
    if (!rawProject?.id) return;
    const route = `/obras/${rawProject.id}/${VIEW_ROUTE[safeCurrentView]}`;
    const keepSearch = safeCurrentView === 'management'
      || safeCurrentView === 'dailyReport'
      || (safeCurrentView === 'tasks' && new URLSearchParams(location.search).has('atividade'));
    const target = `${route}${keepSearch ? location.search : ''}`;
    if (`${location.pathname}${location.search}` !== target) navigate(target, { replace: true });
  }, [safeCurrentView, location.pathname, location.search, navigate, rawProject?.id]);

  useEffect(() => {
    if (!rawProject?.id) return;
    if (uiSessionSaverReadyRef.current !== rawProject.id) {
      uiSessionSaverReadyRef.current = rawProject.id;
      return;
    }

    writeAppUiSession({
      projectId: rawProject.id,
      view: currentView,
      mainScrollTop: mainScrollRef.current?.scrollTop ?? 0,
      mainScrollLeft: mainScrollRef.current?.scrollLeft ?? 0,
      windowScrollX: window.scrollX,
      windowScrollY: window.scrollY,
    });
  }, [currentView, rawProject?.id]);

  useEffect(() => {
    const projectId = rawProject?.id;
    if (!projectId) return;

    let rafId = 0;
    const persistScroll = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        writeAppUiSession({
          projectId,
          view: currentView,
          mainScrollTop: mainScrollRef.current?.scrollTop ?? 0,
          mainScrollLeft: mainScrollRef.current?.scrollLeft ?? 0,
          windowScrollX: window.scrollX,
          windowScrollY: window.scrollY,
        });
      });
    };

    const main = mainScrollRef.current;
    window.addEventListener('scroll', persistScroll, { passive: true });
    main?.addEventListener('scroll', persistScroll, { passive: true });
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', persistScroll);
      main?.removeEventListener('scroll', persistScroll);
    };
  }, [currentView, rawProject?.id]);

  const restoreProjectId = rawProject?.id;
  useEffect(() => {
    if (bootLoading || !restoreProjectId) return;
    const session = readAppUiSession();
    if (!session || (session.projectId && session.projectId !== restoreProjectId)) return;
    const restoreKey = `${restoreProjectId}:${session.view ?? 'none'}:${session.updatedAt}`;
    if (restoredUiSessionRef.current === restoreKey) return;

    if (!routeView && session.view && session.view !== currentView && (!role || canAccessAppView(role, session.view))) {
      setCurrentView(session.view);
      return;
    }

    restoredUiSessionRef.current = restoreKey;
    // O preview pode remontar o iframe ao voltar de outro app. Esta restauração
    // devolve a tela para o mesmo ponto visual sem buscar a obra de novo na nuvem.
    window.requestAnimationFrame(() => {
      if (typeof session.windowScrollX === 'number' || typeof session.windowScrollY === 'number') {
        window.scrollTo(session.windowScrollX ?? 0, session.windowScrollY ?? 0);
      }
      if (mainScrollRef.current) {
        mainScrollRef.current.scrollTo({
          left: session.mainScrollLeft ?? 0,
          top: session.mainScrollTop ?? 0,
        });
      }
    });
  }, [bootLoading, currentView, restoreProjectId, role, routeView]);

  const refreshCloudList = useCallback(async (): Promise<CloudProjectMeta[]> => {
    const list = await listCloudProjects();
    setCloudList(list);
    return list;
  }, []);

  const replaceProjectWithoutAutoSave = useCallback((
    projectToLoad: Project | null,
    updatedAt: string | null = null,
    repairApplied = false,
    inspectDraft = true,
    warehouseVersion?: number | null,
  ) => {
    // Invalida qualquer hidratação iniciada para uma fotografia anterior.
    dataLoadSequenceRef.current += 1;
    const cloudProjectForBaseline = projectToLoad;
    let projectForState = projectToLoad;
    if (rawProjectRef.current?.id !== projectToLoad?.id) {
      setLastRemoteCheckAt(null);
      setDailyReportSaveErrors({});
      remoteDirtyCollectionsRef.current.delete(rawProjectRef.current?.id ?? '');
      remoteDirtyCollectionsRef.current.delete(projectToLoad?.id ?? '');
      backgroundRefreshingCollectionsRef.current.delete(rawProjectRef.current?.id ?? '');
      backgroundRefreshingCollectionsRef.current.delete(projectToLoad?.id ?? '');
      pendingRealtimeCollectionsRef.current.delete(rawProjectRef.current?.id ?? '');
      pendingRealtimeCollectionsRef.current.delete(projectToLoad?.id ?? '');
      localDirtyCollectionsRef.current.delete(rawProjectRef.current?.id ?? '');
      localDirtyCollectionsRef.current.delete(projectToLoad?.id ?? '');
      localMetadataDirtyRef.current.delete(rawProjectRef.current?.id ?? '');
      localMetadataDirtyRef.current.delete(projectToLoad?.id ?? '');
      setPendingRemoteAreas([]);
      setRemoteDirtyRevision(revision => revision + 1);
      currentWarehouseVersionRef.current = warehouseVersion ?? null;
      lastObservedWarehouseVersionRef.current = warehouseVersion ?? null;
      partialSyncPendingRef.current = null;
      setPartialSyncIssue(null);
      setDraftConflictProjectId(null);
      conflictingDraftRef.current = null;
    }
    const draftInspection = projectToLoad && inspectDraft
      ? inspectProjectDraft(projectToLoad, updatedAt)
      : { kind: 'none' as const, reason: 'missing' as const };
    const pendingDraftCollections = draftInspection.kind === 'recoverable'
      ? PROJECT_COLLECTION_KEYS.filter(key => draftInspection.draft.loadedCollections?.includes(key))
      : [];
    const recoverableDraft = projectToLoad
      && draftInspection.kind === 'recoverable'
      && pendingDraftCollections.length > 0
      && getMissingProjectCollections(projectToLoad.id, pendingDraftCollections).length === 0
      ? draftInspection.draft
      : null;
    const recoverablePartialDraft = recoverableDraft?.pendingNormalizedSync ? recoverableDraft : null;
    const recoverableLocalDraft = recoverableDraft && !recoverableDraft.pendingNormalizedSync
      ? recoverableDraft
      : null;
    const conflictingDraft = draftInspection.kind === 'candidate'
      ? draftInspection.draft
      : draftInspection.kind === 'recoverable' && !recoverableDraft
        ? draftInspection.draft
        : null;
    if (projectToLoad && recoverablePartialDraft) {
      const loadedCollections = pendingDraftCollections;
      projectForState = mergeHydratedProjectCollections(
        projectToLoad,
        recoverablePartialDraft.project,
        loadedCollections,
      );
      partialSyncPendingRef.current = {
        projectId: projectToLoad.id,
        loadedCollections,
        project: projectForState,
        draftProtected: true,
      };
      setPartialSyncIssue({ projectId: projectToLoad.id, draftProtected: true });
      toast.warning('Uma sincronização detalhada pendente foi recuperada e será confirmada novamente na nuvem.');
    } else if (projectToLoad && recoverableLocalDraft) {
      const draftCollections = new Set(pendingDraftCollections);
      const cloudOnlyCollections = getLoadedProjectCollections(projectToLoad.id)
        .filter(collection => !draftCollections.has(collection));
      // O rascunho é autoritativo apenas para os campos-pai e coleções que
      // estavam realmente carregadas quando foi criado. Coleções novas da rota
      // atual continuam vindo da fotografia confirmada da nuvem.
      const recoveredProject = mergeHydratedProjectCollections(
        recoverableLocalDraft.project,
        projectToLoad,
        cloudOnlyCollections,
      );
      projectForState = repairApplied
        ? repairProjectAnalyticLinks(recoveredProject).project
        : recoveredProject;
      setRecoveredDraftSaveRevision(revision => revision + 1);
      toast.warning('Alterações locais não confirmadas foram recuperadas e serão salvas novamente na nuvem.');
    } else if (projectToLoad && conflictingDraft) {
      // A versão-base mudou em outro aparelho. Sem uma fotografia ancestral não
      // existe mesclagem automática segura; preserve o único rascunho e bloqueie
      // novas escritas até uma reconciliação explícita.
      partialSyncPendingRef.current = null;
      setPartialSyncIssue(null);
      setDraftConflictProjectId(projectToLoad.id);
      conflictingDraftRef.current = {
        project: conflictingDraft.project,
        baseUpdatedAt: conflictingDraft.baseUpdatedAt,
      };
      toast.error(draftInspection.kind === 'candidate' && draftInspection.reason === 'cloud_changed'
        ? 'Há uma alteração local e a obra também mudou em outro aparelho. A cópia local foi preservada e nenhuma versão será sobrescrita.'
        : 'Há uma cópia local anterior sem escopo seguro para mesclagem. Ela foi preservada para uma decisão explícita.');
    } else if (projectToLoad && draftInspection.kind !== 'none') {
      discardProjectDraft(projectToLoad.id);
      if (draftInspection.kind !== 'identical') {
        toast.info('Os dados locais desta obra foram descartados; a versão da nuvem foi carregada.');
      }
    }
    if (projectForState && projectToLoad && recoverableDraft) {
      // A partial offline draft may contain only newly appended audit records.
      // Restore those without removing any historical records read from cloud.
      projectForState = { ...projectForState, auditLogs: [...new Map([
        ...(projectToLoad.auditLogs ?? []).map(log => [log.id, log] as const),
        ...(projectForState.auditLogs ?? []).map(log => [log.id, log] as const),
      ]).values()] };
      if (recoverablePartialDraft && partialSyncPendingRef.current?.projectId === projectForState.id) {
        partialSyncPendingRef.current = { ...partialSyncPendingRef.current, project: projectForState };
      }
    }
    if (!recoverablePartialDraft && projectToLoad && partialSyncPendingRef.current?.projectId === projectToLoad.id) {
      partialSyncPendingRef.current = null;
      setPartialSyncIssue(null);
    }

    skipNextAutoSaveRef.current = recoverableLocalDraft ? false : !repairApplied;
    conflictDetectedRef.current = !!conflictingDraft;
    currentProjectUpdatedAtRef.current = updatedAt;
    if (warehouseVersion !== undefined) {
      currentWarehouseVersionRef.current = warehouseVersion;
      lastObservedWarehouseVersionRef.current = warehouseVersion;
    }
    rawProjectRef.current = projectForState;
    lastSavedProjectJsonRef.current = repairApplied
      ? null
      : (cloudProjectForBaseline ? serializeProject(cloudProjectForBaseline) : null);
    setCurrentProjectUpdatedAt(updatedAt);
    setRawProject(projectForState);
    setLastCloudConfirmedAt(updatedAt);
    if (conflictingDraft) setSaveStatus('conflict');
    else if (repairApplied) setSaveStatus('saving');
    else if (recoverablePartialDraft) setSaveStatus('error');
    else if (recoverableLocalDraft) setSaveStatus('saving');
    else setSaveStatus('saved');
  }, [discardProjectDraft]);

  /**
   * Rebaseia exclusivamente coleções identificadas pelo evento remoto. Isso
   * preserva o que está sendo editado em outra área e nunca transforma uma
   * atualização de Diário, Aditivo, Custos ou Almoxarifado em cópia integral
   * da obra. A coincidência com uma coleção local ainda exige conflito explícito.
   */
  const refreshRemoteCollectionsInBackground = useCallback(async (
    projectToRebase: Project,
    collections: readonly ProjectCollectionKey[],
    knownRemoteVersion?: CloudProjectVersion,
  ): Promise<Project | null> => {
    const current = rawProjectRef.current;
    if (productionCaptureBusyRef.current || !current || current.id !== projectToRebase.id || conflictDetectedRef.current) return null;

    const requestedCollections = normalizeProjectCollections(collections).filter(collection =>
      collection !== 'auditLogs' || getLoadedProjectCollections(current.id).includes('auditLogs'));
    if (requestedCollections.length === 0) return null;

    let remoteVersion = knownRemoteVersion;
    try {
      remoteVersion ??= await getCloudProjectVersion(current.id) ?? undefined;
    } catch (error) {
      console.warn('Não foi possível conferir a versão remota da área alterada.', error);
      return null;
    }
    if (!remoteVersion) return null;

    const refreshing = backgroundRefreshingCollectionsRef.current.get(current.id) ?? new Set<ProjectCollectionKey>();
    requestedCollections.forEach(collection => refreshing.add(collection));
    backgroundRefreshingCollectionsRef.current.set(current.id, refreshing);
    markRemoteCollections(current.id, requestedCollections);
    try {
    let record: CloudProjectRecord;
    try {
      record = await loadCloudProjectRecord(current.id, {
        collections: requestedCollections,
        strict: true,
        deferSnapshot: true,
      });
    } catch (error) {
      console.warn('Não foi possível atualizar a área alterada em segundo plano.', error);
      return null;
    }
    if (!record) return null;

    const latest = rawProjectRef.current;
    // A leitura só é adotada se ainda descreve exatamente a versão que foi
    // classificada. Uma nova alteração remota volta ao fluxo normal do realtime.
    if (productionCaptureBusyRef.current || !latest
      || latest.id !== current.id
      || record.updatedAt !== remoteVersion.updatedAt
      || conflictDetectedRef.current) {
      discardCloudProjectRecord(record);
      return null;
    }

    const sameCollectionEdited = hasLocalCollectionConflict(current.id, requestedCollections);
    let savedBaseline: Project | null = null;
    if (lastSavedProjectJsonRef.current) {
      try { savedBaseline = JSON.parse(lastSavedProjectJsonRef.current) as Project; } catch { /* preserve conflict */ }
    }
    let rebasedCurrent = sameCollectionEdited
      ? savedBaseline && mergeProjectRecordsThreeWay(savedBaseline, latest, record.project, requestedCollections)
      : mergeHydratedProjectCollections(latest, record.project, requestedCollections);
    let rebasedForRetry = sameCollectionEdited
      ? savedBaseline && mergeProjectRecordsThreeWay(savedBaseline, projectToRebase, record.project, requestedCollections)
      : mergeHydratedProjectCollections(projectToRebase, record.project, requestedCollections);
    if (!rebasedCurrent || !rebasedForRetry) {
      discardCloudProjectRecord(record);
      return null;
    }
    const remoteMetadataChanged = savedBaseline && hasProjectMetadataChanges(savedBaseline, record.project);
    if (remoteMetadataChanged) {
      if (hasProjectMetadataChanges(savedBaseline, latest)) {
        discardCloudProjectRecord(record);
        return null;
      }
      rebasedCurrent = mergeProjectMetadata(rebasedCurrent, record.project);
      rebasedForRetry = mergeProjectMetadata(rebasedForRetry, record.project);
    }
    let rebasedSavedBaseline = rebasedCurrent;
    if (savedBaseline) {
      rebasedSavedBaseline = mergeHydratedProjectCollections(savedBaseline, record.project, requestedCollections);
      if (remoteMetadataChanged) rebasedSavedBaseline = mergeProjectMetadata(rebasedSavedBaseline, record.project);
    }

    confirmCloudProjectRecord(record);
    lastSavedProjectJsonRef.current = serializeProject(rebasedSavedBaseline);
    currentProjectUpdatedAtRef.current = record.updatedAt;
    currentWarehouseVersionRef.current = record.warehouseVersion;
    lastObservedWarehouseVersionRef.current = record.warehouseVersion;
    setCurrentProjectUpdatedAt(record.updatedAt);
    setLastCloudConfirmedAt(record.updatedAt);
    setRemoteUpdateAt(new Date().toISOString());
    clearRemoteCollections(current.id, requestedCollections);
    clearPendingRealtimeCollections(current.id, requestedCollections);
    // Se outra área tiver edição pendente, o autosave continua normalmente; se
    // não houver, o rebase remoto não pode disparar uma gravação redundante.
    skipNextAutoSaveRef.current = !projectHasLocalChanges(rebasedCurrent, lastSavedProjectJsonRef.current);
    rawProjectRef.current = rebasedCurrent;
    setRawProject(rebasedCurrent);
    return rebasedForRetry;
    } finally {
      const active = backgroundRefreshingCollectionsRef.current.get(current.id);
      requestedCollections.forEach(collection => active?.delete(collection));
      if (active?.size === 0) backgroundRefreshingCollectionsRef.current.delete(current.id);
      // Se a atualização falhar, o marcador pendente aciona uma nova leitura
      // sem desmontar a tela que já possui dados.
      setRemoteDirtyRevision(revision => revision + 1);
    }
  }, [clearPendingRealtimeCollections, clearRemoteCollections, hasLocalCollectionConflict, markRemoteCollections]);

  /**
   * Operações atômicas do Almoxarifado também avançam `projects.updated_at`.
   * A versão própria permite identificá-las com segurança até quando o evento
   * detalhado chega depois da alteração da linha principal da obra.
   */
  const refreshRemoteWarehouseInBackground = useCallback(async (
    projectToRebase: Project,
    knownRemoteVersion?: CloudProjectVersion,
  ): Promise<Project | null> => {
    let remoteVersion = knownRemoteVersion;
    try {
      remoteVersion ??= await getCloudProjectVersion(projectToRebase.id) ?? undefined;
    } catch (error) {
      console.warn('Não foi possível conferir a versão remota do Almoxarifado.', error);
      return null;
    }
    if (!remoteVersion || !hasRemoteWarehouseVersionAdvance(
      lastObservedWarehouseVersionRef.current,
      remoteVersion.warehouseVersion,
    )) return null;

    return refreshRemoteCollectionsInBackground(
      projectToRebase,
      WAREHOUSE_REMOTE_SYNC_COLLECTIONS,
      remoteVersion,
    );
  }, [refreshRemoteCollectionsInBackground]);

  const persistProject = useCallback(async (
    projectToSave: Project,
    projectOrgId: string,
    options: { retainDraftUntilVerified?: boolean } = {},
  ) => {
    const pendingAtStart = partialSyncPendingRef.current?.projectId === projectToSave.id
      ? partialSyncPendingRef.current
      : null;
    // Um retry deve confirmar exatamente a fotografia que falhou. Usar o estado
    // atualmente renderizado poderia reenviar uma versão anterior e apagar o
    // rascunho que contém as coleções normalizadas ainda pendentes.
    const projectToPersist = pendingAtStart?.project ?? projectToSave;
    const nextJson = serializeProject(projectToPersist);
    const pendingPartialSync = !!pendingAtStart;
    if (nextJson === lastSavedProjectJsonRef.current && !pendingPartialSync) {
      if (!options.retainDraftUntilVerified) discardProjectDraft(projectToPersist.id);
      setSaveStatus('saved');
      return;
    }

    const seq = ++saveRequestSeqRef.current;
    const request = saveQueueRef.current.catch(() => undefined).then(async () => {
      const pendingAtRequest = partialSyncPendingRef.current?.projectId === projectToPersist.id
        ? partialSyncPendingRef.current
        : pendingAtStart;
      let effectiveProject = pendingAtRequest?.project ?? projectToPersist;
      let effectiveJson = serializeProject(effectiveProject);
      let updatedAt: string;
      let partialSync = false;
      try {
        // Uma entrada/retirada concluída entre a edição local e o autosave
        // atualiza a versão-pai da obra. Se for a única mudança externa,
        // rebaseie o Almoxarifado e repita uma única vez sem interromper outro
        // módulo. Qualquer outro conflito permanece explícito e protegido.
        for (let attempt = 0; ; attempt += 1) {
          try {
            updatedAt = await upsertCloudProject(effectiveProject, projectOrgId, currentProjectUpdatedAtRef.current ?? undefined);
            break;
          } catch (error) {
            if (attempt === 0 && error instanceof CloudProjectConflictError) {
              const knownRemoteCollections = [
                ...(pendingRealtimeCollectionsRef.current.get(effectiveProject.id) ?? []),
                ...(remoteDirtyCollectionsRef.current.get(effectiveProject.id) ?? []),
              ];
              const rebased = await refreshRemoteWarehouseInBackground(effectiveProject)
                ?? await refreshRemoteCollectionsInBackground(effectiveProject, knownRemoteCollections);
              if (rebased) {
                effectiveProject = rebased;
                effectiveJson = serializeProject(rebased);
                continue;
              }
            }
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof ProjectSnapshotUnavailableError) {
          setDataLoadRetry(value => value + 1);
          throw error;
        }
        if (!(error instanceof CloudProjectPartialSyncError)) throw error;
        updatedAt = error.updatedAt;
        partialSync = true;
        // A fotografia anterior permanece como base do retry idempotente. O
        // estado local e o rascunho não podem avançar como se as coleções
        // normalizadas também tivessem sido confirmadas.
        const loadedCollections = getLoadedProjectCollections(effectiveProject.id);
        partialSyncPendingRef.current = {
          projectId: effectiveProject.id,
          loadedCollections,
          project: effectiveProject,
          draftProtected: false,
        };
        const draft = writeProtectedProjectDraft(effectiveProject, updatedAt);
        const draftProtected = !!draft;
        partialSyncRetryableRef.current = isTransientCloudError(error);
        const pending = partialSyncPendingRef.current;
        if (pending?.projectId === effectiveProject.id) {
          partialSyncPendingRef.current = { ...pending, draftProtected };
        }
        setPartialSyncIssue({ projectId: effectiveProject.id, draftProtected });
        console.warn('[cloudProjects] Sincronização detalhada pendente.', error.detail);
        if (draftProtected) {
          toast.warning('Parte da obra foi salva, mas a sincronização detalhada está pendente. A cópia local foi confirmada; use “Tentar novamente”.');
        } else {
          toast.error('A sincronização detalhada falhou e não foi possível criar a cópia local. Não feche nem recarregue esta página; use “Tentar novamente”.');
        }
      }
      conflictDetectedRef.current = false;
      currentProjectUpdatedAtRef.current = updatedAt;
      // O trigger do banco pode avançar a versão do Almoxarifado quando uma
      // tela ainda migrada parcialmente alterar sua ramificação. A próxima
      // operação crítica relê essa versão antes de gravar.
      currentWarehouseVersionRef.current = null;
      setCurrentProjectUpdatedAt(updatedAt);
      if (!partialSync) {
        partialSyncRetryAttemptRef.current = 0;
        partialSyncRetryableRef.current = false;
        if (partialSyncPendingRef.current?.projectId === effectiveProject.id) {
          partialSyncPendingRef.current = null;
        }
        setPartialSyncIssue(current => current?.projectId === effectiveProject.id ? null : current);
        lastSavedProjectJsonRef.current = effectiveJson;
        // Só limpa o escopo local se nenhuma edição mais nova chegou enquanto
        // esta requisição estava em voo. Assim uma alteração de outra área não
        // transforma um rascunho novo em "salvo" por engano.
        if (rawProjectRef.current?.id === effectiveProject.id
          && serializeProject(rawProjectRef.current) === effectiveJson) {
          clearLocalProjectCollections(effectiveProject.id);
        }
        setLastCloudConfirmedAt(updatedAt);
        if (pendingAtRequest && rawProjectRef.current?.id === effectiveProject.id) {
          skipNextAutoSaveRef.current = true;
          rawProjectRef.current = effectiveProject;
          setRawProject(effectiveProject);
        }
      }
      if (seq === saveRequestSeqRef.current && !saveTimerRef.current && !partialSync) {
        if (!options.retainDraftUntilVerified) discardProjectDraft(effectiveProject.id);
        setSaveStatus('saved');
      } else if (partialSync) {
        setSaveStatus('error');
      }
      setCloudList(prev => {
        const idx = prev.findIndex(p => p.id === effectiveProject.id);
        const meta: CloudProjectMeta = {
          id: effectiveProject.id,
          name: effectiveProject.name,
          createdAt: idx >= 0 ? prev[idx].createdAt : new Date().toISOString(),
          updatedAt,
        };
        if (idx >= 0) { const copy = [...prev]; copy[idx] = meta; return copy; }
        return [meta, ...prev];
      });
    });

    saveQueueRef.current = request;
    inFlightSaveRef.current = request;
    try {
      await request;
    } finally {
      if (inFlightSaveRef.current === request) inFlightSaveRef.current = null;
    }
  }, [clearLocalProjectCollections, discardProjectDraft, refreshRemoteCollectionsInBackground, refreshRemoteWarehouseInBackground, writeProtectedProjectDraft]);

  const handleCloudConflict = useCallback(async (localProject: Project) => {
    conflictDetectedRef.current = true;
    cancelScheduledDraft(localProject.id);
    const baseUpdatedAt = currentProjectUpdatedAtRef.current;
    const stored = writeProtectedProjectDraft(localProject, baseUpdatedAt);
    conflictingDraftRef.current = { project: localProject, baseUpdatedAt };
    setDraftConflictProjectId(localProject.id);
    setDiaryConflictDismissed(false);
    setSaveStatus(stored ? 'conflict' : 'error');
    if (stored) {
      toast.error('A obra mudou em outro aparelho. Sua cópia local foi preservada para uma decisão explícita.');
    } else {
      toast.error('A obra mudou em outro aparelho e a cópia local só está preservada nesta tela. Não feche nem recarregue antes de baixá-la.');
    }
  }, [cancelScheduledDraft, writeProtectedProjectDraft]);

  const retryPendingPartialSync = useCallback(async (silent = false) => {
    const pending = partialSyncPendingRef.current;
    if (!pending || !orgId || partialSyncRetrying) return;
    if (!navigator.onLine) {
      setSaveStatus('offline');
      toast.error('Sem conexão. A cópia pendente continua neste navegador.');
      return;
    }
    setPartialSyncRetrying(true);
    setSaveStatus('saving');
    try {
      await persistProject(pending.project, orgId);
      if (partialSyncPendingRef.current?.projectId === pending.projectId) {
        setSaveStatus('error');
        return;
      }
      if (!silent) toast.success('Sincronização detalhada confirmada na nuvem.');
    } catch (error) {
      console.warn('Não foi possível repetir a sincronização detalhada.', error);
      if (error instanceof CloudProjectConflictError) {
        partialSyncRetryableRef.current = false;
        partialSyncPendingRef.current = null;
        setPartialSyncIssue(null);
        await handleCloudConflict(pending.project);
        return;
      }
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
      partialSyncRetryableRef.current = isTransientCloudError(error);
      setPartialSyncIssue(current => current?.projectId === pending.projectId ? { ...current } : current);
      if (!silent) toast.error('A sincronização ainda não foi confirmada. A cópia pendente foi mantida.');
    } finally {
      setPartialSyncRetrying(false);
    }
  }, [handleCloudConflict, orgId, partialSyncRetrying, persistProject]);

  useEffect(() => {
    if (!partialSyncIssue || !partialSyncIssue.draftProtected || !partialSyncRetryableRef.current
      || partialSyncRetrying || !navigator.onLine) return;
    const delay = cloudRetryDelay(partialSyncRetryAttemptRef.current++);
    if (delay === null) return;
    const timer = window.setTimeout(() => void retryPendingPartialSync(true), delay);
    return () => window.clearTimeout(timer);
  }, [partialSyncIssue, partialSyncRetrying, retryPendingPartialSync]);

  useEffect(() => {
    const retryWhenOnline = () => {
      if (partialSyncPendingRef.current && partialSyncRetryableRef.current) {
        partialSyncRetryAttemptRef.current = 0;
        void retryPendingPartialSync(true);
      }
    };
    window.addEventListener('online', retryWhenOnline);
    return () => window.removeEventListener('online', retryWhenOnline);
  }, [retryPendingPartialSync]);

  const downloadConflictingDraft = useCallback(() => {
    if (!draftConflictProjectId) return false;
    const storedDraft = readStoredProjectDraft(draftConflictProjectId);
    const inMemoryDraft = conflictingDraftRef.current?.project.id === draftConflictProjectId
      ? conflictingDraftRef.current
      : null;
    const draft = storedDraft ?? (inMemoryDraft ? {
      version: 2,
      baseUpdatedAt: inMemoryDraft.baseUpdatedAt,
      localDraftUpdatedAt: new Date().toISOString(),
      project: inMemoryDraft.project,
    } : null);
    if (!draft) {
      toast.error('A cópia local não está mais disponível neste navegador.');
      return false;
    }
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `copia-local-obra-${draftConflictProjectId}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success('Cópia local baixada.');
    return true;
  }, [draftConflictProjectId]);

  const discardConflictingDraft = useCallback(async () => {
    if (!draftConflictProjectId || draftConflictResolving) return;
    setDraftConflictResolving(true);
    try {
      const record = await loadCloudProjectRecord(draftConflictProjectId, {
        collections: requiredProjectCollections,
        strict: true,
        deferSnapshot: true,
      });
      if (!record) throw new Error('A obra não foi encontrada na nuvem.');
      if (draftConflictProjectId !== rawProjectRef.current?.id) {
        discardCloudProjectRecord(record);
        return;
      }
      confirmCloudProjectRecord(record);
      discardProjectDraft(draftConflictProjectId);
      conflictDetectedRef.current = false;
      conflictingDraftRef.current = null;
      setDraftConflictProjectId(null);
      setDiaryConflictDismissed(false);
      replaceProjectWithoutAutoSave(record.project, record.updatedAt, record.repairApplied, false, record.warehouseVersion);
      toast.success('A versão confirmada na nuvem foi carregada. A cópia local pendente foi descartada.');
    } catch (error) {
      console.warn('Não foi possível concluir a resolução da cópia local.', error);
      setSaveStatus(navigator.onLine ? 'conflict' : 'offline');
      toast.error('Não foi possível reler a obra na nuvem. A cópia local continua preservada.');
    } finally {
      setDraftConflictResolving(false);
    }
  }, [discardProjectDraft, draftConflictProjectId, draftConflictResolving, replaceProjectWithoutAutoSave, requiredProjectCollections]);

  useEffect(() => {
    rawProjectRef.current = rawProject;
  }, [rawProject]);

  const workStartDataReady = !!rawProject
    && getMissingProjectCollections(rawProject.id, WORK_START_COLLECTIONS).length === 0;
  const measurementWorkStart = rawProject && workStartDataReady
    ? getMeasurementWorkStartDate(rawProject)
    : undefined;
  const appliedWorkStart = rawProject?.uiState?.ganttWorkStartDateApplied;
  useEffect(() => {
    if (productionCaptureBusyRef.current || !editor || !measurementWorkStart) return;
    if (conflictDetectedRef.current || partialSyncPendingRef.current?.projectId === rawProjectRef.current?.id) return;
    setRawProject(previous => {
      if (!previous) return previous;
      const synchronized = synchronizeLoadedProjectSchedule(previous);
      if (synchronized === previous) return previous;
      skipNextAutoSaveRef.current = false;
      rawProjectRef.current = synchronized;
      if (projectHasLocalChanges(synchronized, lastSavedProjectJsonRef.current)) {
        scheduleProjectDraft(synchronized, currentProjectUpdatedAtRef.current);
      }
      setSaveStatus('saving');
      return synchronized;
    });
  }, [appliedWorkStart, editor, measurementWorkStart, partialSyncIssue, rawProject?.id, scheduleProjectDraft, synchronizeLoadedProjectSchedule]);

  const flushPendingSave = useCallback(async () => {
    if (productionCaptureBusyRef.current) { toast.warning('Aguarde a confirmação conjunta da captura antes de sair desta área.'); return false; }
    if (!user || !orgId || !rawProject || !initialLoadRef.current || !canPersistProject) return true;
    if (conflictDetectedRef.current) {
      setSaveStatus('conflict');
      toast.warning('Resolva a divergência entre a cópia local e a nuvem antes de sair desta área.');
      return false;
    }

    // Uma retirada com fotos começa antes da RPC. Aguarde todo o fluxo do
    // navegador (upload, transação e aplicação do Diário) antes de trocar a obra.
    if (warehouseClientOperationInFlightRef.current) {
      try {
        await warehouseClientOperationInFlightRef.current;
      } catch {
        return false;
      }
      if (conflictDetectedRef.current) return false;
    }

    if (pendingDailyReportSavesRef.current > 0) {
      try {
        await dailyReportSaveQueueRef.current;
      } catch {
        return false;
      }
      if (conflictDetectedRef.current) return false;
    }

    if (warehouseOperationInFlightRef.current) {
      try {
        await warehouseOperationInFlightRef.current;
      } catch {
        return false;
      }
      if (conflictDetectedRef.current) return false;
    }

    if (warehouseScopedOperationInFlightRef.current) {
      try {
        await warehouseScopedOperationInFlightRef.current;
      } catch {
        return false;
      }
      if (conflictDetectedRef.current) return false;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      setSaveStatus('saving');
      try {
        await persistProject(rawProject, orgId);
        return !conflictDetectedRef.current
          && partialSyncPendingRef.current?.projectId !== rawProject.id;
      } catch (e) {
        console.warn(e);
        if (e instanceof CloudProjectConflictError) {
          await handleCloudConflict(rawProject);
        } else {
          setSaveStatus(navigator.onLine ? 'error' : 'offline');
          toast.error('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
        }
        return false;
      }
    }

    if (inFlightSaveRef.current) {
      try {
        await inFlightSaveRef.current;
        return !conflictDetectedRef.current
          && partialSyncPendingRef.current?.projectId !== rawProject.id;
      } catch (e) {
        if (e instanceof CloudProjectConflictError && rawProjectRef.current) {
          await handleCloudConflict(rawProjectRef.current);
        }
        return false;
      }
    }

    if (partialSyncPendingRef.current?.projectId === rawProject.id) {
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
      toast.warning('Confirme a sincronização detalhada em “Tentar novamente” antes de sair desta área.');
      return false;
    }

    return true;
  }, [user, orgId, rawProject, canPersistProject, persistProject, handleCloudConflict]);

  const runProtectedNavigation = useCallback(async <T,>(
    action: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (getPendingFormNames().length > 0) {
      toast.warning('Conclua ou descarte o formulário em preenchimento antes de trocar de obra ou sair desta área.');
      return undefined;
    }
    if (navigationInFlightRef.current) {
      toast.warning('Aguarde a navegação atual terminar.');
      return undefined;
    }
    navigationInFlightRef.current = true;
    try {
      if (!(await flushPendingSave())) return undefined;
      return await action();
    } finally {
      navigationInFlightRef.current = false;
    }
  }, [flushPendingSave]);

  useEffect(() => {
    if (!user || !orgId) return;
    let cancelled = false;
    (async () => {
      setBootLoading(true);
      setBootError(null);
      try {
        let list = await withReadDeadline(refreshCloudList());
        if (cancelled) return;
        if (list.length === 0 && creator) {
          const name = await generateUniqueCloudName('Minha primeira obra');
          const created = await createCloudProject(name, orgId, getSampleSeed());
          if (cancelled) return;
          list = await refreshCloudList();
          replaceProjectWithoutAutoSave(created, list.find(p => p.id === created.id)?.updatedAt ?? null);
        } else if (list.length > 0) {
          const rememberedProjectId = readAppUiSession()?.projectId;
          const preferredProjectId = [initialRouteProjectIdRef.current, rememberedProjectId, list[0].id]
            .find(id => !!id && list.some(projectMeta => projectMeta.id === id)) ?? list[0].id;
          await withReadDeadline(preloadIndexedDbProjectDraft(preferredProjectId));
          if (cancelled) return;
          const initialWarehouseTab = readWarehouseTab(preferredProjectId, canViewWarehousePanel, role === 'owner');
          setWarehouseTab(initialWarehouseTab);
          const initialView = role && !canAccessAppView(role, initialViewRef.current)
            ? restrictedFallbackView
            : initialViewRef.current;
          const routeCode = initialView === 'tasks' ? Promise.all([loadDailyProductionWorkspace(), loadTaskList()])
            : initialView === 'dailyReport' ? loadDailyReport() : null;
          void routeCode?.catch(() => undefined);
          const initialCollections = includePendingDraftCollections(
            preferredProjectId,
            projectCollectionsForView(initialView, initialWarehouseTab),
          );
          const record = await withReadDeadline(loadCloudProjectRecord(preferredProjectId, {
            collections: initialCollections,
            strict: true,
            deferSnapshot: true,
          }));
          if (cancelled) {
            if (record) discardCloudProjectRecord(record);
            return;
          }
          if (!record) throw new Error('A obra não foi encontrada. Tente novamente ou confira o acesso com a administração.');
          confirmCloudProjectRecord(record);
          // Opening an area never runs warehouse maintenance or downloads its history.
          replaceProjectWithoutAutoSave(record.project, record.updatedAt, record.repairApplied, true, record.warehouseVersion);
        } else {
          throw new Error('Não há obras disponíveis para sua conta. Confira com a administração da empresa.');
        }
        initialLoadRef.current = true;
      } catch (e) {
        console.warn(e);
        if (!cancelled) setBootError(e instanceof Error ? e.message : 'Não foi possível carregar as obras. Confira sua conexão e tente novamente.');
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, orgId, creator, refreshCloudList, replaceProjectWithoutAutoSave, role, auditActor, canViewWarehousePanel, restrictedFallbackView, bootRetry]);

  useEffect(() => {
    if (bootLoading || !rawProject?.id || collectionsToHydrate.length === 0) {
      if (rawProject?.id && missingProjectCollections.length === 0 && staleCurrentViewCollections.length === 0) setDataLoadError(null);
      return;
    }
    const projectId = rawProject.id;
    const requestCollections = [...collectionsToHydrate] as ProjectCollectionKey[];
    const sequence = ++dataLoadSequenceRef.current;
    setDataLoadError(null);

    void (async () => {
      try {
        // Evita que a troca de área cancele um autosave legítimo antes de
        // mesclar as coleções que ainda não estavam em memória.
        if (!(await flushPendingSave())) throw new Error('A alteração pendente precisa ser salva antes de abrir outra área.');
        const source = rawProjectRef.current;
        if (!source || source.id !== projectId) return;
        const beforeLoad = await getCloudProjectVersion(projectId);
        if (!beforeLoad) throw new Error('A versão da obra não pôde ser conferida.');
        const hydrated = await hydrateProjectFromCloud(source, {
          collections: requestCollections,
          strict: true,
        });
        const afterLoad = await getCloudProjectVersion(projectId);
        if (!afterLoad || afterLoad.updatedAt !== beforeLoad.updatedAt) {
          discardHydratedProjectCollections(hydrated);
          throw new Error('A obra mudou durante o carregamento. Atualize a área antes de editar.');
        }
        if (productionCaptureBusyRef.current || dataLoadSequenceRef.current !== sequence) {
          discardHydratedProjectCollections(hydrated);
          return;
        }
        const latest = rawProjectRef.current;
        if (!latest || latest.id !== projectId) {
          discardHydratedProjectCollections(hydrated);
          return;
        }
        const cloudMerged = mergeHydratedProjectCollections(latest, hydrated, requestCollections);
        let savedCloudMerged = cloudMerged;
        if (lastSavedProjectJsonRef.current) {
          try {
            const saved = JSON.parse(lastSavedProjectJsonRef.current) as Project;
            savedCloudMerged = mergeHydratedProjectCollections(saved, hydrated, requestCollections);
          } catch {
            savedCloudMerged = cloudMerged;
          }
        }
        lastSavedProjectJsonRef.current = serializeProject(savedCloudMerged);

        // O reparo depende de três coleções e, antes, só era executado na
        // primeira abertura. Execute-o também quando a última dependência
        // chegar sob demanda, mantendo a diferença para o autosave persistir.
        const loaded = new Set([
          ...getLoadedProjectCollections(projectId),
          ...getHydratedProjectCollections(hydrated),
        ]);
        const canRepairAnalyticLinks = loaded.has('budgetItems')
          && loaded.has('analyticCompositions')
          && loaded.has('additives');
        const repaired = canRepairAnalyticLinks
          ? repairProjectAnalyticLinks(cloudMerged)
          : { project: cloudMerged, changed: false };
        const merged = repaired.project;
        confirmHydratedProjectCollections(hydrated);
        clearRemoteCollections(projectId, requestCollections);
        skipNextAutoSaveRef.current = !repaired.changed;
        rawProjectRef.current = merged;
        setRawProject(merged);
        if (repaired.changed) {
          scheduleProjectDraft(merged, currentProjectUpdatedAtRef.current);
          setSaveStatus('saving');
        }
      } catch (error) {
        if (dataLoadSequenceRef.current !== sequence || rawProjectRef.current?.id !== projectId) return;
        console.warn('[project-load] Falha ao carregar dados da área.', error);
        setDataLoadError(error instanceof ProjectHydrationError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Não foi possível carregar os dados desta área.');
      }
    })();
  // A chave representa integralmente o escopo. A lista ausente é fotografada
  // no início de cada tentativa para impedir loops por identidade do array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootLoading, dataLoadRetry, rawProject?.id, requiredProjectCollectionsKey, remoteDirtyRevision]);

  // Salvamento debounced (somente se o usuário pode editar)
  useEffect(() => {
    void recoveredDraftSaveRevision;
    void saveRetryTick;
    if (!user || !orgId || !rawProject || !initialLoadRef.current) return;
    if (!canPersistProject) return;
    // O Diário tem fila própria em daily_reports. Não permita que o autosave
    // global regrave a obra enquanto uma edição direta está sendo conciliada.
    if (pendingDailyReportSavesRef.current > 0) return;
    if (conflictDetectedRef.current) return;
    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      setSaveStatus(partialSyncPendingRef.current?.projectId === rawProject.id ? 'error' : 'saved');
      return;
    }
    const currentJson = serializeProject(rawProject);
    if (saveRetryProjectJsonRef.current !== currentJson) {
      saveRetryProjectJsonRef.current = currentJson;
      saveRetryAttemptRef.current = 0;
    }
    if (saveRetryTimerRef.current !== null) {
      window.clearTimeout(saveRetryTimerRef.current);
      saveRetryTimerRef.current = null;
    }
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    setSaveStatus(navigator.onLine ? 'pending' : 'offline');
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        saveTimerRef.current = null;
        setSaveStatus('saving');
        await persistProject(rawProject, orgId);
        if (partialSyncPendingRef.current?.projectId !== rawProject.id) saveRetryAttemptRef.current = 0;
      } catch (e) {
        console.warn(e);
        if (e instanceof CloudProjectConflictError) {
          await handleCloudConflict(rawProject);
        } else {
          setSaveStatus(navigator.onLine ? 'error' : 'offline');
          const retryDelay = isTransientCloudError(e) ? cloudRetryDelay(saveRetryAttemptRef.current++) : null;
          if (retryDelay !== null) {
            saveRetryTimerRef.current = window.setTimeout(() => {
              saveRetryTimerRef.current = null;
              if (rawProjectRef.current?.id === rawProject.id && !conflictDetectedRef.current) {
                setSaveRetryTick(value => value + 1);
              }
            }, retryDelay);
          } else {
            toast.error('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
          }
        }
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (saveRetryTimerRef.current !== null) window.clearTimeout(saveRetryTimerRef.current);
    };
  }, [rawProject, user, orgId, canPersistProject, persistProject, handleCloudConflict, recoveredDraftSaveRevision, saveRetryTick]);

  const checkRemoteProjectVersion = useCallback(async () => {
    const current = rawProjectRef.current;
    if (!current || !orgId || !initialLoadRef.current || document.visibilityState !== 'visible') return;
    if (pendingDailyReportSavesRef.current > 0) return;
    if (!navigator.onLine) {
      setSaveStatus('offline');
      return;
    }
    if (productionCaptureBusyRef.current || remoteCheckInFlightRef.current || conflictDetectedRef.current || saveTimerRef.current || inFlightSaveRef.current) return;

    remoteCheckInFlightRef.current = true;
    const dataScopeAtRequest = activeDataScopeKeyRef.current;
    try {
      if (partialSyncPendingRef.current?.projectId === current.id) {
        // A verificação periódica é somente leitura. Uma falha parcial exige
        // retry explícito para não regravar a linha principal a cada 15 s.
        setSaveStatus(navigator.onLine ? 'error' : 'offline');
        return;
      }
      const remoteVersion = await getCloudProjectVersion(current.id);
      if (!remoteVersion) return;
      const currentAfterVersionCheck = rawProjectRef.current;
      if (!currentAfterVersionCheck
        || currentAfterVersionCheck.id !== current.id
        || activeDataScopeKeyRef.current !== dataScopeAtRequest
        || conflictDetectedRef.current
        || saveTimerRef.current
        || inFlightSaveRef.current || productionCaptureBusyRef.current) return;
      setLastRemoteCheckAt(new Date().toISOString());
      if (await refreshRemoteWarehouseInBackground(currentAfterVersionCheck, remoteVersion)) return;
      const knownRemoteCollections = [
        ...(pendingRealtimeCollectionsRef.current.get(current.id) ?? []),
        ...(remoteDirtyCollectionsRef.current.get(current.id) ?? []),
      ];
      if (await refreshRemoteCollectionsInBackground(
        currentAfterVersionCheck,
        knownRemoteCollections,
        remoteVersion,
      )) return;
      const hasLocalChanges = projectHasLocalChanges(currentAfterVersionCheck, lastSavedProjectJsonRef.current);
      const action = resolveRemoteVersionAction(remoteVersion.updatedAt, currentProjectUpdatedAtRef.current, hasLocalChanges);
      if (action === 'current') {
        currentWarehouseVersionRef.current = remoteVersion.warehouseVersion;
        lastObservedWarehouseVersionRef.current = remoteVersion.warehouseVersion;
        setSaveStatus('saved');
        return;
      }
      if (action === 'conflict') {
        // Sem um evento de tabela não há como atribuir a mudança a uma
        // coleção com segurança. Preserve a tela e deixe a próxima entrada na
        // área buscar seu escopo; nunca substitua o projeto inteiro.
        markRemoteCollections(current.id, requiredProjectCollections);
        return;
      }

      setSaveStatus('updating');
      const localJsonAtRequest = serializeProject(currentAfterVersionCheck);
      const record = await loadCloudProjectRecord(current.id, {
        collections: requiredProjectCollections,
        strict: true,
        deferSnapshot: true,
      });
      if (!record) throw new Error('A obra não foi encontrada na nuvem.');
      const latestLocal = rawProjectRef.current;
      if (productionCaptureBusyRef.current || !latestLocal || latestLocal.id !== current.id || activeDataScopeKeyRef.current !== dataScopeAtRequest) {
        discardCloudProjectRecord(record);
        return;
      }
      const localChangedDuringRequest = serializeProject(latestLocal) !== localJsonAtRequest;
      if (hasLocalCollectionConflict(current.id, requiredProjectCollections)) {
        discardCloudProjectRecord(record);
        await handleCloudConflict(latestLocal);
        return;
      }
      confirmCloudProjectRecord(record);
      const merged = mergeHydratedProjectCollections(latestLocal, record.project, requiredProjectCollections);
      let savedMerged = merged;
      if (lastSavedProjectJsonRef.current) {
        try {
          savedMerged = mergeHydratedProjectCollections(
            JSON.parse(lastSavedProjectJsonRef.current) as Project,
            record.project,
            requiredProjectCollections,
          );
        } catch {
          savedMerged = merged;
        }
      }
      lastSavedProjectJsonRef.current = serializeProject(savedMerged);
      currentProjectUpdatedAtRef.current = record.updatedAt;
      currentWarehouseVersionRef.current = record.warehouseVersion;
      lastObservedWarehouseVersionRef.current = record.warehouseVersion;
      setCurrentProjectUpdatedAt(record.updatedAt);
      setLastCloudConfirmedAt(record.updatedAt);
      clearRemoteCollections(current.id, requiredProjectCollections);
      skipNextAutoSaveRef.current = !localChangedDuringRequest;
      rawProjectRef.current = merged;
      setRawProject(merged);
      setSaveStatus(localChangedDuringRequest ? 'saving' : 'saved');
    } catch (error) {
      console.warn('Falha ao conferir a versão da obra na nuvem.', error);
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
    } finally {
      remoteCheckInFlightRef.current = false;
    }
  }, [clearRemoteCollections, handleCloudConflict, hasLocalCollectionConflict, markRemoteCollections, orgId, refreshRemoteCollectionsInBackground, refreshRemoteWarehouseInBackground, requiredProjectCollections]);

  const refreshProjectFromRealtime = useCallback(async (sources: readonly string[] = []) => {
    const current = rawProjectRef.current;
    if (!current || !initialLoadRef.current || remoteCheckInFlightRef.current) return;
    if (conflictDetectedRef.current) {
      setSaveStatus('conflict');
      return;
    }
    if (partialSyncPendingRef.current?.projectId === current.id) {
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
      return;
    }
    if (pendingDailyReportSavesRef.current > 0) {
      if (realtimeRefreshTimerRef.current) window.clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = window.setTimeout(() => void refreshProjectFromRealtime(sources), 600);
      return;
    }
    if (productionCaptureBusyRef.current || saveTimerRef.current || inFlightSaveRef.current) {
      if (realtimeRefreshTimerRef.current) window.clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = window.setTimeout(() => void refreshProjectFromRealtime(sources), 1200);
      return;
    }

    const affectedCollections = normalizeProjectCollections(
      sources.flatMap(source => projectCollectionsForRealtimeTable(source)),
    );
    if (affectedCollections.some(collection => WAREHOUSE_REMOTE_SYNC_COLLECTIONS.includes(collection))) {
      if (await refreshRemoteWarehouseInBackground(current)) return;
    }
    if (await refreshRemoteCollectionsInBackground(current, affectedCollections)) return;
    const metadataOnly = sources.includes('projects') && affectedCollections.length === 0;
    // A verificação de versão sem realtime informa que algo mudou, mas não
    // identifica a tabela. Nesse caso o limite seguro continua sendo apenas a
    // área atualmente aberta — nunca a obra inteira.
    const requestCollections = affectedCollections.length > 0
      ? affectedCollections
      : metadataOnly
        ? []
        : requiredProjectCollections;
    const activeCollections = requestCollections.filter(collection => requiredProjectCollections.includes(collection));
    const inactiveCollections = requestCollections.filter(collection => !requiredProjectCollections.includes(collection));
    if (inactiveCollections.length > 0) markRemoteCollections(current.id, inactiveCollections);
    if ((metadataOnly && localMetadataDirtyRef.current.has(current.id))
      || (requestCollections.length > 0 && hasLocalCollectionConflict(current.id, requestCollections))) {
      markRemoteCollections(current.id, requestCollections);
      await handleCloudConflict(current);
      return;
    }

    // Outra aba recebeu alteração: atualize somente o marcador e a versão
    // otimista. Não faça download, não troque objetos locais e não mexa no UI.
    if (requestCollections.length > 0 && activeCollections.length === 0) {
      const remoteVersion = await getCloudProjectVersion(current.id).catch(() => null);
      if (remoteVersion && rawProjectRef.current?.id === current.id) {
        currentProjectUpdatedAtRef.current = remoteVersion.updatedAt;
        currentWarehouseVersionRef.current = remoteVersion.warehouseVersion;
        lastObservedWarehouseVersionRef.current = remoteVersion.warehouseVersion;
        setCurrentProjectUpdatedAt(remoteVersion.updatedAt);
        setLastCloudConfirmedAt(remoteVersion.updatedAt);
      }
      return;
    }

    remoteCheckInFlightRef.current = true;
    try {
      const latestLocal = rawProjectRef.current;
      if (!latestLocal || latestLocal.id !== current.id) return;
      const localJsonAtRequest = serializeProject(latestLocal);
      const updatedAtAtRequest = currentProjectUpdatedAtRef.current;
      const dataScopeAtRequest = activeDataScopeKeyRef.current;

      const record = await loadCloudProjectRecord(current.id, {
        collections: requestCollections,
        strict: true,
        deferSnapshot: true,
      });
      if (!record) return;
      const localAfterRequest = rawProjectRef.current;
      if (productionCaptureBusyRef.current || !localAfterRequest || localAfterRequest.id !== current.id) {
        discardCloudProjectRecord(record);
        return;
      }
      const localChangedDuringRequest = serializeProject(localAfterRequest) !== localJsonAtRequest
        || currentProjectUpdatedAtRef.current !== updatedAtAtRequest
        || activeDataScopeKeyRef.current !== dataScopeAtRequest;
      if (localChangedDuringRequest && hasLocalCollectionConflict(current.id, requestCollections)) {
        discardCloudProjectRecord(record);
        await handleCloudConflict(localAfterRequest);
        return;
      }
      confirmCloudProjectRecord(record);
      const merged = metadataOnly
        ? mergeProjectMetadata(localAfterRequest, record.project)
        : mergeHydratedProjectCollections(localAfterRequest, record.project, requestCollections);
      let savedMerged = merged;
      if (lastSavedProjectJsonRef.current) {
        try {
          const saved = JSON.parse(lastSavedProjectJsonRef.current) as Project;
          savedMerged = metadataOnly
            ? mergeProjectMetadata(saved, record.project)
            : mergeHydratedProjectCollections(saved, record.project, requestCollections);
        } catch {
          savedMerged = merged;
        }
      }
      lastSavedProjectJsonRef.current = serializeProject(savedMerged);
      currentProjectUpdatedAtRef.current = record.updatedAt;
      currentWarehouseVersionRef.current = record.warehouseVersion;
      lastObservedWarehouseVersionRef.current = record.warehouseVersion;
      setCurrentProjectUpdatedAt(record.updatedAt);
      setLastCloudConfirmedAt(record.updatedAt);
      clearRemoteCollections(current.id, requestCollections);
      setRemoteUpdateAt(new Date().toISOString());
      skipNextAutoSaveRef.current = !localChangedDuringRequest;
      rawProjectRef.current = merged;
      setRawProject(merged);
      setSaveStatus(localChangedDuringRequest ? 'saving' : 'saved');
    } catch (error) {
      console.warn('Falha ao aplicar atualização em tempo real.', error);
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
    } finally {
      remoteCheckInFlightRef.current = false;
    }
  }, [clearRemoteCollections, handleCloudConflict, hasLocalCollectionConflict, markRemoteCollections, refreshRemoteCollectionsInBackground, refreshRemoteWarehouseInBackground, requiredProjectCollections]);

  const refreshDailyReportFromRealtime = useCallback((incoming: DailyReport) => {
    const current = rawProjectRef.current;
    if (!current || !incoming.date) return;
    if (conflictDetectedRef.current) return;
    // Mesmo se a coleção tiver sido carregada para um cálculo auxiliar, uma
    // alteração no Diário não deve remodelar outra tela aberta.
    if (safeCurrentView !== 'dailyReport') {
      markRemoteCollections(current.id, ['dailyReports']);
      return;
    }
    if (pendingDailyReportSavesRef.current > 0 || saveTimerRef.current || inFlightSaveRef.current) {
      pendingRealtimeDailyReportsRef.current.set(`${current.id}:${incoming.date}`, {
        projectId: current.id,
        report: incoming,
      });
      if (realtimeDailyReportTimerRef.current) window.clearTimeout(realtimeDailyReportTimerRef.current);
      realtimeDailyReportTimerRef.current = window.setTimeout(() => {
        realtimeDailyReportTimerRef.current = null;
        const queued = [...pendingRealtimeDailyReportsRef.current.values()];
        pendingRealtimeDailyReportsRef.current.clear();
        queued.forEach(({ projectId, report }) => {
          if (rawProjectRef.current?.id === projectId) {
            refreshDailyReportFromRealtimeRef.current(report);
          }
        });
      }, 1200);
      return;
    }
    // Um evento isolado não representa a coleção completa. Se o Diário ainda
    // não foi carregado nesta sessão, aguarde a hidratação normal da área.
    if (getMissingProjectCollections(current.id, ['dailyReports']).length > 0) {
      markRemoteCollections(current.id, ['dailyReports']);
      return;
    }
    mergeConfirmedDailyReportIntoPartialSync(current.id, incoming.date, incoming);
    const currentReport = reportForDate(current, incoming.date);
    if (currentReport && JSON.stringify(currentReport) === JSON.stringify(incoming)) return;
    const next = replaceReportForDate(current, incoming.date, incoming);
    confirmProjectCollectionsSnapshot(next, ['dailyReports']);
    skipNextAutoSaveRef.current = true;
    rawProjectRef.current = next;
    setRawProject(next);
    lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, incoming.date, incoming);
    setRemoteUpdateAt(new Date().toISOString());
  }, [markRemoteCollections, mergeConfirmedDailyReportIntoPartialSync, safeCurrentView]);

  // A assinatura pertence à obra, enquanto os callbacks acompanham a aba
  // aberta. Referências atualizadas evitam desmontar o canal ao trocar de área.
  checkRemoteProjectVersionRef.current = checkRemoteProjectVersion;
  refreshProjectFromRealtimeRef.current = refreshProjectFromRealtime;
  refreshDailyReportFromRealtimeRef.current = refreshDailyReportFromRealtime;

  useEffect(() => {
    const pendingReports = pendingRealtimeDailyReportsRef.current;
    if (realtimeDailyReportTimerRef.current) window.clearTimeout(realtimeDailyReportTimerRef.current);
    realtimeDailyReportTimerRef.current = null;
    pendingReports.clear();
    return () => {
      if (realtimeDailyReportTimerRef.current) window.clearTimeout(realtimeDailyReportTimerRef.current);
      realtimeDailyReportTimerRef.current = null;
      pendingReports.clear();
    };
  }, [rawProject?.id]);

  useEffect(() => {
    const projectId = rawProject?.id;
    if (!projectId || bootLoading) return;
    const queueRefresh = (payload?: { new?: Record<string, unknown> | null; old?: Record<string, unknown> | null }, source?: string) => {
      if (source === 'daily_reports') {
        const incoming = payload?.new?.data as DailyReport | undefined;
        if (incoming?.date) {
          refreshDailyReportFromRealtimeRef.current(incoming);
          return;
        }
      }
      const rowId = typeof payload?.new?.id === 'string'
        ? payload.new.id
        : typeof payload?.old?.id === 'string'
          ? payload.old.id
          : null;
      if (source && rowId) {
        const key = `${source}:${rowId}`;
        const expiresAt = ownWarehouseRealtimeRowsRef.current.get(key);
        if (expiresAt && expiresAt > Date.now()) {
          ownWarehouseRealtimeRowsRef.current.delete(key);
          return;
        }
        if (expiresAt) ownWarehouseRealtimeRowsRef.current.delete(key);
      }
      // Ignora o eco da própria gravação (mesma versão que já está carregada aqui).
      const remoteUpdatedAt = typeof payload?.new?.updated_at === 'string' ? payload.new.updated_at : null;
      if (remoteUpdatedAt && remoteUpdatedAt === currentProjectUpdatedAtRef.current) return;
      // O eco da própria gravação é descartado pela versão confirmada acima.
      // Uma janela baseada só no relógio poderia esconder a edição de outro
      // usuário feita logo após o nosso salvamento enquanto o canal segue ativo.
      if (source) {
        const affectedCollections = projectCollectionsForRealtimeTable(source);
        // Registra imediatamente a área que chegou pelo realtime. Se o
        // autosave terminar antes do debounce, ele ainda sabe quais coleções
        // remotas pode rebasear sem tocar na edição local de outro módulo.
        if (affectedCollections.length > 0) {
          const pending = pendingRealtimeCollectionsRef.current.get(projectId) ?? new Set<ProjectCollectionKey>();
          affectedCollections.forEach(collection => pending.add(collection));
          pendingRealtimeCollectionsRef.current.set(projectId, pending);
        }
        pendingRealtimeSourcesRef.current.add(source);
      }
      if (realtimeRefreshTimerRef.current) window.clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = window.setTimeout(() => {
        const sources = [...pendingRealtimeSourcesRef.current];
        pendingRealtimeSourcesRef.current.clear();
        void refreshProjectFromRealtimeRef.current(sources);
      }, 1200);
    };
    const channel = supabase.channel(`project-live:${projectId}`);
    channel.on('postgres_changes', {
      event: '*', schema: 'public', table: 'projects', filter: `id=eq.${projectId}`,
    }, payload => queueRefresh(payload, 'projects'));
    PROJECT_REALTIME_TABLES.forEach(table => {
      channel.on('postgres_changes', {
        event: '*', schema: 'public', table, filter: `project_id=eq.${projectId}`,
      }, payload => queueRefresh(payload, table));
    });
    let disposed = false;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;
    const clearReconnect = () => {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    const scheduleReconnect = (immediate = false) => {
      if (disposed || reconnectTimer !== null || realtimeConnectedRef.current) return;
      const delay = immediate ? 0 : [2000, 5000, 15000, 30000][Math.min(reconnectAttempts++, 3)];
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (disposed || realtimeConnectedRef.current) return;
        if (!navigator.onLine || document.visibilityState !== 'visible') return;
        recordSyncDiagnostic({ area: 'realtime', operation: 'reconnect', outcome: 'disconnected', attempt: reconnectAttempts });
        channel.subscribe(handleChannelStatus);
        // Um canal CLOSED pode não responder à primeira tentativa. O polling
        // de versão cobre o intervalo até uma assinatura voltar a confirmar.
        scheduleReconnect();
      }, delay);
    };
    const handleChannelStatus = (status: string) => {
      if (disposed) return;
      const connected = status === 'SUBSCRIBED';
      const wasConnected = realtimeConnectedRef.current;
      realtimeConnectedRef.current = connected;
      setRealtimeConnected(connected);
      if (connected) {
        if (!wasConnected) recordSyncDiagnostic({ area: 'realtime', operation: 'channel', outcome: 'connected' });
        clearReconnect();
        reconnectAttempts = 0;
        void checkRemoteProjectVersionRef.current();
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (wasConnected) recordSyncDiagnostic({ area: 'realtime', operation: 'channel', outcome: 'disconnected' });
        console.warn(`[realtime] Canal da obra ${projectId} indisponível: ${status}`);
        if (status === 'CLOSED') scheduleReconnect();
      }
    };
    channel.subscribe(handleChannelStatus);
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (!realtimeConnectedRef.current) scheduleReconnect(true);
    };
    const handleOnline = () => {
      if (!realtimeConnectedRef.current) scheduleReconnect(true);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      clearReconnect();
      realtimeConnectedRef.current = false;
      setRealtimeConnected(false);
      if (realtimeRefreshTimerRef.current) {
        window.clearTimeout(realtimeRefreshTimerRef.current);
        realtimeRefreshTimerRef.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [bootLoading, rawProject?.id]);

  useEffect(() => {
    if (!rawProject?.id || bootLoading) return;
    let checkTimer: number | null = null;
    const checkNow = () => {
      if (checkTimer !== null) return;
      checkTimer = window.setTimeout(() => {
        checkTimer = null;
        void checkRemoteProjectVersionRef.current();
      }, 200);
    };
    const handleOnline = () => {
      setSaveStatus(conflictDetectedRef.current ? 'conflict' : 'updating');
      const current = rawProjectRef.current;
      if (current && saveRetryAttemptRef.current > 0 && !conflictDetectedRef.current
        && partialSyncPendingRef.current?.projectId !== current.id
        && serializeProject(current) !== lastSavedProjectJsonRef.current) {
        saveRetryAttemptRef.current = 0;
        setSaveRetryTick(value => value + 1);
      }
      checkNow();
    };
    const handleOffline = () => setSaveStatus('offline');
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') checkNow();
    };
    // O tempo real cobre a sessão conectada. Uma única consulta periódica
    // substitui o fallback e o polling permanente enquanto ele está ativo.
    const timer = window.setInterval(() => {
      if (!realtimeConnectedRef.current) checkNow();
    }, REMOTE_VERSION_POLL_MS);
    window.addEventListener('focus', checkNow);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      if (checkTimer !== null) window.clearTimeout(checkTimer);
      window.removeEventListener('focus', checkNow);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [bootLoading, rawProject?.id]);

  const protectLocalDraftBeforePageSleeps = useCallback(() => {
    if (!canPersistProject || !rawProjectRef.current) return;
    // Um conflito mantém no Storage a única cópia conhecida das alterações
    // pendentes; a proteção de saída jamais deve substituí-la nem apagá-la.
    if (conflictDetectedRef.current) return;
    try {
      flushSync(() => {
        flushPendingEditCommits();
      });
    } catch {
      flushPendingEditCommits();
    }
    const current = rawProjectRef.current;
    if (!current) return;
    const hasPendingSave = !!saveTimerRef.current
      || !!inFlightSaveRef.current
      || partialSyncPendingRef.current?.projectId === current.id;
    if (projectHasLocalChanges(current, lastSavedProjectJsonRef.current, hasPendingSave)) {
      cancelScheduledDraft(current.id);
      writeProtectedProjectDraft(current, currentProjectUpdatedAtRef.current);
    } else {
      discardProjectDraft(current.id);
    }
  }, [canPersistProject, cancelScheduledDraft, discardProjectDraft, writeProtectedProjectDraft]);

  useEffect(() => {
    const handlePageMaySleep = () => {
      protectLocalDraftBeforePageSleeps();
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      protectLocalDraftBeforePageSleeps();
      const currentId = rawProjectRef.current?.id;
      const partialSyncPending = !!currentId && partialSyncPendingRef.current?.projectId === currentId;
      if (!saveTimerRef.current
        && !inFlightSaveRef.current
        && !productionCaptureBusyRef.current
        && getPendingFormNames().length === 0
        && !warehouseClientOperationInFlightRef.current
        && !warehouseOperationInFlightRef.current
        && !warehouseScopedOperationInFlightRef.current
        && pendingDailyReportSavesRef.current === 0
        && Object.keys(dailyReportDraftsRef.current).length === 0
        && !partialSyncPending
        && !conflictDetectedRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    // Trocar de guia nao deve acordar o app, salvar pesado ou reprocessar a obra.
    // A protecao abaixo roda apenas quando a pagina realmente vai sair/recarregar.
    window.addEventListener('pagehide', handlePageMaySleep);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('pagehide', handlePageMaySleep);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [protectLocalDraftBeforePageSleeps]);

  const deferredRawProject = useDeferredValue(rawProject);

  // Recálculo condicional: o `settleAllDependencies` (mais caro, varre dependências)
  // só roda quando o usuário está nas abas que dependem dele (Cronograma/Dashboard).
  // Nas demais abas (Tarefas/Medição/Diário) usa-se o pipeline leve, evitando trabalho
  // pesado a cada digitação. CPM continua rodando porque é barato e fornece `isCritical`.
  const needsDependencySettle = safeCurrentView === 'gantt' || safeCurrentView === 'dashboard' || safeCurrentView === 'realCost';

  const project = useMemo(() => {
    if (!deferredRawProject) return null;
    const enriched = applyDailyLogsToProject(
      syncBaselineWithRup(
        applyRupToProject(captureBaseline(deferredRawProject))
      )
    );
    if (needsDependencySettle) {
      const cfg = resolveObraConfig(enriched);
      const cal = { uf: cfg.uf, municipio: cfg.municipio, trabalhaSabado: cfg.trabalhaSabado, jornadaDiaria: cfg.jornadaDiaria, exceptions: cfg.exceptions };
      return calculateCPM(settleAllDependencies(enriched, cal));
    }
    return calculateCPM(enriched);
  }, [deferredRawProject, needsDependencySettle]);
  const idlePreloadProjectId = project?.id;

  useEffect(() => {
    if (bootLoading || !idlePreloadProjectId || !role) return;
    const candidate = NEXT_VIEW_PRELOAD[safeCurrentView];
    if (!canAccessAppView(role, candidate.view)) return;
    return scheduleIdlePreload(candidate.load);
  }, [bootLoading, idlePreloadProjectId, role, safeCurrentView]);

  useEffect(() => {
    let active = true;
    setDailyReportDrafts({});
    setDailyReportSaveErrors({});
    dailyReportDraftsRef.current = {};
    if (rawProject?.id && user?.id) {
      void readDailyReportDrafts(rawProject.id, user.id).then(drafts => {
        if (!active) return;
        const merged = { ...drafts, ...dailyReportDraftsRef.current };
        dailyReportDraftsRef.current = merged;
        setDailyReportDrafts(merged);
      }).catch(() => { if (active) toast.warning('Não foi possível consultar os rascunhos deste aparelho. Mantenha esta aba aberta até confirmar suas edições.'); });
    }
    return () => { active = false; };
  }, [rawProject?.id, user?.id]);

  const saveDailyReportDirectly = useCallback((before: Project, after: Project) => {
    if (!user?.id) return;
    const actorId = user.id;
    const dates = new Set([
      ...(before.dailyReports ?? []).map(report => report.date),
      ...(after.dailyReports ?? []).map(report => report.date),
    ]);
    dates.forEach(date => {
      const previous = reportForDate(before, date);
      const local = reportForDate(after, date);
      if (!local) return;
      const base: DailyReport = previous ?? {
        id: local.id,
        date: local.date,
        teamsPresent: [],
        equipment: [],
        attachments: [],
        createdAt: local.createdAt,
        updatedAt: local.updatedAt,
      };
      if (JSON.stringify(base) === JSON.stringify(local)) return;

      pendingDailyReportSavesRef.current += 1;
      setSaveStatus('saving');
      const expectedLocal = local;
      const recovery: DailyReportDraft = { revision: crypto.randomUUID(), base, local: expectedLocal };
      dailyReportDraftsRef.current = { ...dailyReportDraftsRef.current, [date]: recovery };
      setDailyReportDrafts(dailyReportDraftsRef.current);
      // Start protecting immediately, before waiting for earlier cloud saves.
      let draftProtected = true;
      const protectedDraft = protectDailyReportDraft(after.id, actorId, recovery);
      void protectedDraft.catch(() => undefined);
      const request = dailyReportSaveQueueRef.current.catch(() => undefined).then(async () => {
        await protectedDraft.catch(() => {
          draftProtected = false;
          if (rawProjectRef.current?.id !== after.id) return;
          const message = 'A edição está somente nesta aba até a confirmação da nuvem. Baixe o rascunho antes de fechar se a gravação falhar.';
          setDailyReportSaveErrors(errors => ({ ...errors, [date]: message }));
          toast.warning(message);
        });
        const result = await saveOpenDailyReport(after.id, base, expectedLocal);
        if (result.conflicts.length === 0) await clearDailyReportDraft(after.id, actorId, date, recovery.revision).catch(() => {
          toast.warning('Diário confirmado na nuvem. A limpeza da cópia local ainda precisa ser repetida.');
        });
        if (result.conflicts.length === 0 && rawProjectRef.current?.id === after.id && dailyReportDraftsRef.current[date]?.revision === recovery.revision) {
          const remaining = { ...dailyReportDraftsRef.current };
          delete remaining[date];
          dailyReportDraftsRef.current = remaining;
          setDailyReportDrafts(remaining);
        }
        mergeConfirmedDailyReportIntoPartialSync(after.id, date, result.report);
        if (result.conflicts.length === 0) setDailyReportSaveErrors(errors => {
          const next = { ...errors };
          delete next[date];
          return next;
        });
        lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, date, result.report);
        clearLocalProjectCollections(after.id, ['dailyReports']);
        setRawProject(current => {
          if (!current || current.id !== after.id) return current;
          const currentReport = reportForDate(current, date);
          // Uma edição mais recente já está na fila. Ela será conciliada contra
          // a versão confirmada ao chegar sua vez; não a sobrescreva agora.
          if (!currentReport || JSON.stringify(currentReport) !== JSON.stringify(expectedLocal)) return current;
          const next = replaceReportForDate(current, date, result.report);
          rawProjectRef.current = next;
          return next;
        });
        if (result.conflicts.length > 0) {
          setDailyReportSaveErrors(errors => ({ ...errors, [date]: 'Há campos divergentes. Compare a versão confirmada com o rascunho preservado.' }));
          toast.warning('A legenda ou campo já havia sido alterado em outro aparelho. Foi mantida a primeira edição salva e o rascunho foi preservado.');
        }
      });
      dailyReportSaveQueueRef.current = request;
      void request.catch(async error => {
        if (rawProjectRef.current?.id !== after.id) return;
        console.warn('Falha ao salvar o Diário diretamente.', error);
        const message = error instanceof Error ? error.message : 'Não foi possível salvar o Diário. Nenhuma alteração foi confirmada.';
        setDailyReportSaveErrors(errors => ({ ...errors, [date]: draftProtected ? message : `${message} A cópia está somente nesta aba. Baixe o rascunho antes de fechar.` }));
        setSaveStatus(navigator.onLine ? 'error' : 'offline');
        // Uma falha da gravação do Diário não autoriza apagar os arquivos já
        // recebidos pelo Storage: eles podem ser a única cópia das fotos.
        const confirmed = await loadOpenDailyReport(after.id, date).catch(() => null);
        lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, date, confirmed ?? base);
        setRawProject(current => {
          if (!current || current.id !== after.id) return current;
          const currentReport = reportForDate(current, date);
          if (!currentReport || JSON.stringify(currentReport) !== JSON.stringify(expectedLocal)) return current;
          const next = replaceReportForDate(current, date, confirmed ?? base);
          rawProjectRef.current = next;
          return next;
        });
        toast.error(message);
      }).finally(() => {
        pendingDailyReportSavesRef.current = Math.max(0, pendingDailyReportSavesRef.current - 1);
        if (pendingDailyReportSavesRef.current === 0) {
          setSaveStatus(conflictDetectedRef.current
            ? 'conflict'
            : partialSyncPendingRef.current?.projectId === after.id
              ? 'error'
              : Object.keys(dailyReportDraftsRef.current).length > 0 ? 'error' : 'saved');
        }
      });
    });
  }, [clearLocalProjectCollections, mergeConfirmedDailyReportIntoPartialSync, user?.id]);

  const recoverDailyReport = async (date: string, discard: boolean, discardConfirmed = false) => {
    const current = rawProjectRef.current;
    const draft = dailyReportDraftsRef.current[date];
    if (!current || !draft || !user?.id || dailyReportRecoveryBusy || pendingDailyReportSavesRef.current > 0) return;
    if (discard && !discardConfirmed) {
      confirmDiscardPendingForm({ title: 'Descartar rascunho do Diário?', description: 'Somente a edição local pendente será descartada. O Diário confirmado e seus arquivos permanecem preservados.', confirmLabel: 'Descartar rascunho' }, () => void recoverDailyReport(date, true, true));
      return;
    }
    setDailyReportRecoveryBusy(true);
    try {
      const confirmed = await loadOpenDailyReport(current.id, date);
      if (rawProjectRef.current?.id !== current.id) return;
      if (discard) {
        await clearDailyReportDraft(current.id, user.id, date, draft.revision);
        if (dailyReportDraftsRef.current[date]?.revision === draft.revision) {
          const latest = rawProjectRef.current;
          if (latest?.id === current.id) {
            const next = replaceReportForDate(latest, date, confirmed);
            rawProjectRef.current = next; setRawProject(next);
          }
          const next = { ...dailyReportDraftsRef.current }; delete next[date];
          dailyReportDraftsRef.current = next; setDailyReportDrafts(next);
          setDailyReportSaveErrors(errors => { const next = { ...errors }; delete next[date]; return next; });
        }
      } else {
        const result = await saveOpenDailyReport(current.id, draft.base, draft.local);
        if (rawProjectRef.current?.id !== current.id) return;
        if (result.conflicts.length > 0) {
          const latest = rawProjectRef.current;
          if (latest?.id === current.id) {
            const next = replaceReportForDate(latest, date, result.report);
            rawProjectRef.current = next; setRawProject(next);
          }
          toast.warning('Há campos divergentes. A versão confirmada foi preservada; compare o rascunho antes de descartá-lo.');
          return;
        }
        await clearDailyReportDraft(current.id, user.id, date, draft.revision);
        const latest = rawProjectRef.current;
        if (!latest || latest.id !== current.id) return;
        if (dailyReportDraftsRef.current[date]?.revision !== draft.revision) return;
        const next = replaceReportForDate(latest, date, result.report);
        rawProjectRef.current = next; setRawProject(next);
        lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, date, result.report);
        const remaining = { ...dailyReportDraftsRef.current }; delete remaining[date];
        dailyReportDraftsRef.current = remaining; setDailyReportDrafts(remaining);
        setDailyReportSaveErrors(errors => { const next = { ...errors }; delete next[date]; return next; });
        toast.success('Diário confirmado.');
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível recuperar o Diário.'); }
    finally { setDailyReportRecoveryBusy(false); }
  };

  const makeViewSetter = useCallback((view: AppView) => {
    const renderedBase = project ?? rawProjectRef.current;
    return (next: Project | ((prev: Project) => Project)) => {
      const mayEditView = editor
        || (view === 'dailyReport' && dailyReportEditor)
        || (view === 'warehouse' && warehouseEditor);
      if (!mayEditView) {
        toast.error('Você não tem permissão para editar.');
        return;
      }
      if (view === 'dailyReport' && !navigator.onLine) {
        toast.error('Conecte-se à internet para editar o Diário de Obra.');
        return;
      }
      if (conflictDetectedRef.current && view !== 'dailyReport') {
        toast.error('A sincronização com a nuvem ainda não foi concluída. Recarregue a obra antes de editar.');
        return;
      }
      if (productionCaptureBusyRef.current) { toast.error('Aguarde a confirmação conjunta da planta e do quantitativo.'); return; }
      if (partialSyncPendingRef.current?.projectId === rawProjectRef.current?.id) {
        toast.error('A sincronização detalhada ainda está pendente. Aguarde a confirmação antes de fazer outra alteração.');
        return;
      }
      setRawProject(prev => {
        if (!prev) return prev;
        const candidate = typeof next === 'function' ? (next as (p: Project) => Project)(prev) : next;
        let resolved: Project;
        try {
          resolved = role === 'warehouse_operator' && view === 'warehouse'
            ? { ...prev, warehouse: candidate.warehouse }
            : applyProjectOperation(view, prev, typeof next === 'function' ? prev : (renderedBase ?? prev), candidate);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'A alteração conflita com o estado atual.');
          return prev;
        }
        const synchronized = resolved;
        if (synchronized === prev) return prev;
        // Trava contra laço de atualização: objeto novo com conteúdo idêntico
        // não gera novo estado (evitava o autosave reiniciar para sempre).
        const synchronizedJson = serializeProject(synchronized);
        if (synchronizedJson === serializeProject(prev)) return prev;
        try { assertProductionDeletionSafe(productionDeletionState(prev), productionDeletionState(synchronized), prev); }
        catch (error) { toast.error(error instanceof Error ? error.message : 'Exclusão bloqueada.'); return prev; }
        markLocalProjectChanges(prev, synchronized);
        const stack = undoStacksRef.current[view];
        stack.push(createUndoOperation(prev, synchronized));
        if (stack.length > UNDO_LIMIT) stack.shift();
        rawProjectRef.current = synchronized;
        if (view === 'dailyReport') {
          saveDailyReportDirectly(prev, synchronized);
        } else if (synchronizedJson !== lastSavedProjectJsonRef.current) {
          scheduleProjectDraft(synchronized, currentProjectUpdatedAtRef.current);
        } else {
          discardProjectDraft(synchronized.id);
        }
        setUndoVersion(v => v + 1);
        return synchronized;
      });
    };
  }, [project, dailyReportEditor, discardProjectDraft, editor, markLocalProjectChanges, role, saveDailyReportDirectly, scheduleProjectDraft, warehouseEditor]);

  const ganttSetter = useMemo(() => makeViewSetter('gantt'), [makeViewSetter]);
  const managementSetter = useMemo(() => makeViewSetter('management'), [makeViewSetter]);
  const tasksSetter = useMemo(() => makeViewSetter('tasks'), [makeViewSetter]);
  const measurementSetter = useMemo(() => makeViewSetter('measurement'), [makeViewSetter]);
  const dailyReportSetter = useMemo(() => makeViewSetter('dailyReport'), [makeViewSetter]);
  const additiveSetter = useMemo(() => makeViewSetter('additive'), [makeViewSetter]);
  const additiveScheduleSetter = useMemo(() => makeViewSetter('additiveSchedule'), [makeViewSetter]);
  const realCostSetter = useMemo(() => makeViewSetter('realCost'), [makeViewSetter]);
  const materialsSetter = useMemo(() => makeViewSetter('materials'), [makeViewSetter]);
  const warehouseSetter = useMemo(() => makeViewSetter('warehouse'), [makeViewSetter]);

  const commitProjectNow = useCallback(async (next: Project) => {
    if (!user || !orgId || !canPersistProject) throw new Error('Você não tem permissão para salvar esta obra.');
    if (conflictDetectedRef.current) {
      throw new Error('A sincronização com a nuvem ainda não foi concluída. Recarregue a obra antes de salvar.');
    }
    if (partialSyncPendingRef.current?.projectId === next.id) {
      throw new Error('Confirme primeiro a sincronização detalhada em “Tentar novamente”.');
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (inFlightSaveRef.current) await inFlightSaveRef.current;
    if (conflictDetectedRef.current) {
      throw new Error('A sincronização com a nuvem ainda não foi concluída. Recarregue a obra antes de salvar.');
    }
    if (partialSyncPendingRef.current?.projectId === next.id) {
      throw new Error('Confirme primeiro a sincronização detalhada em “Tentar novamente”.');
    }

    const current = rawProjectRef.current;
    const scopedNext = role === 'warehouse_operator' && current
      ? { ...current, warehouse: next.warehouse }
      : next;
    const synchronized = role === 'warehouse_operator'
      ? scopedNext
      : synchronizeLoadedProjectSchedule(scopedNext);
    writeProtectedProjectDraft(synchronized, currentProjectUpdatedAtRef.current);
    setSaveStatus('saving');
    try {
      await persistProject(synchronized, orgId);
      if (partialSyncPendingRef.current?.projectId === synchronized.id) {
        throw new Error('A sincronização detalhada da obra ainda não foi confirmada. Tente novamente.');
      }
    } catch (error) {
      if (error instanceof CloudProjectConflictError) await handleCloudConflict(synchronized);
      throw error;
    }

    const previous = rawProjectRef.current;
    if (previous) {
      const stack = undoStacksRef.current.warehouse;
      stack.push(createUndoOperation(previous, synchronized));
      if (stack.length > UNDO_LIMIT) stack.shift();
    }
    skipNextAutoSaveRef.current = true;
    rawProjectRef.current = synchronized;
    setRawProject(synchronized);
    setUndoVersion(value => value + 1);
  }, [canPersistProject, handleCloudConflict, orgId, persistProject, role, synchronizeLoadedProjectSchedule, user, writeProtectedProjectDraft]);

  const commitProductionCapture = useCallback(async (candidate: Project, change: ProductionCaptureChange) => {
    if (!editor || !orgId || !user || !navigator.onLine) throw new Error('Conecte-se à internet com um perfil autorizado para salvar a captura.');
    if (conflictDetectedRef.current || partialSyncPendingRef.current) throw new Error('Resolva a sincronização pendente antes de salvar a captura.');
    const renderedBase = change.baseProject ?? project;
    if (!renderedBase) throw new Error('Nenhuma obra está aberta.');
    if (productionCaptureBusyRef.current) throw new Error('Aguarde a captura em andamento.');
    productionCaptureBusyRef.current = true;
    try {
    if (saveTimerRef.current) { window.clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    if (inFlightSaveRef.current) await inFlightSaveRef.current;
    const previous = rawProjectRef.current;
    if (!previous || previous.id !== candidate.id) throw new Error('A obra ativa mudou. Reabra o detalhe.');
    const next = applyProjectOperation('tasks', previous, renderedBase, candidate);
    // Confirm any preceding manual edits first; the capture itself is a single RPC.
    if (serializeProject(previous) !== lastSavedProjectJsonRef.current) await persistProject(previous, orgId);
    if (partialSyncPendingRef.current || conflictDetectedRef.current) throw new Error('A alteração anterior ainda não foi confirmada.');
    const draftKey = scopeKey(orgId, user.id, previous.id);
    const existingDraft = await readCaptureDraft(draftKey);
    if (existingDraft && !change.recovering) throw new Error('Existe uma captura pendente. Recupere-a ou descarte seu rascunho antes de lançar outra.');
    change.captureId ??= crypto.randomUUID();
    await writeCaptureDraft(draftKey, { before: previous, candidate: next, change, savedAt: new Date().toISOString() });
    setSaveStatus('saving');
    try {
      const confirmedAt = await syncProductionAtomically(next, stripNormalizedCollections(next), orgId, currentProjectUpdatedAtRef.current!, change, async args => {
        change.rpcArgs = args;
        await writeCaptureDraft(draftKey, { before: previous, candidate: next, change, savedAt: new Date().toISOString() });
      });
      if (!confirmedAt) throw new Error('A captura não confirmou a transação. Os registros anteriores foram preservados.');
      currentProjectUpdatedAtRef.current = confirmedAt;
      setCurrentProjectUpdatedAt(confirmedAt);
      setLastCloudConfirmedAt(confirmedAt);
      lastSavedProjectJsonRef.current = serializeProject(next);
      skipNextAutoSaveRef.current = true;
      rawProjectRef.current = next; setRawProject(next);
      discardProjectDraft(next.id); setSaveStatus('saved');
      await writeCaptureDraft(draftKey, null).catch(() => toast.message('Captura salva; o aviso de rascunho será reconciliado na próxima abertura.'));
    } catch (error) {
      setSaveStatus('error');
      throw new Error((error as { message?: string }).message || 'A captura falhou; o rascunho foi preservado.');
    }
    } finally { productionCaptureBusyRef.current = false; }
  }, [editor, orgId, user, project, persistProject, discardProjectDraft]);

  const prepareWarehouseCloudOperation = useCallback(async (scope: WarehousePrepareScope) => {
    if (productionCaptureBusyRef.current) throw new Error('Aguarde a captura em andamento antes de salvar outra operação.');
    if (!user || !orgId || !warehouseEditor) throw new Error('Você não tem permissão para salvar o Almoxarifado.');
    if (conflictDetectedRef.current) throw new Error('Atualize a obra antes de salvar o Almoxarifado.');
    const active = rawProjectRef.current;
    if (!active) throw new Error('Nenhuma obra está aberta para registrar a operação.');
    const missingWarehouseData = getMissingProjectCollections(
      active.id,
      WAREHOUSE_OPERATION_COLLECTIONS[scope],
    );
    if (missingWarehouseData.length > 0) {
      throw new Error('Aguarde o carregamento dos dados do Almoxarifado antes de confirmar a operação.');
    }

    // Nunca deixe um autosave geral concorrer com a transação do estoque. Uma
    // alteração anterior é confirmada primeiro; depois disso, somente a RPC
    // específica pode escrever o Almoxarifado.
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      const pending = rawProjectRef.current;
      if (pending) await persistProject(pending, orgId);
    }
    if (inFlightSaveRef.current) await inFlightSaveRef.current;
    if (rawProjectRef.current?.id !== active.id) {
      throw new Error('A obra aberta mudou durante a preparação. Reabra o Almoxarifado e tente novamente.');
    }
    if (conflictDetectedRef.current) throw new Error('Atualize a obra antes de salvar o Almoxarifado.');
    if (partialSyncPendingRef.current?.projectId === active.id) {
      throw new Error('Confirme a sincronização detalhada em “Tentar novamente” antes de operar o Almoxarifado.');
    }

    if (currentWarehouseVersionRef.current == null) {
      const remote = await getCloudProjectVersion(active.id);
      if (rawProjectRef.current?.id !== active.id) {
        throw new Error('A obra aberta mudou durante a preparação. Reabra o Almoxarifado e tente novamente.');
      }
      if (!remote || remote.updatedAt !== currentProjectUpdatedAtRef.current) {
        throw new Error('A versão do Almoxarifado mudou. Atualize a obra antes de continuar.');
      }
      if (remote.warehouseVersion == null) {
        throw new Error('A atualização segura do Almoxarifado ainda não foi instalada no servidor. Nada foi gravado.');
      }
      currentWarehouseVersionRef.current = remote.warehouseVersion;
      lastObservedWarehouseVersionRef.current = remote.warehouseVersion;
    }
  }, [orgId, persistProject, user, warehouseEditor]);

  const prepareWarehouseRequisitionOperation = useCallback(
    () => prepareWarehouseCloudOperation('requisition'),
    [prepareWarehouseCloudOperation],
  );

  const applyWarehouseCloudConfirmation = useCallback(async (confirmation: WarehouseCloudCommitResult) => {
    const active = rawProjectRef.current;
    if (!active || active.id !== confirmation.project.id) {
      throw new Error('A retirada foi confirmada, mas outra obra está aberta. Reabra a obra para conferir o histórico.');
    }

    // A resposta da RPC do Almoxarifado é a confirmação oficial da retirada,
    // movimentos e auditoria. Um espelho legado no Diário jamais pode segurar
    // este ponto nem transformar uma confirmação em aparente falha.
    if (rawProjectRef.current?.id !== confirmation.project.id) {
      setCloudList(previous => previous.map(meta => meta.id === confirmation.project.id
        ? { ...meta, updatedAt: confirmation.projectUpdatedAt }
        : meta));
      throw new Error('A retirada foi salva na nuvem, mas outra obra está aberta. Reabra a obra original para conferi-la.');
    }

    const parseSavedBaseline = () => {
      if (!lastSavedProjectJsonRef.current) return active;
      try { return JSON.parse(lastSavedProjectJsonRef.current) as Project; }
      catch { return active; }
    };
    const savedBaseline = mergeWarehouseCloudCommit(parseSavedBaseline(), confirmation);
    const savedBaselineJson = serializeProject(savedBaseline);
    lastSavedProjectJsonRef.current = savedBaselineJson;

    const expiresAt = Date.now() + 10_000;
    ownWarehouseRealtimeRowsRef.current.set(`warehouse_requisitions:${confirmation.acknowledgement.requisitionId}`, expiresAt);
    confirmation.acknowledgement.movementIds.forEach(id => {
      ownWarehouseRealtimeRowsRef.current.set(`warehouse_movements:${id}`, expiresAt);
    });
    confirmation.acknowledgement.auditLogIds.forEach(id => {
      ownWarehouseRealtimeRowsRef.current.set(`audit_logs:${id}`, expiresAt);
    });
    currentWarehouseVersionRef.current = confirmation.warehouseVersion;
    lastObservedWarehouseVersionRef.current = confirmation.warehouseVersion;
    currentProjectUpdatedAtRef.current = confirmation.projectUpdatedAt;
    setCurrentProjectUpdatedAt(confirmation.projectUpdatedAt);
    setLastCloudConfirmedAt(confirmation.committedAt);
    setCloudList(previous => previous.map(meta => meta.id === confirmation.project.id
      ? { ...meta, updatedAt: confirmation.projectUpdatedAt }
      : meta));

    setRawProject(current => {
      if (!current || current.id !== confirmation.project.id) return current;
      const merged = mergeWarehouseCloudCommit(current, confirmation);
      const fullyConfirmed = serializeProject(merged) === savedBaselineJson;
      if (fullyConfirmed) {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        discardProjectDraft(merged.id);
        skipNextAutoSaveRef.current = true;
        setSaveStatus('saved');
      } else {
        scheduleProjectDraft(merged, confirmation.projectUpdatedAt);
        setSaveStatus('saving');
      }
      rawProjectRef.current = merged;
      return merged;
    });

    // O Diário é uma projeção complementar de registros antigos. Ele é
    // conciliado depois da confirmação, em fila própria, sem repetir a baixa
    // nem travar o modal de retirada/correção se estiver indisponível.
    const dailyChanges = confirmation.dailyReportChanges.filter(change => !!change.before || !!change.after);
    if (dailyChanges.length > 0) {
      const reconcileDailyMirror = async () => {
        for (const change of dailyChanges) {
          const reference = change.after ?? change.before!;
          const emptyReport: DailyReport = {
            id: reference.id,
            date: reference.date,
            teamsPresent: [],
            equipment: [],
            attachments: [],
            createdAt: reference.createdAt,
            updatedAt: reference.updatedAt,
          };
          const beforeReport = change.before ?? emptyReport;
          const afterReport = change.after ?? emptyReport;
          const request = dailyReportSaveQueueRef.current
            .catch(() => undefined)
            .then(() => saveOpenDailyReport(confirmation.project.id, beforeReport, afterReport));
          dailyReportSaveQueueRef.current = request.then(() => undefined);
          try {
            const saved = await request;
            mergeConfirmedDailyReportIntoPartialSync(confirmation.project.id, change.date, saved.report);
            lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, change.date, saved.report);
            clearLocalProjectCollections(confirmation.project.id, ['dailyReports']);
            setRawProject(current => {
              if (!current || current.id !== confirmation.project.id) return current;
              const currentReport = reportForDate(current, change.date);
              // Não sobrescreve uma edição de Diário feita após a retirada.
              if (currentReport && JSON.stringify(currentReport) !== JSON.stringify(afterReport)) return current;
              const next = replaceReportForDate(current, change.date, saved.report);
              rawProjectRef.current = next;
              return next;
            });
          } catch (error) {
            console.warn('Retirada confirmada; falhou apenas a projeção complementar no Diário.', error);
            setDailyReportSaveErrors(errors => ({
              ...errors,
              [change.date]: 'A retirada foi salva. O espelho deste Diário será reconciliado ao abrir a área.',
            }));
            toast.warning('Retirada salva na nuvem. O espelho do Diário será reconciliado separadamente.');
          }
        }
      };
      void reconcileDailyMirror();
    }
  }, [clearLocalProjectCollections, discardProjectDraft, mergeConfirmedDailyReportIntoPartialSync, scheduleProjectDraft]);

  const commitWarehouseRequisitionNow = useCallback((
    before: Project,
    after: Project,
    operation: WarehouseCloudOperation,
  ): Promise<WarehouseCloudCommitResult> => {
    if (navigationInFlightRef.current && !warehouseClientOperationInFlightRef.current) {
      return Promise.reject(new Error('A navegação já foi iniciada. Aguarde a próxima tela abrir antes de registrar a operação.'));
    }
    if (warehouseOperationInFlightRef.current) {
      return Promise.reject(new Error('Aguarde a operação atual do Almoxarifado ser confirmada na nuvem.'));
    }
    const ownsRouteLock = !warehouseLockedRouteRef.current;
    if (ownsRouteLock) warehouseLockedRouteRef.current = currentRouteRef.current;
    const request = (async () => {
      await prepareWarehouseCloudOperation('requisition');
      if (rawProjectRef.current?.id !== before.id) {
        throw new Error('A obra aberta mudou antes da confirmação. Nenhuma nova operação foi iniciada.');
      }
      const confirmation = await commitWarehouseOperation(before, after, operation);
      await applyWarehouseCloudConfirmation(confirmation);
      return confirmation;
    })();
    warehouseOperationInFlightRef.current = request;
    return request.finally(() => {
      if (warehouseOperationInFlightRef.current === request) {
        warehouseOperationInFlightRef.current = null;
      }
      if (ownsRouteLock && !warehouseClientOperationInFlightRef.current && !warehouseScopedOperationInFlightRef.current) {
        warehouseLockedRouteRef.current = null;
      }
    });
  }, [applyWarehouseCloudConfirmation, prepareWarehouseCloudOperation]);

  const runCriticalWarehouseClientOperation = useCallback(<T,>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (navigationInFlightRef.current) {
      return Promise.reject(new Error('A navegação já foi iniciada. Aguarde a próxima tela abrir antes de registrar a operação.'));
    }
    if (warehouseClientOperationInFlightRef.current) {
      return Promise.reject(new Error('Aguarde a operação atual do Almoxarifado ser confirmada na nuvem.'));
    }
    const ownsRouteLock = !warehouseLockedRouteRef.current;
    if (ownsRouteLock) warehouseLockedRouteRef.current = currentRouteRef.current;
    const request = Promise.resolve().then(operation);
    warehouseClientOperationInFlightRef.current = request;
    return request.finally(() => {
      if (warehouseClientOperationInFlightRef.current === request) {
        warehouseClientOperationInFlightRef.current = null;
      }
      if (ownsRouteLock && !warehouseOperationInFlightRef.current && !warehouseScopedOperationInFlightRef.current) {
        warehouseLockedRouteRef.current = null;
      }
    });
  }, []);

  const commitWarehouseScopedNow = useCallback((next: Project, domain: WarehouseScopedDomain): Promise<Project> => {
    if (navigationInFlightRef.current) {
      return Promise.reject(new Error('A navegação já foi iniciada. Aguarde a próxima tela abrir antes de registrar a operação.'));
    }
    if (warehouseScopedOperationInFlightRef.current) {
      return Promise.reject(new Error('Aguarde a operação atual do Almoxarifado ser confirmada na nuvem.'));
    }
    const ownsRouteLock = !warehouseLockedRouteRef.current;
    if (ownsRouteLock) warehouseLockedRouteRef.current = currentRouteRef.current;
    const request = (async () => {
      await prepareWarehouseCloudOperation(domain);

      const before = rawProjectRef.current;
      if (!before || before.id !== next.id) throw new Error('A operação não pertence à obra aberta.');
      if (currentWarehouseVersionRef.current == null) {
        const remote = await getCloudProjectVersion(before.id);
        if (rawProjectRef.current?.id !== before.id) {
          throw new Error('A obra aberta mudou durante a preparação. Reabra o Almoxarifado e tente novamente.');
        }
        if (!remote || remote.updatedAt !== currentProjectUpdatedAtRef.current) {
          throw new Error('A versão do Almoxarifado mudou. Atualize a obra antes de continuar.');
        }
        if (remote.warehouseVersion == null) {
          throw new Error('A atualização segura do Almoxarifado ainda não foi instalada no servidor. Nada foi gravado.');
        }
        currentWarehouseVersionRef.current = remote.warehouseVersion;
        lastObservedWarehouseVersionRef.current = remote.warehouseVersion;
      }

      const scopedNext: Project = {
        ...before,
        warehouse: next.warehouse,
        auditLogs: next.auditLogs,
        stockMovements: next.stockMovements,
        materialPriceHistory: next.materialPriceHistory,
        dailyReports: next.dailyReports,
      };
      setSaveStatus('saving');
      const { commitWarehouseScopedOperation, mergeWarehouseScopedCommit } = await import('@/lib/warehouseScopedCommit');
      let result: WarehouseScopedCommitResult;
      try {
        result = await commitWarehouseScopedOperation(
          before,
          scopedNext,
          currentWarehouseVersionRef.current,
          '',
          domain,
        );
      } catch (error) {
        setSaveStatus(navigator.onLine ? 'error' : 'offline');
        throw error;
      }

      if (rawProjectRef.current?.id !== result.project.id) {
        setCloudList(previous => previous.map(meta => meta.id === result.project.id
          ? { ...meta, updatedAt: result.projectUpdatedAt }
          : meta));
        return result.project;
      }

      const parseSavedBaseline = () => {
        if (!lastSavedProjectJsonRef.current) return before;
        try { return JSON.parse(lastSavedProjectJsonRef.current) as Project; }
        catch { return before; }
      };
      const savedBaseline = mergeWarehouseScopedCommit(parseSavedBaseline(), result);
      const savedBaselineJson = serializeProject(savedBaseline);
      lastSavedProjectJsonRef.current = savedBaselineJson;

      const expiresAt = Date.now() + 10_000;
      result.affectedMovementIds.forEach(id => ownWarehouseRealtimeRowsRef.current.set(`warehouse_movements:${id}`, expiresAt));
      result.affectedCustodyIds.forEach(id => ownWarehouseRealtimeRowsRef.current.set(`warehouse_custody:${id}`, expiresAt));
      result.affectedAuditIds.forEach(id => ownWarehouseRealtimeRowsRef.current.set(`audit_logs:${id}`, expiresAt));
      currentWarehouseVersionRef.current = result.warehouseVersion;
      lastObservedWarehouseVersionRef.current = result.warehouseVersion;
      currentProjectUpdatedAtRef.current = result.projectUpdatedAt;
      setCurrentProjectUpdatedAt(result.projectUpdatedAt);
      setLastCloudConfirmedAt(result.committedAt);
      setCloudList(previous => previous.map(meta => meta.id === result.project.id ? { ...meta, updatedAt: result.projectUpdatedAt } : meta));

      let applied = result.project;
      setRawProject(current => {
        if (!current || current.id !== result.project.id) return current;
        applied = mergeWarehouseScopedCommit(current, result);
        const fullyConfirmed = serializeProject(applied) === savedBaselineJson;
        if (fullyConfirmed) {
          discardProjectDraft(applied.id);
          skipNextAutoSaveRef.current = true;
          setSaveStatus('saved');
        } else {
          scheduleProjectDraft(applied, result.projectUpdatedAt);
          setSaveStatus('saving');
        }
        rawProjectRef.current = applied;
        return applied;
      });
      return applied;
    })();
    warehouseScopedOperationInFlightRef.current = request;
    return request.finally(() => {
      if (warehouseScopedOperationInFlightRef.current === request) {
        warehouseScopedOperationInFlightRef.current = null;
      }
      if (ownsRouteLock && !warehouseClientOperationInFlightRef.current && !warehouseOperationInFlightRef.current) {
        warehouseLockedRouteRef.current = null;
      }
    });
  }, [discardProjectDraft, prepareWarehouseCloudOperation, scheduleProjectDraft]);

  /**
   * A manutenção de anexos é exclusiva do Proprietário e nunca delega ao
   * autosave da obra. Cada referência é confirmada na coleção que a possui.
   */
  const commitAttachmentMigrationNow = useCallback((before: Project, after: Project): Promise<Project> => {
    return runCriticalWarehouseClientOperation(async () => {
      if (role !== 'owner') throw new Error('Somente o Proprietário pode executar a manutenção de anexos antigos.');
      if (!navigator.onLine) throw new Error('Conecte-se à internet para confirmar a manutenção do anexo.');
      const { attachmentMigrationScope } = await import('@/lib/attachmentMigration');
      const scope = attachmentMigrationScope(before, after);

      if (scope.kind === 'custody') return commitWarehouseScopedNow(after, 'custody');
      if (scope.kind === 'warehouse-state') return commitWarehouseScopedNow(after, scope.domain);

      await prepareWarehouseCloudOperation('requisition');
      const active = rawProjectRef.current;
      if (!active || active.id !== before.id) throw new Error('A obra aberta mudou antes da confirmação. O arquivo original foi preservado.');

      if (scope.kind === 'daily-report') {
        const currentReport = reportForDate(active, scope.before.date);
        if (!currentReport || JSON.stringify(currentReport) !== JSON.stringify(scope.before)) {
          throw new Error('O Diário foi alterado em outro aparelho. Atualize antes de reotimizar este anexo.');
        }
        const saved = await saveOpenDailyReport(active.id, scope.before, scope.after);
        if (!saved.report || saved.conflicts.length > 0) {
          throw new Error('O Diário mudou durante a manutenção. A referência anterior foi preservada.');
        }
        const confirmed = replaceReportForDate(active, scope.before.date, saved.report);
        confirmProjectCollectionsSnapshot(confirmed, ['dailyReports']);
        lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, scope.before.date, saved.report);
        skipNextAutoSaveRef.current = true;
        rawProjectRef.current = confirmed;
        setRawProject(current => current?.id === confirmed.id ? confirmed : current);
        setSaveStatus('saved');
        return confirmed;
      }

      const currentRequisition = active.warehouse?.requisitions.find(row => row.id === scope.before.id);
      if (!currentRequisition || JSON.stringify(currentRequisition) !== JSON.stringify(scope.before)) {
        throw new Error('A retirada foi alterada em outro aparelho. Atualize antes de reotimizar este anexo.');
      }
      const { data: remote, error: loadError } = await supabase
        .from('warehouse_requisitions')
        .select('data, updated_at')
        .eq('project_id', active.id)
        .eq('id', scope.before.id)
        .maybeSingle();
      if (loadError) throw new Error(`Não foi possível conferir a retirada: ${loadError.message}`);
      if (!remote || JSON.stringify(remote.data) !== JSON.stringify(scope.before)) {
        throw new Error('A retirada já foi alterada na nuvem. Atualize antes de reotimizar este anexo.');
      }
      const { data: updated, error: updateError } = await supabase
        .from('warehouse_requisitions')
        .update({ data: scope.after as never })
        .eq('project_id', active.id)
        .eq('id', scope.before.id)
        .eq('updated_at', remote.updated_at)
        .select('data')
        .maybeSingle();
      if (updateError) throw new Error(`Não foi possível confirmar o anexo da retirada: ${updateError.message}`);
      if (!updated) throw new Error('A retirada mudou durante a confirmação. Atualize antes de tentar novamente.');

      const confirmedRequisition = updated.data as unknown as WarehouseRequisition;
      const confirmed: Project = {
        ...active,
        warehouse: {
          ...active.warehouse!,
          requisitions: active.warehouse!.requisitions.map(row => row.id === confirmedRequisition.id ? confirmedRequisition : row),
        },
      };
      confirmProjectCollectionsSnapshot(confirmed, ['warehouseRequisitions']);
      ownWarehouseRealtimeRowsRef.current.set(`warehouse_requisitions:${confirmedRequisition.id}`, Date.now() + 10_000);
      skipNextAutoSaveRef.current = true;
      rawProjectRef.current = confirmed;
      setRawProject(current => current?.id === confirmed.id ? confirmed : current);
      setSaveStatus('saved');
      return confirmed;
    });
  }, [commitWarehouseScopedNow, prepareWarehouseCloudOperation, role, runCriticalWarehouseClientOperation]);

  const handleUndo = useCallback((view: AppView) => {
    if (productionCaptureBusyRef.current) { toast.error('Aguarde a captura em andamento antes de desfazer.'); return; }
    if (conflictDetectedRef.current) {
      toast.error('Resolva a divergência entre a cópia local e a nuvem antes de desfazer.');
      return;
    }
    if (partialSyncPendingRef.current?.projectId === rawProjectRef.current?.id) {
      toast.error('A sincronização detalhada ainda está pendente. Confirme-a antes de desfazer.');
      return;
    }
    const stack = undoStacksRef.current[view];
    if (stack.length === 0) { toast.message('Nada para desfazer'); return; }
    const operation = stack[stack.length - 1];
    const current = rawProjectRef.current;
    if (!operation || !current) return;
    // Warehouse reversals must use their specialized audited operations.
    if (view === 'warehouse' || view === 'dailyReport') {
      toast.warning('Use a correção ou o cancelamento específico desta área para preservar o histórico.');
      return;
    }
    try {
      let next = auditUndoProductionDeletions(current, applyUndoOperation(current, operation), auditActor);
      next = auditProjectReversal(current, next, auditActor);
      next = logToProject(next, { ...auditActor, entityType: 'project', entityId: current.id, action: 'updated', title: 'Operação desfeita', metadata: { view, changedFields: operation.changes.map(change => change.path) } });
      assertProductionDeletionSafe(productionDeletionState(current), productionDeletionState(next), current);
      markLocalProjectChanges(current, next);
      writeProtectedProjectDraft(next, currentProjectUpdatedAtRef.current);
      stack.pop(); rawProjectRef.current = next; setRawProject(next);
      setUndoVersion(v => v + 1);
      toast.success('Alteração desfeita');
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível desfazer com segurança.'); }
  }, [writeProtectedProjectDraft, auditActor, markLocalProjectChanges]);

  const canUndo = (view: AppView) => view !== 'warehouse' && view !== 'dailyReport' && undoStacksRef.current[view].length > 0;
  void undoVersion;

  const handleSwitchProject = async (id: string) => {
    try {
      await runProtectedNavigation(async () => {
        const openSequence = ++projectOpenSequenceRef.current;
        await preloadIndexedDbProjectDraft(id);
        if (openSequence !== projectOpenSequenceRef.current) return;
        const nextWarehouseTab = readWarehouseTab(id, canViewWarehousePanel, role === 'owner');
        setWarehouseTab(nextWarehouseTab);
        const record = await loadCloudProjectRecord(id, {
          collections: includePendingDraftCollections(
            id,
            projectCollectionsForView(safeCurrentView, nextWarehouseTab),
          ),
          strict: true,
          deferSnapshot: true,
        });
        if (openSequence !== projectOpenSequenceRef.current) {
          if (record) discardCloudProjectRecord(record);
          return;
        }
        if (record) {
          confirmCloudProjectRecord(record);
          replaceProjectWithoutAutoSave(record.project, record.updatedAt, record.repairApplied, true, record.warehouseVersion);
        }
      });
    } catch {
      toast.error('Erro ao abrir obra');
    }
  };

  const handleCreateProject = async (): Promise<void> => {
    if (!orgId) return;
    if (!creator) { toast.error('Sem permissão para criar obras.'); return; }
    try {
      await runProtectedNavigation(async () => {
        setDraftProjectForImport(createDraftProject());
        setCreateProjectDialogOpen(true);
      });
    } catch {
      toast.error('Erro ao criar obra');
    }
  };

  const handleCreateProjectFromImport = async (projectToCreate: Project) => {
    if (!orgId) throw new Error('Empresa nao identificada para salvar a obra.');
    if (!creator) throw new Error('Sem permissao para criar obras.');
    const finalName = projectToCreate.name.trim();
    if (!finalName) throw new Error('Informe o nome da obra.');
    const exists = cloudList.some(p => p.name.trim().toLowerCase() === finalName.toLowerCase());
    if (exists) throw new Error('Ja existe uma obra com este nome. Informe outro nome.');

    const projectWithName = { ...projectToCreate, name: finalName };
    const updatedAt = await upsertCloudProject(projectWithName, orgId);
    const persisted = await loadCloudProjectRecord(projectWithName.id, {
      strict: true,
      deferSnapshot: true,
    });
    if (!persisted) throw new Error('A obra foi gravada, mas nao pode ser relida para validacao.');
    const expectedTasks = (projectWithName.phases ?? []).reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
    const persistedTasks = (persisted.project.phases ?? []).reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
    const collectionsMatch =
      (persisted.project.budgetItems?.length ?? 0) === (projectWithName.budgetItems?.length ?? 0)
      && (persisted.project.analyticCompositions?.length ?? 0) === (projectWithName.analyticCompositions?.length ?? 0)
      && (persisted.project.phases?.length ?? 0) === (projectWithName.phases?.length ?? 0)
      && persistedTasks === expectedTasks;
    if (!collectionsMatch) {
      discardCloudProjectRecord(persisted);
      await deleteCloudProject(projectWithName.id);
      throw new Error('A estrutura importada nao foi confirmada no banco. A obra incompleta foi removida; tente novamente.');
    }
    const list = await refreshCloudList();
    confirmCloudProjectRecord(persisted);
    replaceProjectWithoutAutoSave(persisted.project, list.find(p => p.id === projectWithName.id)?.updatedAt ?? persisted.updatedAt ?? updatedAt, false, true, persisted.warehouseVersion);
    undoStacksRef.current = { dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], additiveSchedule: [], realCost: [], materials: [], warehouse: [] };
    setUndoVersion(v => v + 1);
    setCurrentView('dashboard');
    setSidebarOpen(false);
    setCreateProjectDialogOpen(false);
    setDraftProjectForImport(null);
    toast.success('Obra criada e planilha importada com sucesso.');
  };

  const handleRenameProject = async (id: string, newName: string) => {
    if (!orgId || !editor) { toast.error('Sem permissão para renomear.'); return; }
    try {
      await runProtectedNavigation(async () => {
        const updated = await renameCloudProject(id, newName, orgId);
        if (updated) {
          if (rawProjectRef.current?.id === id) {
            confirmCloudProjectRecord(updated);
            replaceProjectWithoutAutoSave(updated.project, updated.updatedAt, updated.repairApplied, true, updated.warehouseVersion);
          } else {
            discardCloudProjectRecord(updated);
          }
        }
        const list = await refreshCloudList();
        setUndoVersion(v => v + 1);
      });
    } catch {
      toast.error('Erro ao renomear');
    }
  };

  const handleDuplicateProject = async (id: string) => {
    if (!orgId || !creator) { toast.error('Sem permissão para duplicar.'); return; }
    try {
      await runProtectedNavigation(async () => {
        const copy = await duplicateCloudProject(id, orgId);
        if (copy) {
          await refreshCloudList();
          toast.success(`Obra duplicada: ${copy.name}`);
          setUndoVersion(v => v + 1);
        }
      });
    } catch {
      toast.error('Erro ao duplicar');
    }
  };

  const handleDeleteProject = async (id: string, password: string): Promise<boolean> => {
    if (!remover) { toast.error('Somente o Proprietário pode excluir obras.'); return false; }
    if (cloudList.length <= 1) {
      toast.error('Não é possível excluir a única obra. Crie outra antes.');
      return false;
    }
    try {
      const deleted = await runProtectedNavigation(async () => {
        await deleteCloudProjectAsOwner(id, password);
        const list = await refreshCloudList();
        if (rawProject && id === rawProject.id) {
          const next = list[0];
          if (next) {
            await preloadIndexedDbProjectDraft(next.id);
            const nextWarehouseTab = readWarehouseTab(next.id, canViewWarehousePanel, role === 'owner');
            setWarehouseTab(nextWarehouseTab);
            const record = await loadCloudProjectRecord(next.id, {
              collections: includePendingDraftCollections(
                next.id,
                projectCollectionsForView(safeCurrentView, nextWarehouseTab),
              ),
              strict: true,
              deferSnapshot: true,
            });
            if (record) {
              confirmCloudProjectRecord(record);
              replaceProjectWithoutAutoSave(record.project, record.updatedAt, record.repairApplied, true, record.warehouseVersion);
              undoStacksRef.current = { dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], additiveSchedule: [], realCost: [], materials: [], warehouse: [] };
            }
          }
        }
        toast.success('Obra excluída');
        setUndoVersion(v => v + 1);
        return true;
      });
      return deleted ?? false;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erro ao excluir a obra.');
      return false;
    }
  };

  const handleLogout = async () => {
    await runProtectedNavigation(async () => {
      await signOut();
      navigate('/auth', { replace: true });
    });
  };

  const handleOpenTeam = async () => {
    await runProtectedNavigation(async () => {
      navigate('/team');
    });
  };

  const sidebarProjects: ProjectMeta[] = useMemo(
    () => cloudList.map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt })),
    [cloudList]
  );

  if (authError) return <OpeningError message={authError} onRetry={() => void reloadAuth()} />;
  if (orgError && !membership) return <OpeningError message={orgError} onRetry={() => void reloadOrganization()} onExit={handleLogout} />;

  // Tela de espera enquanto carrega auth/org
  if (authLoading || orgLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Usuário logado mas SEM organização ativa: bloqueia acesso
  if (user && !membership) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center">
            <Building2 className="w-6 h-6 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-semibold">Acesso pendente</h1>
          <p className="text-sm text-muted-foreground">
            {'Sua conta foi criada com sucesso. Aguarde a libera\u00e7\u00e3o de acesso pela administra\u00e7\u00e3o da empresa. '}
            {'Um administrador precisa autorizar seu usu\u00e1rio antes que voc\u00ea possa visualizar as obras.'}
          </p>
          <Button variant="outline" onClick={handleLogout}>Sair</Button>
        </div>
      </div>
    );
  }

  if (bootError) return <OpeningError message={bootError} onRetry={() => setBootRetry(value => value + 1)} onExit={handleLogout} />;

  if (bootLoading || !project || !rawProject) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const productionRoutineNavigation = (active: 'production' | 'routine') => (
    <div className="border-b border-border bg-card px-3 pt-3 sm:px-4 lg:px-5">
      <div className="mx-auto flex max-w-[1800px] gap-1 rounded-lg bg-muted/50 p-1 sm:w-fit sm:mx-0">
        <Button
          type="button"
          variant={active === 'production' ? 'default' : 'ghost'}
          className="min-h-10 flex-1 sm:flex-none"
          onClick={() => {
            setProductionWorkspaceInitialTab('production');
            setCurrentView('tasks');
            navigate(`/obras/${project.id}/producao`);
          }}
        >
          Produção
        </Button>
        <Button
          type="button"
          variant={active === 'routine' ? 'default' : 'ghost'}
          className="min-h-10 flex-1 sm:flex-none"
          onClick={() => {
            setCurrentView('management');
            navigate(`/obras/${project.id}/rotina?semana=${todayISO()}`);
          }}
        >
          Rotina semanal
        </Button>
      </div>
    </div>
  );

  const renderView = () => {
    if (!currentViewDataReady && dataLoadError) {
      return (
        <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
          <p className="font-semibold">Não foi possível carregar esta área.</p>
          <p className="text-sm text-muted-foreground">{dataLoadError}</p>
          <Button type="button" variant="outline" onClick={() => setDataLoadRetry(value => value + 1)}>
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
              initialWeek={new URLSearchParams(location.search).get('semana') || undefined}
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
              takeoffStorageKey={user && orgId ? scopeKey(orgId, user.id, project.id) : undefined}
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
              productionFocusTaskId={new URLSearchParams(location.search).get('atividade') || undefined}
              productionFocusDate={new URLSearchParams(location.search).get('data') || undefined}
            />
          </>
        );
      case 'measurement':
        return <Measurement project={project} onProjectChange={measurementSetter} undoButton={<UndoButton canUndo={canUndo('measurement')} onUndo={() => handleUndo('measurement')} />} onOpenDailyReport={handleOpenDailyReport} />;
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
            onActiveTabChange={(nextTab) => {
              if (warehouseClientOperationInFlightRef.current || warehouseOperationInFlightRef.current || warehouseScopedOperationInFlightRef.current) {
                toast.warning('Aguarde a confirmação da operação do Almoxarifado na nuvem.');
                return;
              }
              setWarehouseTab(nextTab);
            }}
            isTabDataReady={currentViewDataReady}
          />
        );
    }
  };

  return (
    <div className="flex min-h-screen bg-background">
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label={sidebarOpen ? 'Fechar menu' : 'Abrir menu'}
        className="fixed top-4 left-4 z-50 flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-card shadow-md lg:hidden"
      >
        {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {sidebarOpen && (
        <div className="fixed inset-0 bg-foreground/20 z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div className={`fixed lg:sticky lg:top-0 lg:h-svh lg:self-start z-40 transition-transform lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <AppSidebar
          currentView={safeCurrentView === 'management' ? 'tasks' : safeCurrentView}
          onViewChange={(v) => {
            if (role && !canAccessAppView(role, v)) return;
            if (warehouseClientOperationInFlightRef.current || warehouseOperationInFlightRef.current || warehouseScopedOperationInFlightRef.current) {
              toast.warning('Aguarde a confirmação da operação do Almoxarifado na nuvem.');
              return;
            }
            if (v === safeCurrentView) return;
            flushSync(() => { flushPendingEditCommits(); });
            const pendingDraft = pendingDraftRef.current;
            if (pendingDraft && !conflictDetectedRef.current) {
              cancelScheduledDraft(pendingDraft.project.id);
              writeProtectedProjectDraft(pendingDraft.project, pendingDraft.baseUpdatedAt);
            }
            const switchView = () => {
              if (v === 'tasks') setProductionWorkspaceInitialTab('production');
              if (v === 'dailyReport') setProductionWorkspaceInitialTab('dailyReport');
              setCurrentView(v);
              setSidebarOpen(false);
            };
            const forms = getPendingFormNames();
            if (forms.length > 0) {
              confirmDiscardPendingForm({
                title: 'Sair com formulário em preenchimento?',
                description: `Os dados de ${forms.join(', ')} ainda não foram confirmados.`,
                cancelLabel: 'Continuar preenchendo',
                confirmLabel: 'Descartar e sair',
              }, switchView);
              return;
            }
            switchView();
          }}
          projectName={project.name}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(c => !c)}
          onSwitchProject={handleSwitchProject}
          onCreateProject={handleCreateProject}
          onRenameProject={handleRenameProject}
          onDuplicateProject={handleDuplicateProject}
          onDeleteProject={handleDeleteProject}
          onImportedProject={handleSwitchProject}
          activeProjectId={rawProject.id}
          projectsList={sidebarProjects}
          userEmail={user?.email ?? undefined}
          onLogout={handleLogout}
          orgName={membership?.organization.name}
          roleLabel={role ? ROLE_LABELS[role] : undefined}
          canManageTeam={role === 'owner' || role === 'admin'}
          onOpenTeam={() => void handleOpenTeam()}
          allowedViews={allowedViews}
          canManageProjects={role !== 'warehouse_operator'}
          canDeleteProjects={remover}
        />
      </div>

      <main ref={mainScrollRef} className="relative min-h-screen min-w-0 flex-1 overflow-x-clip overflow-y-auto pt-14 lg:pt-0">
        <div className="absolute top-3 right-4 z-20">
          <SaveStatusIndicator status={Object.keys(dailyReportSaveErrors).length && saveStatus !== 'saving' ? 'error' : saveStatus} confirmedAt={lastCloudConfirmedAt} lastCheckedAt={lastRemoteCheckAt} projectId={rawProject.id} live={realtimeConnected} remoteUpdateAt={remoteUpdateAt} pendingRemoteAreas={pendingRemoteAreas} partialSyncPending={partialSyncIssue?.projectId === rawProject.id} partialSyncDraftProtected={partialSyncIssue?.draftProtected} syncRetrying={partialSyncRetrying} />
        </div>
        {partialSyncIssue?.projectId === rawProject.id && (
          <div
            role="alert"
            className={`mx-4 mt-16 flex flex-col gap-3 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between ${partialSyncIssue.draftProtected ? 'border-amber-400/60 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100' : 'border-destructive/50 bg-destructive/10'}`}
          >
            <span>
              {partialSyncIssue.draftProtected
                ? 'Uma parte da obra ainda precisa ser confirmada na nuvem. A cópia local está protegida.'
                : 'Uma parte da obra ainda precisa ser confirmada e não foi possível criar a cópia local. Não feche nem recarregue esta página.'}
            </span>
            <Button
              type="button"
              size="sm"
              variant={partialSyncIssue.draftProtected ? 'outline' : 'destructive'}
              disabled={partialSyncRetrying}
              onClick={() => void retryPendingPartialSync()}
            >
              {partialSyncRetrying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Tentar novamente
            </Button>
          </div>
        )}
        {currentViewDataReady && staleCurrentViewCollections.length > 0 && dataLoadError && (
          <div role="alert" className="mx-4 mt-16 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <span>Há dados novos nesta área que ainda não puderam ser carregados. A tela e os campos em edição foram preservados.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => setDataLoadRetry(value => value + 1)}>Tentar novamente</Button>
          </div>
        )}
        <Suspense fallback={
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        }>
          {Object.entries(dailyReportDrafts).map(([date, draft]) => (
            <DailyReportDraftRecovery key={date} draft={draft} confirmed={reportForDate(rawProject, date)} message={dailyReportSaveErrors[date]} busy={dailyReportRecoveryBusy || saveStatus === 'saving'} onRetry={() => void recoverDailyReport(date, false)} onDiscard={() => void recoverDailyReport(date, true)} />
          ))}
          {renderView()}
        </Suspense>
      </main>

      {draftProjectForImport && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" role="status" aria-live="polite">
            <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm font-medium shadow-lg">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              Carregando importador de planilha…
            </div>
          </div>
        }>
          <ImportSyntheticDialog
            open={createProjectDialogOpen}
            onClose={() => {
              setCreateProjectDialogOpen(false);
              setDraftProjectForImport(null);
            }}
            project={draftProjectForImport}
            onProjectChange={() => undefined}
            mode="create"
            existingProjectNames={sidebarProjects.map(p => p.name)}
            onCreateProject={handleCreateProjectFromImport}
          />
        </Suspense>
      )}

      {orgId && <MigrationDialog organizationId={orgId} onMigrated={async () => { await refreshCloudList(); }} />}

      {draftConflictProjectId === rawProject.id && diaryConflictDismissed && (
        <div role="alert" className="fixed bottom-4 left-4 right-4 z-40 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/50 bg-background p-3 text-sm shadow-lg sm:right-auto sm:max-w-xl">
          <span>Há uma cópia local pendente. O Diário pode ser salvo separadamente; os demais dados ainda exigem reconciliação.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setDiaryConflictDismissed(false)}>Ver cópia pendente</Button>
        </div>
      )}
      {draftConflictProjectId === rawProject.id && !diaryConflictDismissed && (
        <Suspense fallback={null}>
          <CloudDraftConflictDialog
            open
            resolving={draftConflictResolving}
            onDownload={downloadConflictingDraft}
            onDiscard={discardConflictingDraft}
            onContinueDailyReport={dailyReportEditor ? () => {
              setCurrentView('dailyReport');
              setDiaryConflictDismissed(true);
            } : undefined}
          />
        </Suspense>
      )}

      {pendingFormDialog}

    </div>
  );
}
