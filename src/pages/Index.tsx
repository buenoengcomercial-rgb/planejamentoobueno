import { useState, useMemo, useEffect, useDeferredValue, useCallback, useRef, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { AppView, DailyReport, Project } from '@/types/project';
import AppSidebar from '@/components/AppSidebar';
import UndoButton from '@/components/UndoButton';
import SaveStatusIndicator, { SaveStatus } from '@/components/SaveStatusIndicator';
import MigrationDialog from '@/components/MigrationDialog';
import { Menu, X, Loader2, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { applyRupToProject, applyDailyLogsToProject, calculateCPM, captureBaseline, syncBaselineWithRup, settleAllDependencies } from '@/lib/calculations';
import { resolveObraConfig } from '@/components/ConfiguracaoObra';
import { flushPendingEditCommits } from '@/lib/pendingEditCommits';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { getMeasurementWorkStartDate, synchronizeProjectScheduleToWorkStart } from '@/lib/workStartDate';
import { logToProject, userInfoFromSupabaseUser } from '@/lib/audit';
import { reconcileFiscalNoteDuplicates } from '@/lib/warehouse';
import { buildOperationalProjectFromPendingAdditives, getPendingAdditiveScheduleControls } from '@/lib/additiveSchedule';
import { mergeOperationalProjectIntoRaw } from '@/lib/operationalProject';

// Lazy load: cada aba só baixa seu bundle quando aberta pela primeira vez.
// Usa lazyWithReload para recuperar automaticamente de chunks obsoletos após deploy.
const Dashboard = lazyWithReload(() => import('@/components/Dashboard'));
const ManagementRoutine = lazyWithReload(() => import('@/components/ManagementRoutine'));
const GanttChart = lazyWithReload(() => import('@/components/GanttChart'));
const Measurement = lazyWithReload(() => import('@/components/Measurement'));
const DailyProductionWorkspace = lazyWithReload(() => import('@/components/DailyProductionWorkspace'));
const Additive = lazyWithReload(() => import('@/components/Additive'));
const AdditiveSchedule = lazyWithReload(() => import('@/components/AdditiveSchedule'));
const RealCost = lazyWithReload(() => import('@/components/RealCost'));
const Materials = lazyWithReload(() => import('@/components/Materials'));
const WarehouseView = lazyWithReload(() => import('@/components/warehouse/Warehouse'));
const ImportSyntheticDialog = lazyWithReload(() => import('@/components/ImportSyntheticDialog'));
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
  getCloudProjectVersion,
} from '@/lib/cloudProjects';
import {
  clearProjectDraft,
  inspectProjectDraft,
  projectHasLocalChanges,
  resolveRemoteVersionAction,
  serializeProject,
  writeProjectDraft,
} from '@/lib/cloudProjectDrafts';
import type { ProjectMeta } from '@/lib/projectStorage';
import { supabase } from '@/integrations/supabase/client';
import { loadOpenDailyReport, saveOpenDailyReport } from '@/lib/dailyReportCloudSync';

const UNDO_LIMIT = 20;
const SAVE_DEBOUNCE_MS = 4000;
const LOCAL_DRAFT_DEBOUNCE_MS = 900;
const REMOTE_VERSION_POLL_MS = 15000;
const REALTIME_FALLBACK_POLL_MS = 15000;
const UI_SESSION_VERSION = 1;
const APP_UI_SESSION_KEY = 'obraplanner:ui-session';
const APP_VIEWS: AppView[] = ['dashboard', 'management', 'gantt', 'tasks', 'measurement', 'dailyReport', 'additive', 'additiveSchedule', 'realCost', 'materials', 'warehouse'];

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

const ROUTE_VIEW = Object.fromEntries(Object.entries(VIEW_ROUTE).map(([view, route]) => [route, view])) as Record<string, AppView>;

type UndoStacks = Record<AppView, Project[]>;

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
    const parsed = JSON.parse(raw) as AppUiSession;
    if (parsed.version !== UI_SESSION_VERSION) return null;
    if (parsed.view && !isAppView(parsed.view)) return null;
    return parsed;
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
  const { user, loading: authLoading, signOut } = useAuth();
  const auditActor = useMemo(() => userInfoFromSupabaseUser(user), [user]);
  const { membership, loading: orgLoading } = useOrganization();
  const navigate = useNavigate();
  const location = useLocation();
  const { routeProjectId, routeView } = useParams<{ routeProjectId: string; routeView: string }>();
  const initialRouteProjectIdRef = useRef(routeProjectId);

  const [currentView, setCurrentView] = useState<AppView>(() => readInitialView(routeView));
  const [rawProject, setRawProject] = useState<Project | null>(null);
  const [cloudList, setCloudList] = useState<CloudProjectMeta[]>([]);
  const [bootLoading, setBootLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [currentProjectUpdatedAt, setCurrentProjectUpdatedAt] = useState<string | null>(null);
  const [lastCloudConfirmedAt, setLastCloudConfirmedAt] = useState<string | null>(null);
  const [remoteUpdateAt, setRemoteUpdateAt] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dailyReportInitialDate, setDailyReportInitialDate] = useState<string | undefined>(undefined);
  const [dailyReportInitialFilter, setDailyReportInitialFilter] = useState<string | undefined>(undefined);
  const [dailyReportNavKey, setDailyReportNavKey] = useState(0);
  const [productionWorkspaceInitialTab, setProductionWorkspaceInitialTab] = useState<'production' | 'dailyReport'>('production');
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [draftProjectForImport, setDraftProjectForImport] = useState<Project | null>(null);

  const handleOpenDailyReport = useCallback((dateISO: string, measurementFilter?: string) => {
    setDailyReportInitialDate(dateISO);
    setDailyReportInitialFilter(measurementFilter);
    setDailyReportNavKey(k => k + 1); // força re-aplicação mesmo se valores se repetirem
    setProductionWorkspaceInitialTab('dailyReport');
    setCurrentView('dailyReport');
    setSidebarOpen(false);
    const projectId = rawProjectRef.current?.id;
    if (projectId) navigate(`/obras/${projectId}/diario?data=${dateISO}`);
  }, [navigate]);

  const handleOpenProductionActivity = useCallback((taskId: string, dateISO: string) => {
    setProductionWorkspaceInitialTab('production');
    setCurrentView('tasks');
    setSidebarOpen(false);
    const projectId = rawProjectRef.current?.id;
    if (projectId) navigate(`/obras/${projectId}/producao?atividade=${encodeURIComponent(taskId)}&data=${encodeURIComponent(dateISO)}`);
  }, [navigate]);

  const undoStacksRef = useRef<UndoStacks>({ dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], additiveSchedule: [], realCost: [], materials: [], warehouse: [] });
  const [undoVersion, setUndoVersion] = useState(0);
  const rawProjectRef = useRef<Project | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const draftWriteTimerRef = useRef<number | null>(null);
  const pendingDraftRef = useRef<{ project: Project; baseUpdatedAt: string | null } | null>(null);
  const initialLoadRef = useRef(false);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const dailyReportSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingDailyReportSavesRef = useRef(0);
  const currentProjectUpdatedAtRef = useRef<string | null>(null);
  const saveRequestSeqRef = useRef(0);
  const lastSavedProjectJsonRef = useRef<string | null>(null);
  const skipNextAutoSaveRef = useRef(false);
  const conflictDetectedRef = useRef(false);
  const remoteCheckInFlightRef = useRef(false);
  const realtimeRefreshTimerRef = useRef<number | null>(null);
  const lastLocalSaveAtRef = useRef(0);
  const realtimeConnectedRef = useRef(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const restoredUiSessionRef = useRef<string | null>(null);
  const uiSessionSaverReadyRef = useRef<string | null>(null);

  const orgId = membership?.organization.id;
  const role = membership?.role;
  const editor = role ? canEditProject(role) : false;
  const dailyReportEditor = role ? canEditDailyReport(role) : false;
  const warehouseEditor = role ? canEditWarehouse(role) : false;
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

  const scheduleProjectDraft = useCallback((nextProject: Project, baseUpdatedAt: string | null) => {
    const pending = pendingDraftRef.current;
    if (pending && pending.project.id !== nextProject.id) {
      if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
      writeProjectDraft(pending.project, pending.baseUpdatedAt);
    }
    if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
    pendingDraftRef.current = { project: nextProject, baseUpdatedAt };
    draftWriteTimerRef.current = window.setTimeout(() => {
      const draft = pendingDraftRef.current;
      draftWriteTimerRef.current = null;
      pendingDraftRef.current = null;
      if (draft) writeProjectDraft(draft.project, draft.baseUpdatedAt);
    }, LOCAL_DRAFT_DEBOUNCE_MS);
  }, []);

  const discardProjectDraft = useCallback((projectId: string) => {
    cancelScheduledDraft(projectId);
    clearProjectDraft(projectId);
  }, [cancelScheduledDraft]);

  useEffect(() => () => cancelScheduledDraft(), [cancelScheduledDraft]);
  const safeCurrentView: AppView = role && !canAccessAppView(role, currentView) ? restrictedFallbackView : currentView;
  const allowedViews = role ? APP_VIEWS.filter(view => canAccessAppView(role, view)) : undefined;

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth', { replace: true });
  }, [authLoading, user, navigate]);

  useEffect(() => {
    const requestedView = routeView ? ROUTE_VIEW[routeView] : undefined;
    const routedView = requestedView && role && !canAccessAppView(role, requestedView)
      ? restrictedFallbackView
      : requestedView;
    if (routedView) setCurrentView(previous => previous === routedView ? previous : routedView);
    if (routedView === 'dailyReport') {
      const date = new URLSearchParams(location.search).get('data') || undefined;
      if (date) {
        setDailyReportInitialDate(date);
        setDailyReportNavKey(key => key + 1);
      }
      setProductionWorkspaceInitialTab('dailyReport');
    }
  }, [routeView, location.search, role, restrictedFallbackView]);

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

  useEffect(() => {
    if (bootLoading || !rawProject) return;
    const session = readAppUiSession();
    if (!session || (session.projectId && session.projectId !== rawProject.id)) return;
    const restoreKey = `${rawProject.id}:${session.view ?? 'none'}:${session.updatedAt}`;
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
  }, [bootLoading, currentView, rawProject, role, routeView]);

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
  ) => {
    const projectForState = projectToLoad;
    const draftInspection = projectToLoad && inspectDraft
      ? inspectProjectDraft(projectToLoad, updatedAt)
      : { kind: 'none' as const, reason: 'missing' as const };
    if (projectToLoad && draftInspection.kind !== 'none') {
      discardProjectDraft(projectToLoad.id);
      if (draftInspection.kind !== 'identical') {
        toast.info('Os dados locais desta obra foram descartados; a versão da nuvem foi carregada.');
      }
    }

    skipNextAutoSaveRef.current = !repairApplied;
    conflictDetectedRef.current = false;
    currentProjectUpdatedAtRef.current = updatedAt;
    rawProjectRef.current = projectForState;
    lastSavedProjectJsonRef.current = repairApplied ? null : (projectForState ? serializeProject(projectForState) : null);
    setCurrentProjectUpdatedAt(updatedAt);
    setRawProject(projectForState);
    setLastCloudConfirmedAt(new Date().toISOString());
    if (repairApplied) setSaveStatus('saving');
    else setSaveStatus('saved');
  }, [discardProjectDraft]);

  const persistProject = useCallback(async (
    projectToSave: Project,
    projectOrgId: string,
    options: { retainDraftUntilVerified?: boolean } = {},
  ) => {
    const nextJson = serializeProject(projectToSave);
    if (nextJson === lastSavedProjectJsonRef.current) {
      if (!options.retainDraftUntilVerified) discardProjectDraft(projectToSave.id);
      setLastCloudConfirmedAt(new Date().toISOString());
      setSaveStatus('saved');
      return;
    }

    const seq = ++saveRequestSeqRef.current;
    const request = saveQueueRef.current.catch(() => undefined).then(async () => {
      let updatedAt: string;
      let partialSync = false;
      try {
        updatedAt = await upsertCloudProject(projectToSave, projectOrgId, currentProjectUpdatedAtRef.current ?? undefined);
      } catch (error) {
        if (!(error instanceof CloudProjectPartialSyncError)) throw error;
        updatedAt = error.updatedAt;
        partialSync = true;
        console.warn('[cloudProjects] Sincronização detalhada pendente; cópia de segurança preservada.', error.detail);
        toast.warning('O pacote terceirizado foi salvo na obra. A sincronização detalhada com a nuvem está pendente e será tentada novamente no próximo salvamento.');
      }
      conflictDetectedRef.current = false;
      lastLocalSaveAtRef.current = Date.now();
      currentProjectUpdatedAtRef.current = updatedAt;
      lastSavedProjectJsonRef.current = nextJson;
      setCurrentProjectUpdatedAt(updatedAt);
      setLastCloudConfirmedAt(new Date().toISOString());
      if (seq === saveRequestSeqRef.current && !saveTimerRef.current && !partialSync) {
        if (!options.retainDraftUntilVerified) discardProjectDraft(projectToSave.id);
        setSaveStatus('saved');
      } else if (partialSync) {
        setSaveStatus('error');
      }
      setCloudList(prev => {
        const idx = prev.findIndex(p => p.id === projectToSave.id);
        const meta: CloudProjectMeta = {
          id: projectToSave.id,
          name: projectToSave.name,
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
  }, [discardProjectDraft]);

  const handleCloudConflict = useCallback(async (localProject: Project) => {
    conflictDetectedRef.current = true;
    setSaveStatus('saving');
    try {
      const record = await loadCloudProjectRecord(localProject.id);
      if (record) {
        replaceProjectWithoutAutoSave(record.project, record.updatedAt, record.repairApplied, false);
        discardProjectDraft(record.project.id);
        conflictDetectedRef.current = false;
        toast.warning('A obra foi atualizada em outro aparelho. Os dados da nuvem foram carregados e a cópia local foi descartada.');
        return;
      }
    } catch (error) {
      console.warn('Não foi possível carregar a versão concorrente da obra.', error);
    }
    setSaveStatus(navigator.onLine ? 'error' : 'offline');
    toast.error('Não foi possível carregar a versão da nuvem. Nenhuma cópia local será enviada por cima dela.');
  }, [discardProjectDraft, replaceProjectWithoutAutoSave]);

  useEffect(() => {
    rawProjectRef.current = rawProject;
  }, [rawProject]);

  const measurementWorkStart = rawProject ? getMeasurementWorkStartDate(rawProject) : undefined;
  const appliedWorkStart = rawProject?.uiState?.ganttWorkStartDateApplied;
  useEffect(() => {
    if (!editor || !measurementWorkStart) return;
    setRawProject(previous => {
      if (!previous) return previous;
      const synchronized = synchronizeProjectScheduleToWorkStart(previous);
      if (synchronized === previous) return previous;
      skipNextAutoSaveRef.current = false;
      rawProjectRef.current = synchronized;
      if (projectHasLocalChanges(synchronized, lastSavedProjectJsonRef.current)) {
        scheduleProjectDraft(synchronized, currentProjectUpdatedAtRef.current);
      }
      setSaveStatus('saving');
      return synchronized;
    });
  }, [appliedWorkStart, editor, measurementWorkStart, rawProject?.id, scheduleProjectDraft]);

  const flushPendingSave = useCallback(async () => {
    if (!user || !orgId || !rawProject || !initialLoadRef.current || !canPersistProject) return true;

    if (pendingDailyReportSavesRef.current > 0) {
      try {
        await dailyReportSaveQueueRef.current;
      } catch {
        return false;
      }
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      setSaveStatus('saving');
      try {
        await persistProject(rawProject, orgId);
        return true;
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
        return true;
      } catch (e) {
        if (e instanceof CloudProjectConflictError && rawProjectRef.current) {
          await handleCloudConflict(rawProjectRef.current);
        }
        return false;
      }
    }

    return true;
  }, [user, orgId, rawProject, canPersistProject, persistProject, handleCloudConflict]);

  useEffect(() => {
    if (!user || !orgId) return;
    let cancelled = false;
    (async () => {
      setBootLoading(true);
      try {
        let list = await refreshCloudList();
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
          const record = await loadCloudProjectRecord(preferredProjectId);
          if (cancelled) return;
          if (record) {
            let projectToLoad = record.project;
            let updatedAt = record.updatedAt;
            if (role === 'owner') {
              const reconciliation = reconcileFiscalNoteDuplicates(record.project, auditActor);
              if (!reconciliation.alreadyReconciled) {
                updatedAt = await upsertCloudProject(reconciliation.project, orgId, record.updatedAt);
                projectToLoad = reconciliation.project;
                if (reconciliation.canceledNoteIds.length) {
                  toast.warning(`${reconciliation.canceledNoteIds.length} entrada(s) fiscal(is) duplicada(s) foram canceladas automaticamente.`);
                }
                if (reconciliation.pendingNoteIds.length) {
                  toast.warning(`${reconciliation.pendingNoteIds.length} duplicidade(s) possuem consumo posterior e exigem ajuste/conferência.`);
                }
              }
            }
            replaceProjectWithoutAutoSave(projectToLoad, updatedAt, record.repairApplied);
          }
        } else {
          replaceProjectWithoutAutoSave(null);
        }
        initialLoadRef.current = true;
      } catch (e) {
        console.warn(e);
        toast.error('Erro ao carregar obras da empresa');
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, orgId, creator, refreshCloudList, replaceProjectWithoutAutoSave, role, auditActor]);

  // Salvamento debounced (somente se o usuário pode editar)
  useEffect(() => {
    if (!user || !orgId || !rawProject || !initialLoadRef.current) return;
    if (!canPersistProject) return;
    // O Diário tem fila própria em daily_reports. Não permita que o autosave
    // global regrave a obra enquanto uma edição direta está sendo conciliada.
    if (pendingDailyReportSavesRef.current > 0) return;
    if (conflictDetectedRef.current) return;
    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      setSaveStatus('saved');
      return;
    }
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    setSaveStatus('saving');
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        saveTimerRef.current = null;
        await persistProject(rawProject, orgId);
      } catch (e) {
        console.warn(e);
        if (e instanceof CloudProjectConflictError) {
          await handleCloudConflict(rawProject);
        } else {
          setSaveStatus(navigator.onLine ? 'error' : 'offline');
          toast.error('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
        }
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [rawProject, user, orgId, canPersistProject, persistProject, handleCloudConflict]);

  const checkRemoteProjectVersion = useCallback(async () => {
    const current = rawProjectRef.current;
    if (!current || !initialLoadRef.current || document.visibilityState !== 'visible') return;
    if (pendingDailyReportSavesRef.current > 0) return;
    if (!navigator.onLine) {
      setSaveStatus('offline');
      return;
    }
    if (remoteCheckInFlightRef.current || conflictDetectedRef.current || saveTimerRef.current || inFlightSaveRef.current) return;

    remoteCheckInFlightRef.current = true;
    try {
      const remoteVersion = await getCloudProjectVersion(current.id);
      if (!remoteVersion) return;
      setLastCloudConfirmedAt(new Date().toISOString());
      const hasLocalChanges = projectHasLocalChanges(current, lastSavedProjectJsonRef.current);
      const action = resolveRemoteVersionAction(remoteVersion.updatedAt, currentProjectUpdatedAtRef.current, hasLocalChanges);
      if (action === 'current') {
        setSaveStatus('saved');
        return;
      }
      if (action === 'conflict') {
        await handleCloudConflict(current);
        return;
      }

      setSaveStatus('updating');
      const record = await loadCloudProjectRecord(current.id);
      if (!record) throw new Error('A obra não foi encontrada na nuvem.');
      const latestLocal = rawProjectRef.current;
      if (!latestLocal || latestLocal.id !== current.id) return;
      if (projectHasLocalChanges(latestLocal, lastSavedProjectJsonRef.current, !!saveTimerRef.current || !!inFlightSaveRef.current)) {
        await handleCloudConflict(latestLocal);
        return;
      }
      replaceProjectWithoutAutoSave(record.project, record.updatedAt, record.repairApplied, false);
      toast.info('Dados atualizados a partir de outro aparelho.');
    } catch (error) {
      console.warn('Falha ao conferir a versão da obra na nuvem.', error);
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
    } finally {
      remoteCheckInFlightRef.current = false;
    }
  }, [handleCloudConflict, replaceProjectWithoutAutoSave]);

  const refreshProjectFromRealtime = useCallback(async () => {
    const current = rawProjectRef.current;
    if (!current || !initialLoadRef.current || remoteCheckInFlightRef.current) return;
    if (pendingDailyReportSavesRef.current > 0) {
      if (realtimeRefreshTimerRef.current) window.clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = window.setTimeout(() => void refreshProjectFromRealtime(), 600);
      return;
    }
    if (saveTimerRef.current || inFlightSaveRef.current) {
      if (realtimeRefreshTimerRef.current) window.clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = window.setTimeout(() => void refreshProjectFromRealtime(), 1200);
      return;
    }
    remoteCheckInFlightRef.current = true;
    try {
      const latestLocal = rawProjectRef.current;
      if (!latestLocal || latestLocal.id !== current.id) return;

      // A nuvem é a fonte obrigatória: uma atualização remota nunca recebe
      // por cima um rascunho que permaneceu aberto neste aparelho.
      if (projectHasLocalChanges(latestLocal, lastSavedProjectJsonRef.current)) {
        await handleCloudConflict(latestLocal);
        return;
      }

      const record = await loadCloudProjectRecord(current.id);
      if (!record) return;
      const remoteJson = serializeProject(record.project);
      if (!record.repairApplied && remoteJson === lastSavedProjectJsonRef.current) {
        currentProjectUpdatedAtRef.current = record.updatedAt;
        setCurrentProjectUpdatedAt(record.updatedAt);
        setLastCloudConfirmedAt(new Date().toISOString());
        setSaveStatus('saved');
        return;
      }
      replaceProjectWithoutAutoSave(record.project, record.updatedAt, record.repairApplied, false);
      setRemoteUpdateAt(new Date().toISOString());
      toast.info('Atualizado com as alterações de outro usuário.');
    } catch (error) {
      console.warn('Falha ao aplicar atualização em tempo real.', error);
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
    } finally {
      remoteCheckInFlightRef.current = false;
    }
  }, [handleCloudConflict, replaceProjectWithoutAutoSave]);

  const refreshDailyReportFromRealtime = useCallback((incoming: DailyReport) => {
    if (pendingDailyReportSavesRef.current > 0) return;
    const current = rawProjectRef.current;
    if (!current || !incoming.date) return;
    setRawProject(previous => {
      if (!previous || previous.id !== current.id) return previous;
      const currentReport = reportForDate(previous, incoming.date);
      if (currentReport && serializeProject(currentReport) === serializeProject(incoming)) return previous;
      const next = replaceReportForDate(previous, incoming.date, incoming);
      rawProjectRef.current = next;
      return next;
    });
    lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, incoming.date, incoming);
    setRemoteUpdateAt(new Date().toISOString());
  }, []);

  useEffect(() => {
    const projectId = rawProject?.id;
    if (!projectId || bootLoading) return;
    const queueRefresh = (payload?: { new?: Record<string, unknown> | null }, source?: string) => {
      if (source === 'daily_reports') {
        const incoming = payload?.new?.data as DailyReport | undefined;
        if (incoming?.date) {
          refreshDailyReportFromRealtime(incoming);
          return;
        }
      }
      // Ignora o eco da própria gravação (mesma versão que já está carregada aqui).
      const remoteUpdatedAt = typeof payload?.new?.updated_at === 'string' ? payload.new.updated_at : null;
      if (remoteUpdatedAt && remoteUpdatedAt === currentProjectUpdatedAtRef.current) return;
      if (Date.now() - lastLocalSaveAtRef.current < 800) return;
      if (realtimeRefreshTimerRef.current) window.clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = window.setTimeout(() => void refreshProjectFromRealtime(), 1200);
    };
    const channel = supabase.channel(`project-live:${projectId}`);
    channel.on('postgres_changes', {
      event: '*', schema: 'public', table: 'projects', filter: `id=eq.${projectId}`,
    }, queueRefresh);
    const normalizedTables = [
      'warehouse_movements', 'warehouse_requisitions', 'warehouse_custody',
      'daily_reports', 'task_daily_logs', 'measurements', 'additives', 'audit_logs',
      'stock_movements', 'material_price_history', 'budget_items', 'material_comparisons',
      'analytic_compositions', 'subcontracts', 'eap_chapters', 'tasks',
    ] as const;
    normalizedTables.forEach(table => {
      channel.on('postgres_changes', {
        event: '*', schema: 'public', table, filter: `project_id=eq.${projectId}`,
      }, payload => queueRefresh(payload, table));
    });
    let fallbackTimer: number | null = null;
    const stopFallback = () => {
      if (fallbackTimer) { window.clearInterval(fallbackTimer); fallbackTimer = null; }
    };
    const startFallback = () => {
      if (fallbackTimer) return;
      fallbackTimer = window.setInterval(() => void checkRemoteProjectVersion(), REALTIME_FALLBACK_POLL_MS);
    };
    channel.subscribe(status => {
      const connected = status === 'SUBSCRIBED';
      realtimeConnectedRef.current = connected;
      setRealtimeConnected(connected);
      if (connected) {
        stopFallback();
        void checkRemoteProjectVersion();
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn(`[realtime] Canal da obra ${projectId} indisponível: ${status}`);
        startFallback();
      }
    });
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (realtimeConnectedRef.current) void checkRemoteProjectVersion();
      else void channel.subscribe();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      stopFallback();
      realtimeConnectedRef.current = false;
      setRealtimeConnected(false);
      if (realtimeRefreshTimerRef.current) {
        window.clearTimeout(realtimeRefreshTimerRef.current);
        realtimeRefreshTimerRef.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [bootLoading, checkRemoteProjectVersion, rawProject?.id, refreshDailyReportFromRealtime, refreshProjectFromRealtime]);

  useEffect(() => {
    if (!rawProject?.id || bootLoading) return;
    const checkNow = () => void checkRemoteProjectVersion();
    const handleOnline = () => {
      setSaveStatus(conflictDetectedRef.current ? 'conflict' : 'updating');
      checkNow();
    };
    const handleOffline = () => setSaveStatus('offline');
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') checkNow();
    };
    const timer = window.setInterval(checkNow, REMOTE_VERSION_POLL_MS);
    window.addEventListener('focus', checkNow);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', checkNow);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [bootLoading, checkRemoteProjectVersion, rawProject?.id]);

  const protectLocalDraftBeforePageSleeps = useCallback(() => {
    if (!canPersistProject || !rawProjectRef.current) return;
    try {
      flushSync(() => {
        flushPendingEditCommits();
      });
    } catch {
      flushPendingEditCommits();
    }
    const current = rawProjectRef.current;
    if (!current) return;
    const hasPendingSave = !!saveTimerRef.current || !!inFlightSaveRef.current;
    if (projectHasLocalChanges(current, lastSavedProjectJsonRef.current, hasPendingSave)) {
      cancelScheduledDraft(current.id);
      writeProjectDraft(current, currentProjectUpdatedAtRef.current);
    } else {
      discardProjectDraft(current.id);
    }
  }, [canPersistProject, cancelScheduledDraft, discardProjectDraft]);

  useEffect(() => {
    const handlePageMaySleep = () => {
      protectLocalDraftBeforePageSleeps();
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      protectLocalDraftBeforePageSleeps();
      if (!saveTimerRef.current && !inFlightSaveRef.current) return;
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

  // A prévia do aditivo é operacional: aparece no Cronograma e na Rotina sem
  // antecipar nenhuma alteração no contrato salvo em `rawProject`.
  const operationalProject = useMemo(
    () => project ? buildOperationalProjectFromPendingAdditives(project) : null,
    [project],
  );
  const pendingAdditiveScheduleControls = useMemo(
    () => project ? getPendingAdditiveScheduleControls(project) : new Map(),
    [project],
  );

  const saveDailyReportDirectly = useCallback((before: Project, after: Project) => {
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
      if (serializeProject(base) === serializeProject(local)) return;

      pendingDailyReportSavesRef.current += 1;
      setSaveStatus('saving');
      const expectedLocal = local;
      const request = dailyReportSaveQueueRef.current.catch(() => undefined).then(async () => {
        const result = await saveOpenDailyReport(after.id, base, expectedLocal);
        lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, date, result.report);
        setRawProject(current => {
          if (!current || current.id !== after.id) return current;
          const currentReport = reportForDate(current, date);
          // Uma edição mais recente já está na fila. Ela será conciliada contra
          // a versão confirmada ao chegar sua vez; não a sobrescreva agora.
          if (!currentReport || serializeProject(currentReport) !== serializeProject(expectedLocal)) return current;
          const next = replaceReportForDate(current, date, result.report);
          rawProjectRef.current = next;
          return next;
        });
        if (result.conflicts.length > 0) {
          toast.warning('A legenda ou campo já havia sido alterado em outro aparelho. Foi mantida a primeira edição salva.');
        }
      });
      dailyReportSaveQueueRef.current = request;
      void request.catch(async error => {
        console.warn('Falha ao salvar o Diário diretamente.', error);
        const newPaths = (expectedLocal.attachments ?? [])
          .filter(attachment => !(base.attachments ?? []).some(previous => previous.id === attachment.id))
          .map(attachment => attachment.storagePath)
          .filter((path): path is string => !!path);
        if (newPaths.length > 0) {
          await supabase.storage.from('daily-report-photos').remove(newPaths).catch(() => undefined);
        }
        const confirmed = await loadOpenDailyReport(after.id, date).catch(() => null);
        lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, date, confirmed ?? base);
        setRawProject(current => {
          if (!current || current.id !== after.id) return current;
          const currentReport = reportForDate(current, date);
          if (!currentReport || serializeProject(currentReport) !== serializeProject(expectedLocal)) return current;
          const next = replaceReportForDate(current, date, confirmed ?? base);
          rawProjectRef.current = next;
          return next;
        });
        toast.error(error instanceof Error ? error.message : 'Não foi possível salvar o Diário. Nenhuma alteração foi confirmada.');
      }).finally(() => {
        pendingDailyReportSavesRef.current = Math.max(0, pendingDailyReportSavesRef.current - 1);
        if (pendingDailyReportSavesRef.current === 0) setSaveStatus('saved');
      });
    });
  }, []);

  const makeViewSetter = useCallback((view: AppView) => {
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
      if (conflictDetectedRef.current) {
        toast.error('A sincronização com a nuvem ainda não foi concluída. Recarregue a obra antes de editar.');
        return;
      }
      setRawProject(prev => {
        if (!prev) return prev;
        const candidate = typeof next === 'function' ? (next as (p: Project) => Project)(prev) : next;
        const resolved = role === 'warehouse_operator' && view === 'warehouse'
          ? { ...prev, warehouse: candidate.warehouse }
          : candidate;
        const synchronized = view === 'dailyReport' || (role === 'warehouse_operator' && view === 'warehouse')
          ? resolved
          : synchronizeProjectScheduleToWorkStart(resolved);
        if (synchronized === prev) return prev;
        // Trava contra laço de atualização: objeto novo com conteúdo idêntico
        // não gera novo estado (evitava o autosave reiniciar para sempre).
        const synchronizedJson = serializeProject(synchronized);
        if (synchronizedJson === serializeProject(prev)) return prev;
        const stack = undoStacksRef.current[view];
        stack.push(prev);
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
  }, [dailyReportEditor, discardProjectDraft, editor, role, saveDailyReportDirectly, scheduleProjectDraft, warehouseEditor]);

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
  const makeOperationalSetter = useCallback((baseSetter: (next: Project | ((previous: Project) => Project)) => void) => (
    next: Project | ((previous: Project) => Project),
  ) => {
    baseSetter(previous => {
      const operational = buildOperationalProjectFromPendingAdditives(previous);
      const nextOperational = typeof next === 'function'
        ? (next as (project: Project) => Project)(operational)
        : next;
      return mergeOperationalProjectIntoRaw(previous, nextOperational);
    });
  }, []);
  const operationalGanttSetter = useMemo(() => makeOperationalSetter(ganttSetter), [ganttSetter, makeOperationalSetter]);
  const operationalManagementSetter = useMemo(() => makeOperationalSetter(managementSetter), [makeOperationalSetter, managementSetter]);

  const commitProjectNow = useCallback(async (next: Project) => {
    if (!user || !orgId || !canPersistProject) throw new Error('Você não tem permissão para salvar esta obra.');
    if (conflictDetectedRef.current) {
      throw new Error('A sincronização com a nuvem ainda não foi concluída. Recarregue a obra antes de salvar.');
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (inFlightSaveRef.current) await inFlightSaveRef.current;

    const current = rawProjectRef.current;
    const scopedNext = role === 'warehouse_operator' && current
      ? { ...current, warehouse: next.warehouse }
      : next;
    const synchronized = role === 'warehouse_operator'
      ? scopedNext
      : synchronizeProjectScheduleToWorkStart(scopedNext);
    writeProjectDraft(synchronized, currentProjectUpdatedAtRef.current);
    setSaveStatus('saving');
    try {
      await persistProject(synchronized, orgId);
    } catch (error) {
      if (error instanceof CloudProjectConflictError) await handleCloudConflict(synchronized);
      throw error;
    }

    const previous = rawProjectRef.current;
    if (previous) {
      const stack = undoStacksRef.current.warehouse;
      stack.push(previous);
      if (stack.length > UNDO_LIMIT) stack.shift();
    }
    skipNextAutoSaveRef.current = true;
    rawProjectRef.current = synchronized;
    setRawProject(synchronized);
    setUndoVersion(value => value + 1);
  }, [canPersistProject, handleCloudConflict, orgId, persistProject, role, user]);

  const saveStorageMaintenanceProject = useCallback(async (next: Project, expectedUpdatedAt: string) => {
    if (!user || !orgId || !canPersistProject || role !== 'owner') {
      throw new Error('Somente o Proprietário pode executar a manutenção global do Storage.');
    }
    return upsertCloudProject(next, orgId, expectedUpdatedAt);
  }, [canPersistProject, orgId, role, user]);

  const handleUndo = useCallback((view: AppView) => {
    const stack = undoStacksRef.current[view];
    if (stack.length === 0) { toast.message('Nada para desfazer'); return; }
    const prev = stack.pop()!;
    writeProjectDraft(prev, currentProjectUpdatedAtRef.current);
    rawProjectRef.current = prev;
    setRawProject(prev);
    setUndoVersion(v => v + 1);
    toast.success('Alteração desfeita');
  }, []);

  const canUndo = (view: AppView) => undoStacksRef.current[view].length > 0;
  void undoVersion;

  const handleSwitchProject = async (id: string) => {
    try {
      if (!(await flushPendingSave())) return;
      const record = await loadCloudProjectRecord(id);
      if (record) {
        let projectToLoad = record.project;
        let updatedAt = record.updatedAt;
        if (role === 'owner') {
          const reconciliation = reconcileFiscalNoteDuplicates(record.project, auditActor);
          if (!reconciliation.alreadyReconciled) {
            updatedAt = await upsertCloudProject(reconciliation.project, orgId!, record.updatedAt);
            projectToLoad = reconciliation.project;
            if (reconciliation.canceledNoteIds.length) {
              toast.warning(`${reconciliation.canceledNoteIds.length} entrada(s) fiscal(is) duplicada(s) foram canceladas automaticamente.`);
            }
            if (reconciliation.pendingNoteIds.length) {
              toast.warning(`${reconciliation.pendingNoteIds.length} duplicidade(s) possuem consumo posterior e exigem ajuste/conferência.`);
            }
          }
        }
        replaceProjectWithoutAutoSave(projectToLoad, updatedAt, record.repairApplied);
        undoStacksRef.current = { dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], additiveSchedule: [], realCost: [], materials: [], warehouse: [] };
        setUndoVersion(v => v + 1);
      }
    } catch {
      toast.error('Erro ao abrir obra');
    }
  };

  const handleCreateProject = async (): Promise<void> => {
    if (!orgId) return;
    if (!creator) { toast.error('Sem permissão para criar obras.'); return; }
    try {
      if (!(await flushPendingSave())) return;
      setDraftProjectForImport(createDraftProject());
      setCreateProjectDialogOpen(true);
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
    const persisted = await loadCloudProjectRecord(projectWithName.id);
    if (!persisted) throw new Error('A obra foi gravada, mas nao pode ser relida para validacao.');
    const expectedTasks = (projectWithName.phases ?? []).reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
    const persistedTasks = (persisted.project.phases ?? []).reduce((sum, phase) => sum + (phase.tasks?.length ?? 0), 0);
    const collectionsMatch =
      (persisted.project.budgetItems?.length ?? 0) === (projectWithName.budgetItems?.length ?? 0)
      && (persisted.project.analyticCompositions?.length ?? 0) === (projectWithName.analyticCompositions?.length ?? 0)
      && (persisted.project.phases?.length ?? 0) === (projectWithName.phases?.length ?? 0)
      && persistedTasks === expectedTasks;
    if (!collectionsMatch) {
      await deleteCloudProject(projectWithName.id);
      throw new Error('A estrutura importada nao foi confirmada no banco. A obra incompleta foi removida; tente novamente.');
    }
    const list = await refreshCloudList();
    replaceProjectWithoutAutoSave(persisted.project, list.find(p => p.id === projectWithName.id)?.updatedAt ?? persisted.updatedAt ?? updatedAt);
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
      if (rawProject?.id === id && !(await flushPendingSave())) return;
      const updated = await renameCloudProject(id, newName, orgId);
      const list = await refreshCloudList();
      if (updated && rawProject && id === rawProject.id) replaceProjectWithoutAutoSave(updated, list.find(p => p.id === id)?.updatedAt ?? currentProjectUpdatedAt);
      setUndoVersion(v => v + 1);
    } catch {
      toast.error('Erro ao renomear');
    }
  };

  const handleDuplicateProject = async (id: string) => {
    if (!orgId || !creator) { toast.error('Sem permissão para duplicar.'); return; }
    try {
      if (rawProject?.id === id && !(await flushPendingSave())) return;
      const copy = await duplicateCloudProject(id, orgId);
      if (copy) {
        await refreshCloudList();
        toast.success(`Obra duplicada: ${copy.name}`);
        setUndoVersion(v => v + 1);
      }
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
      if (rawProject?.id === id && !(await flushPendingSave())) return false;
      await deleteCloudProjectAsOwner(id, password);
      const list = await refreshCloudList();
      if (rawProject && id === rawProject.id) {
        const next = list[0];
        if (next) {
          const record = await loadCloudProjectRecord(next.id);
          if (record) {
            replaceProjectWithoutAutoSave(record.project, record.updatedAt, record.repairApplied);
            undoStacksRef.current = { dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], additiveSchedule: [], realCost: [], materials: [], warehouse: [] };
          }
        }
      }
      toast.success('Obra excluída');
      setUndoVersion(v => v + 1);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erro ao excluir a obra.');
      return false;
    }
  };

  const handleLogout = async () => {
    if (!(await flushPendingSave())) return;
    await signOut();
    navigate('/auth', { replace: true });
  };

  const sidebarProjects: ProjectMeta[] = useMemo(
    () => cloudList.map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt })),
    [cloudList]
  );

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

  if (bootLoading || !project || !rawProject) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderView = () => {
    switch (safeCurrentView) {
      case 'dashboard':
        return <Dashboard project={project} undoButton={<UndoButton canUndo={canUndo('dashboard')} onUndo={() => handleUndo('dashboard')} />} />;
      case 'management':
        return (
          <ManagementRoutine
            project={operationalProject ?? project}
            onProjectChange={operationalManagementSetter}
            onOpenDailyReport={handleOpenDailyReport}
            onOpenProduction={handleOpenProductionActivity}
            readOnly={!editor}
            canRequestReschedule={role === 'owner' || role === 'admin' || role === 'engineer'}
            canApproveReschedule={role === 'owner' || role === 'admin'}
            auditActor={auditActor}
            initialWeek={new URLSearchParams(location.search).get('semana') || undefined}
            onWeekChange={weekStart => navigate(`/obras/${project.id}/rotina?semana=${weekStart}`, { replace: true })}
            undoButton={<UndoButton canUndo={canUndo('management')} onUndo={() => handleUndo('management')} />}
          />
        );
      case 'gantt':
        return <GanttChart
          project={operationalProject ?? project}
          onProjectChange={operationalGanttSetter}
          lockedTaskLabels={Object.fromEntries(Array.from(pendingAdditiveScheduleControls.entries()).map(([taskId, control]) => [taskId, control.additiveName]))}
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
          <DailyProductionWorkspace
            project={project}
            initialTab={productionWorkspaceInitialTab}
            onProductionChange={tasksSetter}
            onDailyReportChange={dailyReportSetter}
            productionReadOnly={!editor}
            dailyReportReadOnly={!dailyReportEditor}
            dailyReportCanManageConclusion={role === 'owner'}
            dailyReportCanClearDay={editor}
            productionUndoButton={<UndoButton canUndo={canUndo('tasks')} onUndo={() => handleUndo('tasks')} />}
            dailyReportUndoButton={<UndoButton canUndo={canUndo('dailyReport')} onUndo={() => handleUndo('dailyReport')} />}
            dailyReportInitialDate={dailyReportInitialDate}
            dailyReportInitialFilter={dailyReportInitialFilter}
            dailyReportNavKey={dailyReportNavKey}
            productionFocusTaskId={new URLSearchParams(location.search).get('atividade') || undefined}
            productionFocusDate={new URLSearchParams(location.search).get('data') || undefined}
          />
        );
      case 'measurement':
        return <Measurement project={project} onProjectChange={measurementSetter} undoButton={<UndoButton canUndo={canUndo('measurement')} onUndo={() => handleUndo('measurement')} />} onOpenDailyReport={handleOpenDailyReport} />;
      case 'dailyReport':
        return (
          <DailyProductionWorkspace
            project={project}
            initialTab="dailyReport"
            onProductionChange={tasksSetter}
            onDailyReportChange={dailyReportSetter}
            productionReadOnly={!editor}
            dailyReportReadOnly={!dailyReportEditor}
            dailyReportCanManageConclusion={role === 'owner'}
            dailyReportCanClearDay={editor}
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
        return <Materials project={project} onProjectChange={materialsSetter} auditActor={auditActor} />;
      case 'warehouse':
        return (
          <WarehouseView
            project={project}
            onProjectChange={warehouseSetter}
            onCommitProject={commitProjectNow}
            canManageFiscalNotes={warehouseEditor}
            canReviewFiscalCosts={role === 'owner' || role === 'admin'}
            canViewPanel={role !== 'warehouse_operator' && role !== 'engineer'}
            canApproveInventory={role === 'owner' || role === 'admin'}
            canArchiveWarehouseRecords={warehouseEditor}
            canEditPostedWarehouseRecords={role === 'owner'}
            canSupplementRequisitions={warehouseEditor}
            canDeleteWarehouseRecords={role === 'owner'}
            canManageEquipmentGroups={role === 'owner' || role === 'warehouse_operator'}
            canOptimizeStorage={role === 'owner'}
            onSaveStorageMaintenanceProject={saveStorageMaintenanceProject}
            storageMaintenanceOrganizationId={orgId}
            auditActor={auditActor}
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
          currentView={safeCurrentView}
          onViewChange={(v) => {
            if (role && !canAccessAppView(role, v)) return;
            if (v === 'tasks') setProductionWorkspaceInitialTab('production');
            if (v === 'dailyReport') setProductionWorkspaceInitialTab('dailyReport');
            setCurrentView(v);
            setSidebarOpen(false);
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
          onOpenTeam={() => navigate('/team')}
          allowedViews={allowedViews}
          canManageProjects={role !== 'warehouse_operator'}
          canDeleteProjects={remover}
        />
      </div>

      <main ref={mainScrollRef} className="relative min-h-screen min-w-0 flex-1 overflow-x-clip overflow-y-auto pt-14 lg:pt-0">
        <div className="absolute top-3 right-4 z-20">
          <SaveStatusIndicator status={saveStatus} confirmedAt={lastCloudConfirmedAt} projectId={rawProject.id} live={realtimeConnected} remoteUpdateAt={remoteUpdateAt} />
        </div>
        <Suspense fallback={
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        }>
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

    </div>
  );
}
