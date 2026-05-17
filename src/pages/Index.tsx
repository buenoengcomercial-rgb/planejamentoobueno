import { useState, useMemo, useEffect, useDeferredValue, useCallback, useRef, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppView, Project } from '@/types/project';
import AppSidebar from '@/components/AppSidebar';
import UndoButton from '@/components/UndoButton';
import SaveStatusIndicator, { SaveStatus } from '@/components/SaveStatusIndicator';
import MigrationDialog from '@/components/MigrationDialog';
import { Menu, X, Loader2, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { applyRupToProject, applyDailyLogsToProject, calculateCPM, captureBaseline, syncBaselineWithRup, settleAllDependencies } from '@/lib/calculations';
import { loadObraConfig } from '@/components/ConfiguracaoObra';

// Lazy load: cada aba só baixa seu bundle quando aberta pela primeira vez.
const Dashboard = lazy(() => import('@/components/Dashboard'));
const GanttChart = lazy(() => import('@/components/GanttChart'));
const TaskList = lazy(() => import('@/components/TaskList'));
const Measurement = lazy(() => import('@/components/Measurement'));
const DailyReport = lazy(() => import('@/components/DailyReport'));
const Additive = lazy(() => import('@/components/Additive'));
const Materials = lazy(() => import('@/components/Materials'));
const WarehouseView = lazy(() => import('@/components/warehouse/Warehouse'));
import { useAuth } from '@/hooks/useAuth';
import { useOrganization } from '@/hooks/useOrganization';
import { canCreateProject, canDeleteProject, canEditProject, ROLE_LABELS } from '@/lib/organizations';
import { Button } from '@/components/ui/button';
import {
  listCloudProjects,
  loadCloudProject,
  upsertCloudProject,
  createCloudProject,
  renameCloudProject,
  duplicateCloudProject,
  deleteCloudProject,
  generateUniqueCloudName,
  getSampleSeed,
  CloudProjectMeta,
} from '@/lib/cloudProjects';
import type { ProjectMeta } from '@/lib/projectStorage';

const UNDO_LIMIT = 20;
const SAVE_DEBOUNCE_MS = 1200;

type UndoStacks = Record<AppView, Project[]>;

export default function Index() {
  const { user, loading: authLoading, signOut } = useAuth();
  const { membership, loading: orgLoading } = useOrganization();
  const navigate = useNavigate();

  const [currentView, setCurrentView] = useState<AppView>('dashboard');
  const [rawProject, setRawProject] = useState<Project | null>(null);
  const [cloudList, setCloudList] = useState<CloudProjectMeta[]>([]);
  const [bootLoading, setBootLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dailyReportInitialDate, setDailyReportInitialDate] = useState<string | undefined>(undefined);
  const [dailyReportInitialFilter, setDailyReportInitialFilter] = useState<string | undefined>(undefined);
  const [dailyReportNavKey, setDailyReportNavKey] = useState(0);

  const handleOpenDailyReport = useCallback((dateISO: string, measurementFilter?: string) => {
    setDailyReportInitialDate(dateISO);
    setDailyReportInitialFilter(measurementFilter);
    setDailyReportNavKey(k => k + 1); // força re-aplicação mesmo se valores se repetirem
    setCurrentView('dailyReport');
    setSidebarOpen(false);
  }, []);

  const undoStacksRef = useRef<UndoStacks>({ dashboard: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], materials: [], warehouse: [] });
  const [undoVersion, setUndoVersion] = useState(0);
  const saveTimerRef = useRef<number | null>(null);
  const initialLoadRef = useRef(false);

  const orgId = membership?.organization.id;
  const role = membership?.role;
  const editor = role ? canEditProject(role) : false;
  const creator = role ? canCreateProject(role) : false;
  const remover = role ? canDeleteProject(role) : false;

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth', { replace: true });
  }, [authLoading, user, navigate]);

  const refreshCloudList = useCallback(async (): Promise<CloudProjectMeta[]> => {
    const list = await listCloudProjects();
    setCloudList(list);
    return list;
  }, []);

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
          setRawProject(created);
        } else if (list.length > 0) {
          const proj = await loadCloudProject(list[0].id);
          if (cancelled) return;
          if (proj) setRawProject(proj);
        } else {
          setRawProject(null);
        }
        initialLoadRef.current = true;
      } catch (e) {
        console.error(e);
        toast.error('Erro ao carregar obras da empresa');
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, orgId, creator, refreshCloudList]);

  // Salvamento debounced (somente se o usuário pode editar)
  useEffect(() => {
    if (!user || !orgId || !rawProject || !initialLoadRef.current) return;
    if (!editor) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    setSaveStatus('saving');
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        await upsertCloudProject(rawProject, orgId);
        setSaveStatus('saved');
        setCloudList(prev => {
          const idx = prev.findIndex(p => p.id === rawProject.id);
          const meta: CloudProjectMeta = {
            id: rawProject.id,
            name: rawProject.name,
            createdAt: idx >= 0 ? prev[idx].createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          if (idx >= 0) { const copy = [...prev]; copy[idx] = meta; return copy; }
          return [meta, ...prev];
        });
      } catch (e) {
        console.error(e);
        setSaveStatus('error');
        toast.error('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [rawProject, user, orgId, editor]);

  const deferredRawProject = useDeferredValue(rawProject);

  // Recálculo condicional: o `settleAllDependencies` (mais caro, varre dependências)
  // só roda quando o usuário está nas abas que dependem dele (Cronograma/Dashboard).
  // Nas demais abas (Tarefas/Medição/Diário) usa-se o pipeline leve, evitando trabalho
  // pesado a cada digitação. CPM continua rodando porque é barato e fornece `isCritical`.
  const needsDependencySettle = currentView === 'gantt' || currentView === 'dashboard';

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
        setUndoVersion(v => v + 1);
        return resolved;
      });
    };
  }, [editor]);

  const ganttSetter = useMemo(() => makeViewSetter('gantt'), [makeViewSetter]);
  const tasksSetter = useMemo(() => makeViewSetter('tasks'), [makeViewSetter]);
  const measurementSetter = useMemo(() => makeViewSetter('measurement'), [makeViewSetter]);
  const dailyReportSetter = useMemo(() => makeViewSetter('dailyReport'), [makeViewSetter]);
  const additiveSetter = useMemo(() => makeViewSetter('additive'), [makeViewSetter]);
  const materialsSetter = useMemo(() => makeViewSetter('materials'), [makeViewSetter]);

  const handleUndo = useCallback((view: AppView) => {
    const stack = undoStacksRef.current[view];
    if (stack.length === 0) { toast.message('Nada para desfazer'); return; }
    const prev = stack.pop()!;
    setRawProject(prev);
    setUndoVersion(v => v + 1);
    toast.success('Alteração desfeita');
  }, []);

  const canUndo = (view: AppView) => undoStacksRef.current[view].length > 0;
  void undoVersion;

  const handleSwitchProject = async (id: string) => {
    try {
      const proj = await loadCloudProject(id);
      if (proj) {
        setRawProject(proj);
        undoStacksRef.current = { dashboard: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], materials: [], warehouse: [] };
        setUndoVersion(v => v + 1);
      }
    } catch {
      toast.error('Erro ao abrir obra');
    }
  };

  const handleCreateProject = async (name?: string): Promise<string | void> => {
    if (!orgId) return;
    if (!creator) { toast.error('Sem permissão para criar obras.'); return; }
    try {
      const finalName = (name && name.trim()) || (await generateUniqueCloudName('Nova obra'));
      const newProj = await createCloudProject(finalName, orgId);
      await refreshCloudList();
      setRawProject(newProj);
      undoStacksRef.current = { dashboard: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], materials: [], warehouse: [] };
      setUndoVersion(v => v + 1);
      return newProj.id;
    } catch {
      toast.error('Erro ao criar obra');
    }
  };

  const handleRenameProject = async (id: string, newName: string) => {
    if (!orgId || !editor) { toast.error('Sem permissão para renomear.'); return; }
    try {
      const updated = await renameCloudProject(id, newName, orgId);
      if (updated && rawProject && id === rawProject.id) setRawProject(updated);
      await refreshCloudList();
      setUndoVersion(v => v + 1);
    } catch {
      toast.error('Erro ao renomear');
    }
  };

  const handleDuplicateProject = async (id: string) => {
    if (!orgId || !creator) { toast.error('Sem permissão para duplicar.'); return; }
    try {
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
      await deleteCloudProject(id);
      const list = await refreshCloudList();
      if (rawProject && id === rawProject.id) {
        const next = list[0];
        if (next) {
          const proj = await loadCloudProject(next.id);
          if (proj) {
            setRawProject(proj);
            undoStacksRef.current = { dashboard: [], gantt: [], tasks: [], measurement: [], dailyReport: [], additive: [], materials: [], warehouse: [] };
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
            Sua conta foi criada com sucesso. Aguarde a liberação de acesso pela administração da empresa.
            Um administrador precisa autorizar seu usuário antes que você possa visualizar as obras.
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
      case 'gantt':
        return <GanttChart project={project} onProjectChange={ganttSetter} undoButton={<UndoButton canUndo={canUndo('gantt')} onUndo={() => handleUndo('gantt')} size="xs" />} />;
      case 'tasks':
        return <TaskList project={project} onProjectChange={tasksSetter} undoButton={<UndoButton canUndo={canUndo('tasks')} onUndo={() => handleUndo('tasks')} />} />;
      case 'measurement':
        return <Measurement project={project} onProjectChange={measurementSetter} undoButton={<UndoButton canUndo={canUndo('measurement')} onUndo={() => handleUndo('measurement')} />} onOpenDailyReport={handleOpenDailyReport} />;
      case 'dailyReport':
        return <DailyReport project={project} onProjectChange={dailyReportSetter} undoButton={<UndoButton canUndo={canUndo('dailyReport')} onUndo={() => handleUndo('dailyReport')} />} initialDate={dailyReportInitialDate} initialMeasurementFilter={dailyReportInitialFilter} navKey={dailyReportNavKey} />;
      case 'additive':
        return <Additive project={project} onProjectChange={additiveSetter} undoButton={<UndoButton canUndo={canUndo('additive')} onUndo={() => handleUndo('additive')} />} />;
      case 'materials':
        return <Materials project={project} onProjectChange={materialsSetter} />;
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
          onViewChange={(v) => { setCurrentView(v); setSidebarOpen(false); }}
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

      <main className="flex-1 min-h-screen overflow-y-auto relative">
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

      {orgId && <MigrationDialog organizationId={orgId} onMigrated={async () => { await refreshCloudList(); }} />}
    </div>
  );
}
