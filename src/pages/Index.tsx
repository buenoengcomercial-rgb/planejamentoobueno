import { useState, useMemo, useEffect, useDeferredValue, useCallback, useRef, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AppView, Project } from '@/types/project';
import AppSidebar from '@/components/AppSidebar';
import UndoButton from '@/components/UndoButton';
import SaveStatusIndicator, { SaveStatus } from '@/components/SaveStatusIndicator';
import MigrationDialog from '@/components/MigrationDialog';
import ImportSyntheticDialog from '@/components/ImportSyntheticDialog';
import { Menu, X, Loader2, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { applyRupToProject, applyDailyLogsToProject, calculateCPM, captureBaseline, syncBaselineWithRup, settleAllDependencies } from '@/lib/calculations';
import { loadObraConfig } from '@/components/ConfiguracaoObra';
import { flushPendingEditCommits } from '@/lib/pendingEditCommits';
import { lazyWithReload } from '@/lib/lazyWithReload';

// Lazy load: cada aba só baixa seu bundle quando aberta pela primeira vez.
// Usa lazyWithReload para recuperar automaticamente de chunks obsoletos após deploy.
const Dashboard = lazyWithReload(() => import('@/components/Dashboard'));
const ManagementRoutine = lazyWithReload(() => import('@/components/ManagementRoutine'));
const GanttChart = lazyWithReload(() => import('@/components/GanttChart'));
const Measurement = lazyWithReload(() => import('@/components/Measurement'));
const DailyProductionWorkspace = lazyWithReload(() => import('@/components/DailyProductionWorkspace'));
const Additive = lazyWithReload(() => import('@/components/Additive'));
const RealCost = lazyWithReload(() => import('@/components/RealCost'));
const Materials = lazyWithReload(() => import('@/components/Materials'));
const WarehouseView = lazyWithReload(() => import('@/components/warehouse/Warehouse'));
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { canCreateProject, canDeleteProject, canEditProject, ROLE_LABELS } from '@/lib/organizations';
import { Button } from '@/components/ui/button';
import {
  listCloudProjects,
  loadCloudProjectRecord,
  upsertCloudProject,
  createCloudProject,
  renameCloudProject,
  duplicateCloudProject,
  deleteCloudProject,
  generateUniqueCloudName,
  getSampleSeed,
  CloudProjectConflictError,
  CloudProjectMeta,
} from '@/lib/cloudProjects';
import type { ProjectMeta } from '@/lib/projectStorage';

const UNDO_LIMIT = 20;
const SAVE_DEBOUNCE_MS = 4000;
const UNSAVED_DRAFT_VERSION = 1;
const UI_SESSION_VERSION = 1;
const APP_UI_SESSION_KEY = 'obraplanner:ui-session';
const APP_VIEWS: AppView[] = ['dashboard', 'management', 'gantt', 'tasks', 'measurement', 'dailyReport', 'additive', 'realCost', 'materials', 'warehouse'];

type UndoStacks = Record<AppView, Project[]>;

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

interface UnsavedProjectDraft {
  version: typeof UNSAVED_DRAFT_VERSION;
  baseUpdatedAt: string | null;
  savedAt?: string; // legado: mantido para recuperar rascunhos gravados antes desta blindagem.
  localDraftUpdatedAt: string;
  project: Project;
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

const unsavedDraftKey = (projectId: string) => `obraplanner:unsaved-cloud-draft:${projectId}`;

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

function readInitialView(): AppView {
  return readAppUiSession()?.view ?? 'dashboard';
}

function toTime(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function readUnsavedDraft(projectId: string, cloudUpdatedAt: string | null): UnsavedProjectDraft | null {
  try {
    const raw = localStorage.getItem(unsavedDraftKey(projectId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as UnsavedProjectDraft;
    if (draft.version !== UNSAVED_DRAFT_VERSION) return null;
    if (!draft.project || draft.project.id !== projectId) return null;

    const localDraftUpdatedAt = draft.localDraftUpdatedAt ?? draft.savedAt;
    if (!localDraftUpdatedAt) return null;

    const baseMatches = draft.baseUpdatedAt === cloudUpdatedAt;
    const localIsNewerThanCloud = toTime(localDraftUpdatedAt) >= toTime(cloudUpdatedAt);
    if (!baseMatches && !localIsNewerThanCloud) return null;

    return { ...draft, localDraftUpdatedAt };
  } catch {
    return null;
  }
}

function writeUnsavedDraft(project: Project, baseUpdatedAt: string | null) {
  try {
    const now = new Date().toISOString();
    localStorage.setItem(unsavedDraftKey(project.id), JSON.stringify({
      version: UNSAVED_DRAFT_VERSION,
      baseUpdatedAt,
      savedAt: now,
      localDraftUpdatedAt: now,
      project,
    } satisfies UnsavedProjectDraft));
  } catch (err) {
    console.warn('Nao foi possivel gravar rascunho local de seguranca.', err);
  }
}

function clearUnsavedDraft(projectId: string) {
  try {
    localStorage.removeItem(unsavedDraftKey(projectId));
  } catch {
    // ignore
  }
}

function serializeProjectForSave(project: Project): string {
  return JSON.stringify(project);
}

export default function Index() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { membership, loading: orgLoading } = useOrganization();
  const navigate = useNavigate();

  const [currentView, setCurrentView] = useState<AppView>(() => readInitialView());
  const [rawProject, setRawProject] = useState<Project | null>(null);
  const [cloudList, setCloudList] = useState<CloudProjectMeta[]>([]);
  const [bootLoading, setBootLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [currentProjectUpdatedAt, setCurrentProjectUpdatedAt] = useState<string | null>(null);
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
    setCurrentView('tasks');
    setSidebarOpen(false);
  }, []);

  const undoStacksRef = useRef<UndoStacks>({ dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], realCost: [], materials: [], warehouse: [] });
  const [undoVersion, setUndoVersion] = useState(0);
  const rawProjectRef = useRef<Project | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const initialLoadRef = useRef(false);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const currentProjectUpdatedAtRef = useRef<string | null>(null);
  const saveRequestSeqRef = useRef(0);
  const lastSavedProjectJsonRef = useRef<string | null>(null);
  const skipNextAutoSaveRef = useRef(false);
  const conflictDetectedRef = useRef(false);
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const restoredUiSessionRef = useRef<string | null>(null);
  const uiSessionSaverReadyRef = useRef<string | null>(null);

  const orgId = membership?.organization.id;
  const role = membership?.role;
  const editor = role ? canEditProject(role) : false;
  const creator = role ? canCreateProject(role) : false;
  const remover = role ? canDeleteProject(role) : false;

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth', { replace: true });
  }, [authLoading, user, navigate]);

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

    if (session.view && session.view !== currentView) {
      setCurrentView(session.view);
      return;
    }

    restoredUiSessionRef.current = restoreKey;
    // Lovable Preview pode remontar o iframe ao voltar de outro app. Esta restauracao
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
  }, [bootLoading, currentView, rawProject]);

  const refreshCloudList = useCallback(async (): Promise<CloudProjectMeta[]> => {
    const list = await listCloudProjects();
    setCloudList(list);
    return list;
  }, []);

  const replaceProjectWithoutAutoSave = useCallback((projectToLoad: Project | null, updatedAt: string | null = null) => {
    let projectForState = projectToLoad;
    const cloudProjectJson = projectToLoad ? serializeProjectForSave(projectToLoad) : null;
    const draft = projectToLoad ? readUnsavedDraft(projectToLoad.id, updatedAt) : null;
    if (draft) {
      projectForState = draft.project;
      toast.info('Recuperei alterações locais que ainda não tinham sido salvas na nuvem.');
    }

    skipNextAutoSaveRef.current = !draft;
    conflictDetectedRef.current = false;
    currentProjectUpdatedAtRef.current = updatedAt;
    rawProjectRef.current = projectForState;
    // Se recuperamos rascunho local, a referencia de "salvo" precisa continuar
    // sendo a versao da nuvem; assim o autosave percebe a diferenca e reenvia.
    lastSavedProjectJsonRef.current = draft ? cloudProjectJson : (projectForState ? serializeProjectForSave(projectForState) : null);
    setCurrentProjectUpdatedAt(updatedAt);
    setRawProject(projectForState);
    if (draft) setSaveStatus('saving');
  }, []);

  const persistProject = useCallback(async (projectToSave: Project, projectOrgId: string) => {
    const nextJson = serializeProjectForSave(projectToSave);
    if (nextJson === lastSavedProjectJsonRef.current) {
      clearUnsavedDraft(projectToSave.id);
      setSaveStatus('saved');
      return;
    }

    const seq = ++saveRequestSeqRef.current;
    const request = saveQueueRef.current.catch(() => undefined).then(async () => {
      let updatedAt: string;
      try {
        updatedAt = await upsertCloudProject(projectToSave, projectOrgId, currentProjectUpdatedAtRef.current ?? undefined);
      } catch (e) {
        if (!(e instanceof CloudProjectConflictError)) throw e;

        // Em uso individual/Lovable Preview, conflitos de updated_at costumam
        // vir de salvamentos concorrentes do mesmo navegador. A versao local
        // e a mais segura para nao perder trabalho em andamento.
        updatedAt = await upsertCloudProject(projectToSave, projectOrgId);
        toast.warning('Mantive suas alteracoes locais e sincronizei novamente com a nuvem.');
      }
      conflictDetectedRef.current = false;
      currentProjectUpdatedAtRef.current = updatedAt;
      lastSavedProjectJsonRef.current = nextJson;
      setCurrentProjectUpdatedAt(updatedAt);
      if (seq === saveRequestSeqRef.current && !saveTimerRef.current) {
        clearUnsavedDraft(projectToSave.id);
        setSaveStatus('saved');
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
  }, []);

  useEffect(() => {
    rawProjectRef.current = rawProject;
  }, [rawProject]);

  const flushPendingSave = useCallback(async () => {
    if (!user || !orgId || !rawProject || !initialLoadRef.current || !editor) return true;

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      setSaveStatus('saving');
      try {
        await persistProject(rawProject, orgId);
        return true;
      } catch (e) {
        console.warn(e);
        setSaveStatus('error');
        if (e instanceof CloudProjectConflictError) {
          conflictDetectedRef.current = true;
          toast.error('Esta obra foi alterada em outro local. Reabra a obra antes de continuar salvando.');
        } else {
          toast.error('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
        }
        return false;
      }
    }

    if (inFlightSaveRef.current) {
      try {
        await inFlightSaveRef.current;
        return true;
      } catch {
        return false;
      }
    }

    return true;
  }, [user, orgId, rawProject, editor, persistProject]);

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
          const record = await loadCloudProjectRecord(list[0].id);
          if (cancelled) return;
          if (record) replaceProjectWithoutAutoSave(record.project, record.updatedAt);
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
  }, [user, orgId, creator, refreshCloudList, replaceProjectWithoutAutoSave]);

  // Salvamento debounced (somente se o usuário pode editar)
  useEffect(() => {
    if (!user || !orgId || !rawProject || !initialLoadRef.current) return;
    if (!editor) return;
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
        setSaveStatus('error');
        if (e instanceof CloudProjectConflictError) {
          conflictDetectedRef.current = true;
          toast.error('Esta obra foi alterada em outro local. Reabra a obra antes de continuar salvando.');
        } else {
          toast.error('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
        }
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [rawProject, user, orgId, editor, persistProject]);

  const protectLocalDraftBeforePageSleeps = useCallback(() => {
    if (!editor || !rawProjectRef.current) return;
    try {
      flushSync(() => {
        flushPendingEditCommits();
      });
    } catch {
      flushPendingEditCommits();
    }
    if (rawProjectRef.current) writeUnsavedDraft(rawProjectRef.current, currentProjectUpdatedAtRef.current);
  }, [editor]);

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
  const needsDependencySettle = currentView === 'gantt' || currentView === 'dashboard' || currentView === 'realCost';

  const project = useMemo(() => {
    if (!deferredRawProject) return null;
    const enriched = applyDailyLogsToProject(
      syncBaselineWithRup(
        applyRupToProject(captureBaseline(deferredRawProject))
      )
    );
    if (needsDependencySettle) {
      const cfg = loadObraConfig();
      const cal = { uf: cfg.uf, municipio: cfg.municipio, trabalhaSabado: cfg.trabalhaSabado, jornadaDiaria: cfg.jornadaDiaria };
      return calculateCPM(settleAllDependencies(enriched, cal));
    }
    return calculateCPM(enriched);
  }, [deferredRawProject, needsDependencySettle]);

  const makeViewSetter = useCallback((view: AppView) => {
    return (next: Project | ((prev: Project) => Project)) => {
      if (!editor) {
        toast.error('Você não tem permissão para editar.');
        return;
      }
      setRawProject(prev => {
        if (!prev) return prev;
        const resolved = typeof next === 'function' ? (next as (p: Project) => Project)(prev) : next;
        if (resolved === prev) return prev;
        const stack = undoStacksRef.current[view];
        stack.push(prev);
        if (stack.length > UNDO_LIMIT) stack.shift();
        rawProjectRef.current = resolved;
        writeUnsavedDraft(resolved, currentProjectUpdatedAtRef.current);
        setUndoVersion(v => v + 1);
        return resolved;
      });
    };
  }, [editor]);

  const ganttSetter = useMemo(() => makeViewSetter('gantt'), [makeViewSetter]);
  const managementSetter = useMemo(() => makeViewSetter('management'), [makeViewSetter]);
  const tasksSetter = useMemo(() => makeViewSetter('tasks'), [makeViewSetter]);
  const measurementSetter = useMemo(() => makeViewSetter('measurement'), [makeViewSetter]);
  const dailyReportSetter = useMemo(() => makeViewSetter('dailyReport'), [makeViewSetter]);
  const additiveSetter = useMemo(() => makeViewSetter('additive'), [makeViewSetter]);
  const materialsSetter = useMemo(() => makeViewSetter('materials'), [makeViewSetter]);
  const warehouseSetter = useMemo(() => makeViewSetter('warehouse'), [makeViewSetter]);

  const handleUndo = useCallback((view: AppView) => {
    const stack = undoStacksRef.current[view];
    if (stack.length === 0) { toast.message('Nada para desfazer'); return; }
    const prev = stack.pop()!;
    writeUnsavedDraft(prev, currentProjectUpdatedAtRef.current);
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
        replaceProjectWithoutAutoSave(record.project, record.updatedAt);
        undoStacksRef.current = { dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], realCost: [], materials: [], warehouse: [] };
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
    const list = await refreshCloudList();
    replaceProjectWithoutAutoSave(projectWithName, list.find(p => p.id === projectWithName.id)?.updatedAt ?? updatedAt);
    undoStacksRef.current = { dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], realCost: [], materials: [], warehouse: [] };
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

  const handleDeleteProject = async (id: string) => {
    if (!remover) { toast.error('Sem permissão para excluir.'); return; }
    if (cloudList.length <= 1) {
      toast.error('Não é possível excluir a única obra. Crie outra antes.');
      return;
    }
    try {
      if (rawProject?.id === id && !(await flushPendingSave())) return;
      await deleteCloudProject(id);
      const list = await refreshCloudList();
      if (rawProject && id === rawProject.id) {
        const next = list[0];
        if (next) {
          const record = await loadCloudProjectRecord(next.id);
          if (record) {
            replaceProjectWithoutAutoSave(record.project, record.updatedAt);
            undoStacksRef.current = { dashboard: [], management: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], realCost: [], materials: [], warehouse: [] };
          }
        }
      }
      toast.success('Obra excluída');
      setUndoVersion(v => v + 1);
    } catch {
      toast.error('Erro ao excluir');
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
    switch (currentView) {
      case 'dashboard':
        return <Dashboard project={project} undoButton={<UndoButton canUndo={canUndo('dashboard')} onUndo={() => handleUndo('dashboard')} />} />;
      case 'management':
        return <ManagementRoutine project={project} onProjectChange={managementSetter} undoButton={<UndoButton canUndo={canUndo('management')} onUndo={() => handleUndo('management')} />} />;
      case 'gantt':
        return <GanttChart project={project} onProjectChange={ganttSetter} undoButton={<UndoButton canUndo={canUndo('gantt')} onUndo={() => handleUndo('gantt')} size="xs" />} />;
      case 'tasks':
        return (
          <DailyProductionWorkspace
            project={project}
            initialTab={productionWorkspaceInitialTab}
            onProductionChange={tasksSetter}
            onDailyReportChange={dailyReportSetter}
            productionUndoButton={<UndoButton canUndo={canUndo('tasks')} onUndo={() => handleUndo('tasks')} />}
            dailyReportUndoButton={<UndoButton canUndo={canUndo('dailyReport')} onUndo={() => handleUndo('dailyReport')} />}
            dailyReportInitialDate={dailyReportInitialDate}
            dailyReportInitialFilter={dailyReportInitialFilter}
            dailyReportNavKey={dailyReportNavKey}
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
            productionUndoButton={<UndoButton canUndo={canUndo('tasks')} onUndo={() => handleUndo('tasks')} />}
            dailyReportUndoButton={<UndoButton canUndo={canUndo('dailyReport')} onUndo={() => handleUndo('dailyReport')} />}
            dailyReportInitialDate={dailyReportInitialDate}
            dailyReportInitialFilter={dailyReportInitialFilter}
            dailyReportNavKey={dailyReportNavKey}
          />
        );
      case 'additive':
        return <Additive project={project} onProjectChange={additiveSetter} undoButton={<UndoButton canUndo={canUndo('additive')} onUndo={() => handleUndo('additive')} />} />;
      case 'realCost':
        return <RealCost project={project} />;
      case 'materials':
        return <Materials project={project} onProjectChange={materialsSetter} />;
      case 'warehouse':
        return <WarehouseView project={project} onProjectChange={warehouseSetter} />;
    }
  };

  return (
    <div className="flex min-h-screen bg-background">
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="fixed top-4 left-4 z-50 lg:hidden bg-card border border-border rounded-lg p-2 shadow-md"
      >
        {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {sidebarOpen && (
        <div className="fixed inset-0 bg-foreground/20 z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div className={`fixed lg:static z-40 transition-transform lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <AppSidebar
          currentView={currentView}
          onViewChange={(v) => {
            if (v === 'tasks') setProductionWorkspaceInitialTab('production');
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
        />
      </div>

      <main ref={mainScrollRef} className="flex-1 min-h-screen overflow-y-auto relative">
        <div className="absolute top-3 right-4 z-20">
          <SaveStatusIndicator status={saveStatus} />
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
      )}

      {orgId && <MigrationDialog organizationId={orgId} onMigrated={async () => { await refreshCloudList(); }} />}
    </div>
  );
}
