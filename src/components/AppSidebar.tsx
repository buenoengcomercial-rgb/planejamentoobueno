import { AppView } from '@/types/project';
import { LayoutDashboard, GanttChart, ListTodo, ClipboardList, HardHat, Sparkles, ChevronsLeft, ChevronsRight, FolderOpen, Plus, ChevronDown, ChevronRight, Pencil, Copy, Trash2, Check, X, MoreHorizontal, Download, Upload, FileDown, Building2, Users, NotebookPen, FilePlus2, Package, Warehouse } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { listProjects, ProjectMeta } from '@/lib/projectStorage';
import {
  exportProjectToFile,
  exportAllProjectsToFile,
  parseBackup,
  readFileAsText,
  summarizeProject,
  importProject,
  importAllProjects,
  type BackupFile,
  type ProjectSummary,
} from '@/lib/projectBackup';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import logoFull from '@/assets/logo-bueno.png';
import logoIcon from '@/assets/logo-bueno-icon.png';

interface AppSidebarProps {
  currentView: AppView;
  onViewChange: (view: AppView) => void;
  projectName: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSwitchProject: (id: string) => void;
  onCreateProject: (name?: string) => string | void | Promise<string | void>;
  onRenameProject: (id: string, newName: string) => void;
  onDuplicateProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onImportedProject?: (id: string) => void;
  activeProjectId: string;
  /** Lista vinda da nuvem; se omitida, cai no localStorage. */
  projectsList?: ProjectMeta[];
  /** Mostra botão de logout e e-mail do usuário no rodapé. */
  userEmail?: string;
  onLogout?: () => void;
  /** Identidade da empresa/organização e função do usuário. */
  orgName?: string;
  roleLabel?: string;
  /** Quando true, mostra a opção "Gerenciar acessos". */
  canManageTeam?: boolean;
  onOpenTeam?: () => void;
}

const navItems: { view: AppView; label: string; icon: React.ElementType }[] = [
  { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { view: 'gantt', label: 'Cronograma', icon: GanttChart },
  { view: 'tasks', label: 'Tarefas (EAP)', icon: ListTodo },
  { view: 'measurement', label: 'Medição', icon: ClipboardList },
  { view: 'dailyReport', label: 'Diário de Obra', icon: NotebookPen },
  { view: 'additive', label: 'Aditivo', icon: FilePlus2 },
  { view: 'materials', label: 'Lista de Material', icon: Package },
  { view: 'warehouse', label: 'Almoxarifado', icon: Warehouse },
];

const visibleNavItems = navItems
  .filter(item => item.view !== 'dailyReport')
  .map(item => item.view === 'tasks' ? { ...item, label: 'Produção diária' } : item);

export default function AppSidebar({ currentView, onViewChange, projectName, collapsed, onToggleCollapse, onSwitchProject, onCreateProject, onRenameProject, onDuplicateProject, onDeleteProject, onImportedProject, activeProjectId, projectsList, userEmail, onLogout, orgName, roleLabel, canManageTeam, onOpenTeam }: AppSidebarProps) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [showProjects, setShowProjects] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Estado de import (preview/confirmação)
  const [pendingBackup, setPendingBackup] = useState<BackupFile | null>(null);
  const [pendingSummaries, setPendingSummaries] = useState<ProjectSummary[]>([]);
  const cloudMode = !!projectsList;

  useEffect(() => {
    if (projectsList) setProjects(projectsList);
    else setProjects(listProjects());
  }, [showProjects, activeProjectId, editingId, projectsList]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const startEdit = (p: ProjectMeta) => {
    setEditingId(p.id);
    setEditingName(p.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName('');
  };

  const saveEdit = () => {
    const name = editingName.trim();
    if (!name || !editingId) {
      cancelEdit();
      return;
    }
    onRenameProject(editingId, name);
    setProjects(prev => prev.map(p => p.id === editingId ? { ...p, name } : p));
    cancelEdit();
  };

  const handleNewProject = async () => {
    setShowProjects(true);
    const newId = await onCreateProject();
    if (typeof newId === 'string') {
      setTimeout(() => {
        const list = projectsList ?? listProjects();
        const created = list.find(p => p.id === newId);
        if (created) {
          setEditingId(newId);
          setEditingName(created.name);
        }
      }, 50);
    }
  };

  const confirmedDelete = () => {
    if (confirmDeleteId) {
      onDeleteProject(confirmDeleteId);
      setConfirmDeleteId(null);
    }
  };

  const projectToDelete = projects.find(p => p.id === confirmDeleteId);

  // ===== Backup / Import =====
  const handleExportProject = (id: string) => {
    if (cloudMode) {
      toast.error('O backup por esta tela ainda está disponível apenas para obras locais. No modo nuvem, esse atalho foi bloqueado para não exportar dados errados.');
      return;
    }
    const ok = exportProjectToFile(id);
    if (ok) toast.success('Backup da obra exportado');
    else toast.error('Não foi possível exportar a obra');
  };

  const handleExportAll = () => {
    if (cloudMode) {
      toast.error('A exportação geral por esta tela ainda está disponível apenas para obras locais. No modo nuvem, esse atalho foi bloqueado para evitar mistura de dados.');
      return;
    }
    const ok = exportAllProjectsToFile();
    if (ok) toast.success('Backup geral exportado');
    else toast.error('Nenhuma obra para exportar');
  };

  const triggerImport = () => {
    if (cloudMode) {
      toast.error('A importação de backup local foi bloqueada no modo nuvem para evitar misturar obras locais com obras da empresa.');
      return;
    }
    importInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const backup = parseBackup(text);
      if (!backup) {
        toast.error('Arquivo de backup inválido ou incompatível.');
        return;
      }
      const summaries = backup.kind === 'single'
        ? [summarizeProject(backup.project)]
        : backup.projects.map(summarizeProject);
      setPendingBackup(backup);
      setPendingSummaries(summaries);
    } catch {
      toast.error('Não foi possível ler o arquivo selecionado.');
    }
  };

  const cancelImport = () => {
    setPendingBackup(null);
    setPendingSummaries([]);
  };

  const confirmImport = () => {
    if (!pendingBackup) return;
    if (cloudMode) {
      toast.error('A importação de backup local foi bloqueada no modo nuvem para evitar mistura de dados.');
      cancelImport();
      return;
    }
    try {
      if (pendingBackup.kind === 'single') {
        const saved = importProject(pendingBackup.project, { activate: true });
        setProjects(listProjects());
        toast.success(`Obra importada: ${saved.name}`);
        onImportedProject?.(saved.id);
      } else {
        const saved = importAllProjects(pendingBackup.projects);
        setProjects(listProjects());
        toast.success(`${saved.length} obra(s) importada(s)`);
        if (saved[0]) onImportedProject?.(saved[0].id);
      }
    } catch {
      toast.error('Falha ao importar o backup.');
    } finally {
      cancelImport();
    }
  };

  return (
    <aside className={`${collapsed ? 'w-16' : 'w-64'} min-h-screen flex flex-col bg-[hsl(var(--sidebar-bg))] text-[hsl(var(--sidebar-fg))] transition-all duration-300`}>
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFile}
      />
      <div className="p-3 border-b border-[hsl(var(--sidebar-border))] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 overflow-hidden min-w-0">
          {collapsed ? (
            <img src={logoIcon} alt="BUENO" className="w-9 h-7 object-contain flex-shrink-0" />
          ) : (
            <img
              src={logoFull}
              alt="BUENO Prevenção a Incêndio"
              className="h-11 w-auto object-contain bg-white rounded-md p-1 flex-shrink-0"
            />
          )}
          {!collapsed && (
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-[hsl(var(--sidebar-fg))] leading-tight">ObraPlanner</h1>
              <p className="text-[10px] opacity-60 truncate max-w-[140px]">{projectName}</p>
            </div>
          )}
        </div>
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded-md hover:bg-[hsl(var(--sidebar-hover))] transition-colors flex-shrink-0"
          title={collapsed ? 'Expandir menu' : 'Recolher menu'}
        >
          {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* Identidade da empresa */}
      {orgName && (
        <div className={`px-3 py-2 border-b border-[hsl(var(--sidebar-border))] flex items-center gap-2 ${collapsed ? 'justify-center' : ''}`}
          title={collapsed ? `${orgName}${roleLabel ? ` · ${roleLabel}` : ''}` : undefined}>
          <Building2 className="w-3.5 h-3.5 opacity-70 flex-shrink-0" />
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold truncate">{orgName}</div>
              {roleLabel && <div className="text-[10px] opacity-60 truncate">{roleLabel}</div>}
            </div>
          )}
        </div>
      )}

      {/* Seletor de projetos */}
      <div className="border-b border-[hsl(var(--sidebar-border))]">
        <div className={`flex items-center ${collapsed ? 'justify-center' : ''} hover:bg-[hsl(var(--sidebar-hover))]/40 transition-colors`}>
          <button
            onClick={() => setShowProjects(!showProjects)}
            className={`flex-1 flex items-center gap-2 px-3 py-2 text-[11px] font-medium ${collapsed ? 'justify-center' : ''}`}
            title={collapsed ? `Projetos: ${projectName}` : undefined}
          >
            <FolderOpen className="w-4 h-4 flex-shrink-0 opacity-70" />
            {!collapsed && (
              <>
                <span className="flex-1 text-left truncate uppercase tracking-wide opacity-70">Obras</span>
                {showProjects
                  ? <ChevronDown className="w-3 h-3 opacity-70" />
                  : <ChevronRight className="w-3 h-3 opacity-70" />
                }
              </>
            )}
          </button>
          {!collapsed && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="p-1.5 mr-1 rounded hover:bg-[hsl(var(--sidebar-hover))] transition-colors opacity-70 hover:opacity-100"
                  title="Mais opções"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={handleNewProject}>
                  <Plus className="w-4 h-4 mr-2" /> Nova obra
                </DropdownMenuItem>
                <DropdownMenuItem onClick={triggerImport}>
                  <Upload className="w-4 h-4 mr-2" /> {cloudMode ? 'Importar backup local' : 'Importar backup'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleExportAll}>
                  <FileDown className="w-4 h-4 mr-2" /> {cloudMode ? 'Exportar todas (local)' : 'Exportar todas'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {showProjects && !collapsed && (
          <div className="px-2 pb-2 space-y-0.5">
            {projects.map(p => {
              const isActive = p.id === activeProjectId;
              const isEditing = editingId === p.id;
              return (
                <div
                  key={p.id}
                  className={`group relative rounded text-[11px] transition-colors ${
                    isActive
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'hover:bg-[hsl(var(--sidebar-hover))] text-[hsl(var(--sidebar-fg))]'
                  }`}
                >
                  {isEditing ? (
                    <div className="flex items-center gap-1 px-1.5 py-1">
                      <input
                        ref={editInputRef}
                        value={editingName}
                        onChange={e => setEditingName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEdit();
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        className="flex-1 min-w-0 text-[11px] bg-[hsl(var(--sidebar-hover))] border border-[hsl(var(--sidebar-border))] rounded px-1.5 py-0.5 focus:outline-none focus:border-primary text-[hsl(var(--sidebar-fg))]"
                      />
                      <button
                        onClick={saveEdit}
                        title="Salvar"
                        className="p-1 rounded hover:bg-primary/20 text-primary"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                      <button
                        onClick={cancelEdit}
                        title="Cancelar"
                        className="p-1 rounded hover:bg-destructive/20 text-destructive"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center">
                      <button
                        onClick={() => onSwitchProject(p.id)}
                        className="flex-1 min-w-0 text-left px-2 py-1.5 truncate"
                        title={p.name}
                      >
                        {p.name}
                      </button>
                      <div className="flex items-center gap-0.5 pr-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => { e.stopPropagation(); startEdit(p); }}
                          title="Renomear"
                          className={`p-1 rounded ${isActive ? 'hover:bg-primary-foreground/20' : 'hover:bg-[hsl(var(--sidebar-border))]'}`}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleExportProject(p.id); }}
                          title={cloudMode ? 'Exportar obra (somente no modo local)' : 'Exportar obra'}
                          className={`p-1 rounded ${isActive ? 'hover:bg-primary-foreground/20' : 'hover:bg-[hsl(var(--sidebar-border))]'}`}
                        >
                          <Download className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (projects.length <= 1) {
                              toast.error('Não é possível excluir a única obra existente. Crie outra obra antes de excluir esta.');
                              return;
                            }
                            setConfirmDeleteId(p.id);
                          }}
                          title="Excluir obra"
                          className={`p-1 rounded ${isActive ? 'hover:bg-primary-foreground/20' : 'hover:bg-destructive/20 text-destructive'}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            <button
              onClick={handleNewProject}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-[11px] text-primary hover:bg-primary/10 transition-colors font-medium mt-1"
            >
              <Plus className="w-3 h-3" /> Nova obra
            </button>
          </div>
        )}
      </div>

      <AlertDialog open={!!confirmDeleteId} onOpenChange={(o) => !o && setConfirmDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deseja realmente excluir esta obra?</AlertDialogTitle>
            <AlertDialogDescription>
              Você está prestes a excluir a obra: <strong>{projectToDelete?.name}</strong>.
              <br /><br />
              Esta ação pode remover cronograma, tarefas, medições e demais dados vinculados a esta obra.
              Não é possível desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmedDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Excluir obra
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmação de importação de backup */}
      <AlertDialog open={!!pendingBackup} onOpenChange={(o) => !o && cancelImport()}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingBackup?.kind === 'multi'
                ? `Deseja importar ${pendingSummaries.length} obra(s)?`
                : 'Deseja importar esta obra?'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p className="text-muted-foreground">
                  Resumo do backup ({pendingBackup?.kind === 'multi' ? 'geral' : 'obra única'}):
                </p>
                <div className="max-h-64 overflow-y-auto rounded border border-border divide-y divide-border">
                  {pendingSummaries.map((s, i) => (
                    <div key={i} className="p-2.5 text-xs">
                      <div className="font-semibold text-foreground">{s.name}</div>
                      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
                        <span>Capítulos: <strong>{s.chapterCount}</strong></span>
                        <span>Tarefas: <strong>{s.taskCount}</strong></span>
                        <span>Medições: <strong>{s.measurementCount}</strong></span>
                        {s.startDate && s.endDate && (
                          <span>Período: {s.startDate} → {s.endDate}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  As obras existentes não serão alteradas. Caso já exista uma obra com o mesmo nome,
                  a importada receberá o sufixo "(importada)".
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmImport}>
              {pendingBackup?.kind === 'multi' ? 'Importar obras' : 'Importar obra'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <nav className="flex-1 p-2 space-y-1">
        {visibleNavItems.map(({ view, label, icon: Icon }) => {
          const isActive = currentView === view;
          return (
            <button
              key={view}
              onClick={() => onViewChange(view)}
              className={`w-full flex items-center ${collapsed ? 'justify-center' : ''} gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all relative`}
              title={collapsed ? label : undefined}
            >
              {isActive && (
                <motion.div
                  layoutId="sidebar-active"
                  className="absolute inset-0 bg-primary rounded-lg"
                  transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                />
              )}
              <Icon className={`w-4 h-4 relative z-10 ${isActive ? 'text-primary-foreground' : ''}`} />
              {!collapsed && (
                <span className={`relative z-10 ${isActive ? 'text-primary-foreground' : 'text-[hsl(var(--sidebar-fg))]'}`}>
                  {label}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-2 border-t border-[hsl(var(--sidebar-border))] space-y-1">
        <button
          className={`w-full flex items-center ${collapsed ? 'justify-center' : ''} gap-3 px-3 py-2.5 rounded-lg text-sm font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors`}
          title={collapsed ? 'Gerar com IA' : undefined}
        >
          <Sparkles className="w-4 h-4" />
          {!collapsed && 'Gerar com IA'}
        </button>
        {canManageTeam && onOpenTeam && (
          <button
            onClick={onOpenTeam}
            className={`w-full flex items-center ${collapsed ? 'justify-center' : ''} gap-3 px-3 py-2 rounded-lg text-xs font-medium hover:bg-[hsl(var(--sidebar-hover))] transition-colors opacity-90`}
            title={collapsed ? 'Usuários' : undefined}
          >
            <Users className="w-4 h-4" />
            {!collapsed && <span className="truncate flex-1 text-left">Usuários</span>}
          </button>
        )}
        {onLogout && (
          <button
            onClick={onLogout}
            className={`w-full flex items-center ${collapsed ? 'justify-center' : ''} gap-3 px-3 py-2 rounded-lg text-xs font-medium hover:bg-[hsl(var(--sidebar-hover))] transition-colors opacity-80`}
            title={collapsed ? `Sair (${userEmail ?? ''})` : 'Sair'}
          >
            <X className="w-4 h-4" />
            {!collapsed && (
              <span className="truncate flex-1 text-left">
                Sair{userEmail ? ` · ${userEmail}` : ''}
              </span>
            )}
          </button>
        )}
      </div>
    </aside>
  );
}
