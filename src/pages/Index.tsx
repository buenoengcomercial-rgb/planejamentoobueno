import { readCaptureDraft, writeCaptureDraft } from '@/lib/productionCaptureDraft';
import { preserveProjectFieldConflict, projectOperationFingerprint } from '@/lib/projectFieldCommit';
import { mergeConcurrentFields } from '@/lib/concurrentFields';
import ProjectOperationConflicts from '@/components/ProjectOperationConflicts';
import WarehouseOperationRecovery from '@/components/WarehouseOperationRecovery';
import { useWarehouseOperationCoordinator } from '@/domains/warehouse/useWarehouseOperationCoordinator';
import { createProjectViewSetter } from '@/domains/project/projectViewEditCommands';
import type { ProductionCaptureChange } from '@/lib/planTakeoff';
import { syncProductionAtomically, stripNormalizedCollections } from '@/lib/projectSync';
import { applyProjectOperation } from '@/lib/projectOperations';
import { scopeKey } from '@/lib/planTakeoff';
import { OpeningError } from '@/components/OpeningError';
import { useState, useMemo, useEffect, useDeferredValue, useCallback, useRef, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { AppView, DailyReport, Project, WarehouseRequisition } from '@/types/project';
import AppSidebar from '@/components/AppSidebar';
import ProjectAreaContent from '@/domains/navigation/ProjectAreaContent';
import { useProjectUiSession } from '@/domains/navigation/useProjectUiSession';
import { useProjectRouteCoordinator } from '@/domains/navigation/useProjectRouteCoordinator';
import { flushPendingProjectSave, navigateToProjectView, runProtectedProjectNavigation } from '@/domains/navigation/projectNavigationGuard';
import type { SaveStatus } from '@/components/SaveStatusIndicator';
import { subscribeProjectRemoteSignals } from '@/domains/sync/projectRemoteSignals';
import { checkProjectRemoteVersion } from '@/domains/sync/projectRemoteVersionCheck';
import { subscribeProjectVersionMonitor } from '@/domains/sync/projectVersionMonitor';
import { useProjectAutoSave } from '@/domains/sync/useProjectAutoSave';
import { useProjectCollectionTracker } from '@/domains/sync/useProjectCollectionTracker';
import { useProtectedProjectDrafts } from '@/domains/sync/useProtectedProjectDrafts';
import { confirmAreaHydration, hydrateAreaCollections, planAreaHydration } from '@/domains/sync/areaHydration';
import { includePendingDraftCollections, loadInitialProject } from '@/domains/sync/projectBootstrap';
import { useProjectRealtimeRefresh } from '@/domains/sync/useProjectRealtimeRefresh';
import { projectSaveAttempt } from '@/domains/sync/projectSaveAttempt';
import { createProjectLifecycleHandlers } from '@/domains/sync/projectLifecycle';
import { refreshRemoteProjectCollections, refreshRemoteWarehouseCollections, type RemoteCollectionRefreshContext } from '@/domains/sync/remoteCollectionRefresh';
import ProjectHeaderSyncStatus from '@/domains/sync/ProjectHeaderSyncStatus';
import { useDailyReportRealtime } from '@/domains/dailyReport/useDailyReportRealtime';
import { reportForDate, replaceReportForDate, replaceSavedDailyReport } from '@/domains/dailyReport/dailyReportProject';
import { saveDailyReportEdits, recoverDailyReportDraft, useDailyReportDraftLoading, type DailyReportSaveContext } from '@/domains/dailyReport/dailyReportSaveController';
import MigrationDialog from '@/components/MigrationDialog';
import { Menu, X, Loader2, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCalculatedProject } from '@/domains/schedule/useCalculatedProject';
import { flushPendingEditCommits } from '@/lib/pendingEditCommits';
import { getPendingFormNames } from '@/lib/pendingFormNavigation';
import { cloudRetryDelay, isTransientCloudError } from '@/lib/cloudRetry';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { scheduleIdlePreload } from '@/lib/idlePreload';
import { canUndoProjectChange, emptyUndoStacks, recordProjectUndo, undoProjectChange, type UndoStacks } from '@/domains/project/projectUndoController';
import { assertProductionDeletionSafe, productionDeletionState } from '@/lib/productionDeletionSafety';
import type { DailyReportDraft } from '@/lib/dailyReportDrafts';
import DailyReportDraftRecovery from '@/components/DailyReportDraftRecovery';
import { getMeasurementWorkStartDate, synchronizeProjectScheduleToWorkStart } from '@/lib/workStartDate';
import { repairProjectAnalyticLinks } from '@/lib/analyticLinks';
import { userInfoFromSupabaseUser } from '@/lib/audit';
import { todayISO } from '@/lib/weeklyRoutine';
import { APP_VIEWS, readAppUiSession, readInitialView } from '@/lib/appUiSession';

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

const ImportSyntheticDialog = lazyWithReload(() => import('@/components/ImportSyntheticDialog'));
const CloudDraftConflictDialog = lazyWithReload(() => import('@/components/CloudDraftConflictDialog'));
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { canAccessAppView, canCreateProject, canDeleteProject, canEditDailyReport, canEditProject, canEditWarehouse, getRestrictedFallbackView, ROLE_LABELS } from '@/lib/organizations';
import { Button } from '@/components/ui/button';
import {
  listCloudProjects,
  loadCloudProjectRecord,
  loadStableCloudProjectRecord,
  CloudProjectConflictError,
  CloudProjectMeta,
  confirmCloudProjectRecord,
  discardCloudProjectRecord,
  getCloudProjectVersion,
  type CloudProjectVersion,
} from '@/lib/cloudProjects';
import {
  inspectProjectDraft,
  projectHasLocalChanges,
  readStoredProjectDraft,
  serializeProject,
} from '@/lib/cloudProjectDraftCore';
import type { ProjectMeta } from '@/lib/projectStorage';
import { supabase } from '@/integrations/supabase/client';
import { saveOpenDailyReport } from '@/lib/dailyReportCloudSync';
import {
  type WarehouseCloudCommitResult,
} from '@/lib/warehouseCloudCommit';
import {
  confirmProjectCollectionsSnapshot,
  discardHydratedProjectCollections,
  getLoadedProjectCollections,
  getMissingProjectCollections,
  mergeHydratedProjectCollections,
  mergeProjectRecordsThreeWay,
  mergeProjectMetadata,
  mergeProjectMetadataFields,
  ProjectHydrationError,
  ProjectSnapshotUnavailableError,
} from '@/lib/projectSync';
import {
  PROJECT_COLLECTION_KEYS,
  WAREHOUSE_REMOTE_SYNC_COLLECTIONS,
  WORK_START_COLLECTIONS,
  normalizeProjectCollections,
  projectCollectionsForView,
  type ProjectCollectionKey,
  type WarehouseTab,
} from '@/lib/projectDataScope';

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
  const [independentMeasurementProjectId, setIndependentMeasurementProjectId] = useState<string | null>(null);
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

  const undoStacksRef = useRef<UndoStacks>(emptyUndoStacks());
  const [undoVersion, setUndoVersion] = useState(0);
  const rawProjectRef = useRef<Project | null>(null);
  const productionCaptureBusyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const saveRetryTimerRef = useRef<number | null>(null);
  const saveRetryAttemptRef = useRef(0);
  const saveRetryProjectJsonRef = useRef<string | null>(null);
  const partialSyncRetryAttemptRef = useRef(0);
  const partialSyncRetryableRef = useRef(false);
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
  // Mantém a origem detalhada do evento enquanto o debounce/autosave está em
  // curso. Não é estado de UI: impede que uma área em edição pareça incompleta
  // antes de sabermos se ela precisa de rebase ou de conflito explícito.
  const {
    pendingRemoteAreas, remoteDirtyRevision,
    remoteDirtyCollectionsRef, backgroundRefreshingCollectionsRef, pendingRealtimeCollectionsRef,
    localDirtyCollectionsRef, localMetadataDirtyRef,
    markRemoteCollections: markTrackedRemoteCollections, clearRemoteCollections,
    clearPendingRealtimeCollections, markLocalProjectChanges, clearLocalProjectCollections,
    hasLocalCollectionConflict, resetProjectScopes, notifyRemoteDirtyChange,
  } = useProjectCollectionTracker();
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

  const orgId = membership?.organization.id;
  const role = membership?.role;
  const editor = role ? canEditProject(role) : false;
  const dailyReportEditor = role ? canEditDailyReport(role) : false;
  const warehouseEditor = role ? canEditWarehouse(role) : false;
  const canViewWarehousePanel = role !== 'warehouse_operator' && role !== 'engineer';
  // Warehouse operators commit through warehouse RPCs; the global project
  // autosave cannot authorize or safely reconcile their stock changes.
  const canPersistProject = editor || dailyReportEditor;
  const creator = role ? canCreateProject(role) : false;
  const remover = role ? canDeleteProject(role) : false;
  const restrictedFallbackView: AppView = role ? getRestrictedFallbackView(role) : 'gantt';

  const {
    pendingDraftRef, cancelScheduledDraft, writeProtectedProjectDraft,
    scheduleProjectDraft, discardProjectDraft,
  } = useProtectedProjectDrafts({
    partialSyncPendingRef, conflictDetectedRef, rawProjectRef,
    setPartialSyncIssue, setSaveStatus,
  });

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

  const safeCurrentView: AppView = role && !canAccessAppView(role, currentView) ? restrictedFallbackView : currentView;
  const allowedViews = role ? APP_VIEWS.filter(view => canAccessAppView(role, view)) : undefined;
  const requiredProjectCollections = useMemo(
    () => projectCollectionsForView(safeCurrentView, warehouseTab,
      safeCurrentView === 'measurement' && independentMeasurementProjectId === rawProject?.id),
    [safeCurrentView, warehouseTab, independentMeasurementProjectId, rawProject?.id],
  );
  const requiredProjectCollectionsKey = requiredProjectCollections.join('|');
  activeDataScopeKeyRef.current = requiredProjectCollectionsKey;
  // Um evento de outra área não hidrata a tela atual. A coleção fica marcada
  // até o usuário entrar na área correspondente; então a hidratação normal
  // busca somente aquele domínio e mantém filtros, formulários e scroll.
  void remoteDirtyRevision;
  const areaHydration = planAreaHydration(
    rawProject?.id ?? null,
    requiredProjectCollections,
    rawProject ? remoteDirtyCollectionsRef.current.get(rawProject.id) : undefined,
    rawProject ? backgroundRefreshingCollectionsRef.current.get(rawProject.id) : undefined,
    localDirtyCollectionsRef.current.get(rawProject?.id ?? ''),
  );
  const staleCurrentViewCollections = areaHydration.stale;
  const missingProjectCollections = areaHydration.missing;
  const collectionsToHydrate = areaHydration.collections;
  const currentViewDataReady = areaHydration.ready;

  const markRemoteCollections = useCallback((projectId: string, collections: readonly ProjectCollectionKey[]) => {
    if (normalizeProjectCollections(collections).length === 0) return;
    markTrackedRemoteCollections(projectId, collections);
    setRemoteUpdateAt(new Date().toISOString());
  }, [markTrackedRemoteCollections]);

  const synchronizeLoadedProjectSchedule = useCallback((candidate: Project) => (
    getMissingProjectCollections(candidate.id, WORK_START_COLLECTIONS).length === 0
      ? synchronizeProjectScheduleToWorkStart(candidate)
      : candidate
  ), []);

  useEffect(() => {
    if (!authLoading && !authError && !user) navigate('/auth', { replace: true });
  }, [authLoading, authError, user, navigate]);

  useProjectRouteCoordinator({
    routeView, pathname: location.pathname, search: location.search, navigate,
    role, restrictedFallbackView, currentView, safeCurrentView,
    projectId: rawProject?.id ?? null, warehouseLockedRouteRef,
    setCurrentView, setDailyReportInitialDate, setDailyReportInitialFilter,
    setDailyReportNavKey, setProductionWorkspaceInitialTab,
  });

  useProjectUiSession({
    projectId: rawProject?.id ?? null,
    currentView, setCurrentView, routeView, role, bootLoading, mainScrollRef,
  });

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
      resetProjectScopes(rawProjectRef.current?.id ?? null, projectToLoad?.id ?? null);
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
  }, [discardProjectDraft, resetProjectScopes]);

  const remoteRefreshContext = useMemo<RemoteCollectionRefreshContext>(() => ({
    currentProject: () => rawProjectRef.current,
    isBlocked: () => productionCaptureBusyRef.current || conflictDetectedRef.current,
    savedProjectJson: () => lastSavedProjectJsonRef.current,
    backgroundRefreshing: backgroundRefreshingCollectionsRef.current,
    markRemoteCollections,
    clearRemoteCollections,
    clearPendingRealtimeCollections,
    hasLocalCollectionConflict,
    notifyRemoteDirtyChange,
    apply: ({ record, project: rebasedCurrent, confirmedBaselineJson, hasPendingLocalChanges }) => {
      lastSavedProjectJsonRef.current = confirmedBaselineJson;
      currentProjectUpdatedAtRef.current = record.updatedAt;
      currentWarehouseVersionRef.current = record.warehouseVersion;
      lastObservedWarehouseVersionRef.current = record.warehouseVersion;
      setCurrentProjectUpdatedAt(record.updatedAt);
      setRemoteUpdateAt(new Date().toISOString());
      // A pending local edit must still be saved after an unrelated remote update.
      if (!hasPendingLocalChanges) setLastCloudConfirmedAt(record.updatedAt);
      skipNextAutoSaveRef.current = !hasPendingLocalChanges;
      rawProjectRef.current = rebasedCurrent;
      setRawProject(rebasedCurrent);
    },
  }), [backgroundRefreshingCollectionsRef, clearPendingRealtimeCollections, clearRemoteCollections,
    hasLocalCollectionConflict, markRemoteCollections, notifyRemoteDirtyChange]);

  const refreshRemoteCollectionsInBackground = useCallback((
    projectToRebase: Project,
    collections: readonly ProjectCollectionKey[],
    knownRemoteVersion?: CloudProjectVersion,
  ) => refreshRemoteProjectCollections(
    remoteRefreshContext, projectToRebase, collections, knownRemoteVersion,
  ), [remoteRefreshContext]);

  const refreshRemoteWarehouseInBackground = useCallback((
    projectToRebase: Project,
    knownRemoteVersion?: CloudProjectVersion,
  ) => refreshRemoteWarehouseCollections(
    remoteRefreshContext, projectToRebase, lastObservedWarehouseVersionRef.current, knownRemoteVersion,
  ), [remoteRefreshContext]);
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
      const result = await projectSaveAttempt({
        project: pendingAtRequest?.project ?? projectToPersist,
        organizationId: projectOrgId,
        expectedUpdatedAt: () => currentProjectUpdatedAtRef.current,
        onAccepted: (submitted, accepted, acceptedJson) => {
          const current = rawProjectRef.current;
          if (!current || current.id !== accepted.id) return;
          const mergedMetadata = mergeProjectMetadataFields(submitted, current, accepted);
          const merged = mergedMetadata && mergeProjectRecordsThreeWay(submitted, mergedMetadata, accepted,
            getLoadedProjectCollections(accepted.id).filter(key => !key.startsWith('warehouse')));
          if (merged) {
            rawProjectRef.current = merged;
            if (serializeProject(merged) === acceptedJson) skipNextAutoSaveRef.current = true;
            setRawProject(merged);
          }
        },
        onFieldConflict: async (error, attempted) => {
          const latest = rawProjectRef.current;
          if (!latest || latest.id !== attempted.id) throw error;
          // Preserve the rejected operation and typing that continued during the request.
          preserveProjectFieldConflict(error, latest, attempted);
          const domainCollections: Record<string, ProjectCollectionKey[]> = {
            production: ['eapChapters', 'tasks', 'taskDailyLogs', 'auditLogs'],
            measurement: ['measurements', 'auditLogs'], additive: ['additives', 'budgetItems', 'analyticCompositions', 'materialPriceHistory', 'auditLogs'],
            materials: ['budgetItems', 'materialComparisons', 'analyticCompositions', 'materialPriceHistory', 'auditLogs'],
            costs: ['subcontracts', 'auditLogs'], metadata: [],
          };
          const collections = getLoadedProjectCollections(attempted.id).filter(key => domainCollections[error.request.domain]?.includes(key));
          const record = await loadCloudProjectRecord(attempted.id, { collections, strict: true, deferSnapshot: true });
          if (!record || rawProjectRef.current?.id !== latest.id) throw error;
          const remote = mergeHydratedProjectCollections(mergeProjectMetadata(attempted, record.project), record.project, collections);
          const merged = mergeConcurrentFields(attempted, rawProjectRef.current, remote);
          preserveProjectFieldConflict(error, rawProjectRef.current, attempted);
          confirmCloudProjectRecord(record);
          rawProjectRef.current = merged.value;
          skipNextAutoSaveRef.current = serializeProject(merged.value) === serializeProject(remote);
          setRawProject(merged.value);
          if (skipNextAutoSaveRef.current) clearLocalProjectCollections(remote.id);
          toast.error('Esta operação teve conflito. A primeira confirmação foi mantida e sua tentativa está disponível em “Operações em conflito”.');
          return { project: remote, updatedAt: record.updatedAt };
        },
        onVersionConflict: async attempted => {
          const knownRemoteCollections = [
            ...(pendingRealtimeCollectionsRef.current.get(attempted.id) ?? []),
            ...(remoteDirtyCollectionsRef.current.get(attempted.id) ?? []),
          ];
          return await refreshRemoteWarehouseInBackground(attempted)
            ?? await refreshRemoteCollectionsInBackground(attempted,
              knownRemoteCollections.length ? knownRemoteCollections : getLoadedProjectCollections(attempted.id));
        },
      }).catch(error => {
        if (error instanceof ProjectSnapshotUnavailableError) setDataLoadRetry(value => value + 1);
        throw error;
      });
      const { project: effectiveProject, json: effectiveJson, updatedAt, partialSyncError } = result;
      const partialSync = !!partialSyncError;
      if (partialSyncError) {
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
        partialSyncRetryableRef.current = isTransientCloudError(partialSyncError);
        const pending = partialSyncPendingRef.current;
        if (pending?.projectId === effectiveProject.id) {
          partialSyncPendingRef.current = { ...pending, draftProtected };
        }
        setPartialSyncIssue({ projectId: effectiveProject.id, draftProtected });
        console.warn('[cloudProjects] Sincronização detalhada pendente.', partialSyncError.detail);
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
  }, [clearLocalProjectCollections, discardProjectDraft, pendingRealtimeCollectionsRef, remoteDirtyCollectionsRef, refreshRemoteCollectionsInBackground, refreshRemoteWarehouseInBackground, writeProtectedProjectDraft]);

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

  const flushPendingSave = useCallback(() => flushPendingProjectSave({
    userId: user?.id, orgId, project: rawProject, initialLoadRef, canPersistProject,
    productionCaptureBusyRef, conflictDetectedRef, warehouseClientOperationInFlightRef,
    pendingDailyReportSavesRef, dailyReportSaveQueueRef, warehouseOperationInFlightRef,
    warehouseScopedOperationInFlightRef, saveTimerRef, inFlightSaveRef, partialSyncPendingRef,
    rawProjectRef, persistProject, handleCloudConflict, setSaveStatus,
  }), [user?.id, orgId, rawProject, canPersistProject, persistProject, handleCloudConflict]);

  const runProtectedNavigation = useCallback(<T,>(action: () => Promise<T>): Promise<T | undefined> => (
    runProtectedProjectNavigation(navigationInFlightRef, flushPendingSave, action)
  ), [flushPendingSave]);

  useEffect(() => {
    if (!user || !orgId) return;
    let cancelled = false;
    (async () => {
      setBootLoading(true);
      setBootError(null);
      try {
        const result = await loadInitialProject({
          orgId, creator, role,
          routeProjectId: initialRouteProjectIdRef.current,
          initialView: initialViewRef.current,
          fallbackView: restrictedFallbackView,
          canViewWarehousePanel,
          refreshCloudList,
          isCancelled: () => cancelled,
          onAreaSelected: (view, tab) => {
            setWarehouseTab(tab);
            const routeCode = view === 'tasks' ? Promise.all([loadDailyProductionWorkspace(), loadTaskList()])
              : view === 'dailyReport' ? loadDailyReport() : null;
            void routeCode?.catch(() => undefined);
          },
        });
        if (cancelled) return;
        if (!result) return;
        if (result.kind === 'created') {
          replaceProjectWithoutAutoSave(result.project, result.updatedAt);
        } else {
          confirmCloudProjectRecord(result.record);
          // An existence check alone is not an opened project. Publish the
          // confirmation only after its matching Project record is adopted.
          setIndependentMeasurementProjectId(result.independentMeasurement ? result.record.project.id : null);
          // Opening an area never runs warehouse maintenance or downloads its history.
          replaceProjectWithoutAutoSave(result.record.project, result.record.updatedAt,
            result.record.repairApplied, true, result.record.warehouseVersion);
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
        const hydrated = await hydrateAreaCollections({
          projectId,
          collections: requestCollections,
          source,
          currentProject: () => rawProjectRef.current,
          savedProjectJson: () => lastSavedProjectJsonRef.current,
          isCurrent: () => !productionCaptureBusyRef.current && dataLoadSequenceRef.current === sequence,
        });
        if (!hydrated) return;
        lastSavedProjectJsonRef.current = hydrated.savedProjectJson;
        confirmAreaHydration(hydrated);
        clearRemoteCollections(projectId, requestCollections);
        skipNextAutoSaveRef.current = !hydrated.repaired;
        rawProjectRef.current = hydrated.project;
        setRawProject(hydrated.project);
        if (hydrated.repaired) {
          scheduleProjectDraft(hydrated.project, currentProjectUpdatedAtRef.current);
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

  useProjectAutoSave({
    project: rawProject,
    userId: user?.id ?? null,
    organizationId: orgId,
    canPersist: canPersistProject,
    recoveredDraftRevision: recoveredDraftSaveRevision,
    retryTick: saveRetryTick,
    initialLoadRef,
    pendingDailyReportSavesRef,
    conflictDetectedRef,
    skipNextAutoSaveRef,
    partialSyncPendingRef,
    saveTimerRef,
    saveRetryTimerRef,
    saveRetryAttemptRef,
    saveRetryProjectJsonRef,
    rawProjectRef,
    setSaveStatus,
    setRetryTick: setSaveRetryTick,
    persistProject,
    handleCloudConflict,
  });

  const checkRemoteProjectVersion = useCallback(async () => {
    await checkProjectRemoteVersion({
      organizationId: orgId,
      collections: requiredProjectCollections,
      refs: {
        project: rawProjectRef,
        initialized: initialLoadRef,
        pendingDailyReportSaves: pendingDailyReportSavesRef,
        productionCaptureBusy: productionCaptureBusyRef,
        checkInFlight: remoteCheckInFlightRef,
        conflictDetected: conflictDetectedRef,
        saveTimer: saveTimerRef,
        inFlightSave: inFlightSaveRef,
        partialSync: partialSyncPendingRef,
        activeDataScopeKey: activeDataScopeKeyRef,
        pendingRealtimeCollections: pendingRealtimeCollectionsRef,
        remoteDirtyCollections: remoteDirtyCollectionsRef,
        savedProjectJson: lastSavedProjectJsonRef,
        projectUpdatedAt: currentProjectUpdatedAtRef,
        warehouseVersion: currentWarehouseVersionRef,
        observedWarehouseVersion: lastObservedWarehouseVersionRef,
        skipNextAutoSave: skipNextAutoSaveRef,
      },
      refreshWarehouse: refreshRemoteWarehouseInBackground,
      refreshCollections: refreshRemoteCollectionsInBackground,
      hasLocalCollectionConflict,
      markRemoteCollections,
      clearRemoteCollections,
      setSaveStatus,
      setLastRemoteCheckAt,
      setProjectUpdatedAt: setCurrentProjectUpdatedAt,
      setLastCloudConfirmedAt,
      setProject: setRawProject,
    });
  }, [clearRemoteCollections, hasLocalCollectionConflict, markRemoteCollections, orgId, pendingRealtimeCollectionsRef, remoteDirtyCollectionsRef, refreshRemoteCollectionsInBackground, refreshRemoteWarehouseInBackground, requiredProjectCollections]);

  const refreshProjectFromRealtime = useProjectRealtimeRefresh({
    requiredProjectCollections, rawProjectRef, initialLoadRef, remoteCheckInFlightRef,
    conflictDetectedRef, partialSyncPendingRef, pendingDailyReportSavesRef,
    productionCaptureBusyRef, saveTimerRef, inFlightSaveRef, realtimeRefreshTimerRef,
    localMetadataDirtyRef, currentProjectUpdatedAtRef, currentWarehouseVersionRef,
    lastObservedWarehouseVersionRef, activeDataScopeKeyRef, lastSavedProjectJsonRef,
    skipNextAutoSaveRef, refreshRemoteWarehouseInBackground,
    refreshRemoteCollectionsInBackground, markRemoteCollections, clearRemoteCollections,
    hasLocalCollectionConflict, setCurrentProjectUpdatedAt, setLastCloudConfirmedAt,
    setRemoteUpdateAt, setRawProject, setSaveStatus,
  });
  const refreshDailyReportFromRealtime = useDailyReportRealtime({
    projectId: rawProject?.id,
    activeView: safeCurrentView,
    project: rawProjectRef,
    conflictDetected: conflictDetectedRef,
    pendingSaves: pendingDailyReportSavesRef,
    saveTimer: saveTimerRef,
    inFlightSave: inFlightSaveRef,
    skipNextAutoSave: skipNextAutoSaveRef,
    savedProjectJson: lastSavedProjectJsonRef,
    markRemoteCollections,
    mergeIntoPartialSync: mergeConfirmedDailyReportIntoPartialSync,
    setProject: setRawProject,
    setRemoteUpdateAt,
  });

  // A assinatura pertence à obra, enquanto os callbacks acompanham a aba
  // aberta. Referências atualizadas evitam desmontar o canal ao trocar de área.
  checkRemoteProjectVersionRef.current = checkRemoteProjectVersion;
  refreshProjectFromRealtimeRef.current = refreshProjectFromRealtime;
  refreshDailyReportFromRealtimeRef.current = refreshDailyReportFromRealtime;

  useEffect(() => {
    const projectId = rawProject?.id;
    if (!projectId || bootLoading) return;
    return subscribeProjectRemoteSignals({
      projectId,
      timerRef: realtimeRefreshTimerRef,
      sourcesRef: pendingRealtimeSourcesRef,
      ownRowsRef: ownWarehouseRealtimeRowsRef,
      pendingCollectionsRef: pendingRealtimeCollectionsRef,
      currentUpdatedAt: () => currentProjectUpdatedAtRef.current,
      onDailyReport: report => refreshDailyReportFromRealtimeRef.current(report),
      onRefresh: sources => { void refreshProjectFromRealtimeRef.current(sources); },
      onConnected: () => { void checkRemoteProjectVersionRef.current(); },
      onConnectionChange: connected => {
        realtimeConnectedRef.current = connected;
        setRealtimeConnected(connected);
      },
      isConnected: () => realtimeConnectedRef.current,
    });
  }, [bootLoading, pendingRealtimeCollectionsRef, rawProject?.id]);

  useEffect(() => {
    if (!rawProject?.id || bootLoading) return;
    return subscribeProjectVersionMonitor({
      checkVersion: () => { void checkRemoteProjectVersionRef.current(); },
      isRealtimeConnected: () => realtimeConnectedRef.current,
      onOnline: () => {
        setSaveStatus(conflictDetectedRef.current ? 'conflict' : 'updating');
        const current = rawProjectRef.current;
        if (current && saveRetryAttemptRef.current > 0 && !conflictDetectedRef.current
          && partialSyncPendingRef.current?.projectId !== current.id
          && serializeProject(current) !== lastSavedProjectJsonRef.current) {
          saveRetryAttemptRef.current = 0;
          setSaveRetryTick(value => value + 1);
        }
      },
      onOffline: () => setSaveStatus('offline'),
    });
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

  const project = useCalculatedProject(deferredRawProject, needsDependencySettle);
  const idlePreloadProjectId = project?.id;

  useEffect(() => {
    if (bootLoading || !idlePreloadProjectId || !role) return;
    const candidate = NEXT_VIEW_PRELOAD[safeCurrentView];
    if (!canAccessAppView(role, candidate.view)) return;
    return scheduleIdlePreload(candidate.load);
  }, [bootLoading, idlePreloadProjectId, role, safeCurrentView]);

  useDailyReportDraftLoading(rawProject?.id, user?.id, dailyReportDraftsRef,
    setDailyReportDrafts, setDailyReportSaveErrors);

  const dailyReportSaveContext = useMemo<DailyReportSaveContext>(() => ({
    actorId: user?.id, rawProjectRef, dailyReportDraftsRef, dailyReportSaveQueueRef,
    pendingDailyReportSavesRef, lastSavedProjectJsonRef, currentProjectUpdatedAtRef,
    conflictDetectedRef, partialSyncPendingRef, dailyReportRecoveryBusy,
    setDailyReportRecoveryBusy, setDailyReportDrafts, setDailyReportSaveErrors,
    setSaveStatus, setRawProject, mergeConfirmedDailyReportIntoPartialSync,
    clearLocalProjectCollections, confirmDiscardPendingForm,
  }), [user?.id, dailyReportRecoveryBusy, mergeConfirmedDailyReportIntoPartialSync,
    clearLocalProjectCollections, confirmDiscardPendingForm]);
  const saveDailyReportDirectly = useCallback((before: Project, after: Project) => {
    saveDailyReportEdits(before, after, dailyReportSaveContext);
  }, [dailyReportSaveContext]);
  const recoverDailyReport = (date: string, discard: boolean) =>
    recoverDailyReportDraft(date, discard, dailyReportSaveContext);

  const makeViewSetter = useCallback((view: AppView) => createProjectViewSetter(view, {
    renderedBase: project ?? rawProjectRef.current,
    editor, dailyReportEditor, warehouseEditor, role,
    rawProjectRef, conflictDetectedRef, productionCaptureBusyRef, partialSyncPendingRef,
    lastSavedProjectJsonRef, currentProjectUpdatedAtRef, undoStacksRef,
    setRawProject, setUndoVersion, markLocalProjectChanges, saveDailyReportDirectly,
    scheduleProjectDraft, discardProjectDraft,
  }), [project, dailyReportEditor, discardProjectDraft, editor, markLocalProjectChanges,
    role, saveDailyReportDirectly, scheduleProjectDraft, warehouseEditor]);
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
      recordProjectUndo(undoStacksRef.current, 'warehouse', previous, synchronized);
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
      let accepted = next;
      const confirmedAt = await syncProductionAtomically(next, stripNormalizedCollections(next), orgId, currentProjectUpdatedAtRef.current!, change, async args => {
        change.rpcArgs = args;
        await writeCaptureDraft(draftKey, { before: previous, candidate: next, change, savedAt: new Date().toISOString() });
      }, { actorId: user.id, onConfirmed: value => { accepted = value; } });
      if (!confirmedAt) throw new Error('A captura não confirmou a transação. Os registros anteriores foram preservados.');
      currentProjectUpdatedAtRef.current = confirmedAt;
      setCurrentProjectUpdatedAt(confirmedAt);
      setLastCloudConfirmedAt(confirmedAt);
      lastSavedProjectJsonRef.current = serializeProject(accepted);
      skipNextAutoSaveRef.current = true;
      rawProjectRef.current = accepted; setRawProject(accepted);
      discardProjectDraft(next.id); setSaveStatus('saved');
      await writeCaptureDraft(draftKey, null).catch(() => toast.message('Captura salva; o aviso de rascunho será reconciliado na próxima abertura.'));
    } catch (error) {
      setSaveStatus('error');
      throw new Error((error as { message?: string }).message || 'A captura falhou; o rascunho foi preservado.');
    }
    } finally { productionCaptureBusyRef.current = false; }
  }, [editor, orgId, user, project, persistProject, discardProjectDraft]);

  const {
    prepareWarehouseCloudOperation, prepareWarehouseRequisitionOperation,
    applyWarehouseCloudConfirmation, commitWarehouseRequisitionNow,
    runCriticalWarehouseClientOperation, commitWarehouseScopedNow,
  } = useWarehouseOperationCoordinator({
    project, orgId, userId: user?.id, warehouseEditor, rawProjectRef, productionCaptureBusyRef,
    conflictDetectedRef, saveTimerRef, inFlightSaveRef, partialSyncPendingRef,
    currentWarehouseVersionRef, lastObservedWarehouseVersionRef, currentProjectUpdatedAtRef,
    lastSavedProjectJsonRef, ownWarehouseRealtimeRowsRef, skipNextAutoSaveRef,
    dailyReportSaveQueueRef, navigationInFlightRef, warehouseClientOperationInFlightRef,
    warehouseOperationInFlightRef, warehouseScopedOperationInFlightRef, warehouseLockedRouteRef,
    currentRouteRef, persistProject, refreshRemoteCollectionsInBackground, discardProjectDraft,
    scheduleProjectDraft, mergeConfirmedDailyReportIntoPartialSync, clearLocalProjectCollections,
    setRawProject, setCloudList, setCurrentProjectUpdatedAt, setLastCloudConfirmedAt,
    setSaveStatus, setDailyReportSaveErrors,
  });
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
    undoProjectChange(view, {
      undoStacksRef, rawProjectRef, productionCaptureBusyRef, conflictDetectedRef,
      partialSyncPendingRef, currentProjectUpdatedAtRef, auditActor,
      markLocalProjectChanges, writeProtectedProjectDraft, setRawProject,
      markUndoChanged: () => setUndoVersion(v => v + 1),
    });
  }, [writeProtectedProjectDraft, auditActor, markLocalProjectChanges]);

  const canUndo = (view: AppView) => canUndoProjectChange(undoStacksRef.current, view);
  void undoVersion;

  const {
    switchProject: handleSwitchProject,
    createProject: handleCreateProject,
    createProjectFromImport: handleCreateProjectFromImport,
    renameProject: handleRenameProject,
    duplicateProject: handleDuplicateProject,
    deleteProject: handleDeleteProject,
  } = createProjectLifecycleHandlers({
    orgId, creator, editor, remover, cloudList, activeProjectId: rawProject?.id ?? null,
    getActiveProjectId: () => rawProjectRef.current?.id ?? null,
    safeCurrentView, canViewWarehousePanel, owner: role === 'owner', projectOpenSequenceRef,
    runProtectedNavigation, refreshCloudList, replaceProjectWithoutAutoSave, setWarehouseTab,
    showCreateDialog: draft => { setDraftProjectForImport(draft); setCreateProjectDialogOpen(true); },
    finishImportedProject: () => {
      setCurrentView('dashboard');
      setSidebarOpen(false);
      setCreateProjectDialogOpen(false);
      setDraftProjectForImport(null);
    },
    resetUndo: () => {
      undoStacksRef.current = emptyUndoStacks();
    },
    markUndoChanged: () => setUndoVersion(v => v + 1),
  });
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
          onViewChange={nextView => navigateToProjectView({
            role, currentView: safeCurrentView,
            warehouseClientOperationInFlightRef, warehouseOperationInFlightRef,
            warehouseScopedOperationInFlightRef, pendingDraftRef, conflictDetectedRef,
            cancelScheduledDraft, writeProtectedProjectDraft,
            setProductionWorkspaceInitialTab, setDailyReportInitialFilter,
            setCurrentView, setSidebarOpen, confirmDiscardPendingForm,
          }, nextView)}
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
        {user?.id && orgId && <ProjectOperationConflicts actorId={user.id} projectId={project.id} organizationId={orgId} onRecovered={async (_receipt, operation) => {
          const current = rawProjectRef.current;
          if (!current || current.id !== project.id) throw new Error('Reabra a obra da tentativa.');
          const draft = readStoredProjectDraft(current.id);
          const matchesDraft = !!draft && !!operation.candidateHash && await projectOperationFingerprint(draft.project) === operation.candidateHash;
          const collections = getLoadedProjectCollections(current.id);
          const record = await loadCloudProjectRecord(current.id, { collections, strict: true, deferSnapshot: true });
          if (!record || rawProjectRef.current?.id !== current.id) throw new Error('A versão confirmada ainda não pôde ser carregada.');
          if (matchesDraft) {
            discardProjectDraft(current.id);
            conflictingDraftRef.current = null; conflictDetectedRef.current = false;
            setDraftConflictProjectId(null);
            confirmCloudProjectRecord(record);
            replaceProjectWithoutAutoSave(record.project, record.updatedAt, false, false, record.warehouseVersion);
          } else {
            const baseline = lastSavedProjectJsonRef.current ? JSON.parse(lastSavedProjectJsonRef.current) as Project : current;
            const remote = mergeHydratedProjectCollections(mergeProjectMetadata(baseline, record.project), record.project, collections);
            const merged = mergeConcurrentFields(baseline, rawProjectRef.current, remote);
            if (merged.conflicts.length) { discardCloudProjectRecord(record); throw new Error('A gravação foi confirmada. Há uma edição mais recente nesta tela; preserve-a antes de recarregar.'); }
            confirmCloudProjectRecord(record);
            lastSavedProjectJsonRef.current = serializeProject(remote);
            currentProjectUpdatedAtRef.current = record.updatedAt;
            setCurrentProjectUpdatedAt(record.updatedAt);
            skipNextAutoSaveRef.current = serializeProject(merged.value) === lastSavedProjectJsonRef.current;
            rawProjectRef.current = merged.value; setRawProject(merged.value);
          }
        }} />}
        {user?.id && <WarehouseOperationRecovery actorId={user.id} projectId={project.id} onConfirmed={async () => {
          const current = rawProjectRef.current;
          if (!current || current.id !== project.id) throw new Error('Reabra a obra da tentativa.');
          const version = await getCloudProjectVersion(current.id);
          if (!version || !await refreshRemoteCollectionsInBackground(current, WAREHOUSE_REMOTE_SYNC_COLLECTIONS, version)) {
            throw new Error('A operação foi conferida, mas a atualização da tela ainda está pendente. Tente conferir novamente.');
          }
        }} />}
        <ProjectHeaderSyncStatus
          activeView={currentView}
          independentMeasurement={currentView === 'measurement' && independentMeasurementProjectId === rawProject.id}
          status={saveStatus}
          confirmedAt={lastCloudConfirmedAt}
          lastCheckedAt={lastRemoteCheckAt}
          projectId={rawProject.id}
          live={realtimeConnected}
          remoteUpdateAt={remoteUpdateAt}
          pendingRemoteAreas={pendingRemoteAreas}
          partialSyncPending={partialSyncIssue?.projectId === rawProject.id}
          partialSyncDraftProtected={partialSyncIssue?.draftProtected ?? false}
          syncRetrying={partialSyncRetrying}
          dailyReportHasErrors={Object.keys(dailyReportSaveErrors).length > 0}
        />
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
          <ProjectAreaContent
            project={project}
            safeCurrentView={safeCurrentView}
            currentViewDataReady={currentViewDataReady}
            dataLoadError={dataLoadError}
            onRetryDataLoad={() => setDataLoadRetry(value => value + 1)}
            role={role}
            editor={editor}
            dailyReportEditor={dailyReportEditor}
            warehouseEditor={warehouseEditor}
            auditActor={auditActor}
            orgId={orgId}
            userId={user?.id}
            locationSearch={location.search}
            navigate={navigate}
            onProductionNavigation={() => {
              setProductionWorkspaceInitialTab('production');
              setCurrentView('tasks');
              navigate(`/obras/${project.id}/producao`);
            }}
            onRoutineNavigation={() => {
              setCurrentView('management');
              navigate(`/obras/${project.id}/rotina?semana=${todayISO()}`);
            }}
            productionWorkspaceInitialTab={productionWorkspaceInitialTab}
            dailyReportInitialDate={dailyReportInitialDate}
            dailyReportInitialFilter={dailyReportInitialFilter}
            dailyReportNavKey={dailyReportNavKey}
            independentMeasurementConfirmed={independentMeasurementProjectId === project.id}
            onIndependentReady={setIndependentMeasurementProjectId}
            onOpenDailyReport={handleOpenDailyReport}
            onOpenProductionActivity={handleOpenProductionActivity}
            canUndo={canUndo}
            handleUndo={handleUndo}
            managementSetter={managementSetter}
            ganttSetter={ganttSetter}
            tasksSetter={tasksSetter}
            measurementSetter={measurementSetter}
            dailyReportSetter={dailyReportSetter}
            additiveSetter={additiveSetter}
            additiveScheduleSetter={additiveScheduleSetter}
            realCostSetter={realCostSetter}
            materialsSetter={materialsSetter}
            warehouseSetter={warehouseSetter}
            commitProductionCapture={commitProductionCapture}
            commitProjectNow={commitProjectNow}
            applyWarehouseCloudConfirmation={applyWarehouseCloudConfirmation}
            prepareWarehouseRequisitionOperation={prepareWarehouseRequisitionOperation}
            commitWarehouseRequisitionNow={commitWarehouseRequisitionNow}
            runCriticalWarehouseClientOperation={runCriticalWarehouseClientOperation}
            commitWarehouseScopedNow={commitWarehouseScopedNow}
            commitAttachmentMigrationNow={commitAttachmentMigrationNow}
            warehouseTab={warehouseTab}
            onWarehouseTabChange={nextTab => {
              if (warehouseClientOperationInFlightRef.current || warehouseOperationInFlightRef.current || warehouseScopedOperationInFlightRef.current) {
                toast.warning('Aguarde a confirmação da operação do Almoxarifado na nuvem.');
                return;
              }
              setWarehouseTab(nextTab);
            }}
          />
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
          <span>Há uma cópia local pendente. {currentView === 'measurement' && independentMeasurementProjectId === rawProject.id ? 'A Medição é salva separadamente; o rascunho da obra continua preservado.' : 'O Diário pode ser salvo separadamente; os demais dados ainda exigem reconciliação.'}</span>
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
            onContinueMeasurement={currentView === 'measurement' && independentMeasurementProjectId === rawProject.id ? () => setDiaryConflictDismissed(true) : undefined}
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
