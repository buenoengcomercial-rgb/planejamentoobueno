import { Project, Task, LaborComposition, DailyProductionLog, Phase } from '@/types/project';
import { getTeamDefinition, DEFAULT_TEAMS, TeamCode, TeamDefinition } from '@/lib/teams';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Settings2 } from 'lucide-react';
import GerenciarEquipes from '@/components/GerenciarEquipes';
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { ChevronDown, ChevronRight, Zap, Users, AlertTriangle, Plus, Trash2, Edit3, Check, X, Upload, FolderPlus, GripVertical, ClipboardList, FolderTree, ArrowUpFromLine, Folder, FileSpreadsheet } from 'lucide-react';
import ImportTasksDialog from '@/components/ImportTasksDialog';
import ImportSyntheticDialog from '@/components/ImportSyntheticDialog';
import DailyLogsPanel from '@/components/DailyLogsPanel';

import { calculateRupDuration } from '@/lib/calculations';
import { syncAdditiveProductivity } from '@/lib/additiveProductivity';
import { formatISODateBR } from '@/components/gantt/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getChapterTree, getChapterNumbering, moveChapter, getChapterTasks, safeMoveChapter, reorderChapter, reorderChapterByNumber } from '@/lib/chapters';
import { toast } from 'sonner';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { AdditiveBadge } from '@/components/shared/AdditiveBadge';
import { sortTasksForSchedule, withScheduleOrderForMove } from '@/lib/taskOrdering';
import { normalizeLaborRole } from '@/lib/laborDimensioning';

/** Encurta o nome da tarefa para no máximo `maxWords` palavras, adicionando "…" no final. */
function truncateWords(text: string, maxWords = 4): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '…';
}

interface TaskListProps {
  project: Project;
  onProjectChange: (project: Project) => void;
  undoButton?: React.ReactNode;
}

const DAILY_HOURS = 8;

/** Encurta nomes de cargos longos (ex: SINAPI) para caber na coluna de gargalo. */
/** Calcula a produção diária de uma tarefa: quantidade total / duração. */
function getDailyProduction(task: Task): string {
  if (!task.quantity || !task.duration || task.duration <= 0) return '—';
  const value = task.quantity / task.duration;
  const formatted = Number.isInteger(value) ? value.toString() : value.toFixed(1);
  return `${formatted} ${task.unit || ''}/dia`.trim();
}

function abbreviateRole(role: string): string {
  if (!role) return '';
  const cleaned = role
    .replace(/COM ENCARGOS COMPLEMENTARES/gi, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Mapeamentos comuns
  const map: Array<[RegExp, string]> = [
    [/AUXILIAR DE ENCANADOR|AUXILIAR HIDR[ÁA]ULICO|AUXILIAR DE BOMBEIRO/i, 'Aux. Encanador'],
    [/ENCANADOR|BOMBEIRO HIDR[ÁA]ULICO/i, 'Encanador'],
    [/AUXILIAR DE ELETRICISTA/i, 'Aux. Eletricista'],
    [/ELETRICISTA/i, 'Eletricista'],
    [/AJUDANTE/i, 'Ajudante'],
    [/PEDREIRO/i, 'Pedreiro'],
    [/SERVENTE/i, 'Servente'],
    [/GESSEIRO|GESSO/i, 'Gesseiro'],
    [/CARPINTEIRO/i, 'Carpinteiro'],
    [/ARMADOR/i, 'Armador'],
    [/PINTOR/i, 'Pintor'],
    [/AUXILIAR/i, 'Auxiliar'],
  ];
  for (const [re, label] of map) {
    if (re.test(cleaned)) return label;
  }
  // Fallback: pega as 2 primeiras palavras significativas
  const words = cleaned.split(' ').filter(w => w.length > 2 && !/^(DE|DO|DA|OU|COM|E)$/i.test(w));
  return words.slice(0, 2).join(' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function StatusBadge({ percent }: { percent: number }) {
  if (percent === 100) return <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-success/15 text-success">Concluído</span>;
  if (percent > 0) return <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-primary/15 text-primary">Em andamento</span>;
  return <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-muted text-muted-foreground">Pendente</span>;
}

function InlineInput({ value, onChange, type = 'text', className = '', min, max, step }: {
  value: string | number; onChange: (v: string) => void; type?: string; className?: string; min?: number; max?: number; step?: number;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      onFocus={type === 'number' ? (e) => e.currentTarget.select() : undefined}
      min={min}
      max={max}
      step={step}
      className={`bg-transparent border border-current/30 rounded px-1.5 py-0.5 text-[11px] focus:border-primary focus:outline-none transition-colors ${className}`}
    />
  );
}

export default function TaskList({ project, onProjectChange, undoButton }: TaskListProps) {
  // Lista de equipes do projeto (com fallback aos defaults).
  const projectTeams: TeamDefinition[] = project.teams ?? DEFAULT_TEAMS;
  const teamDef = useCallback((code?: TeamCode) => getTeamDefinition(code, projectTeams), [projectTeams]);
  const { confirm: confirmDelete, dialog: confirmDialog } = useConfirmDelete();
  // Estado inicial respeita a persistência (uiState.collapsedPhaseIds).
  // Se não houver registro, todos os capítulos começam expandidos.
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(() => {
    const collapsed = new Set(project.uiState?.collapsedPhaseIds ?? []);
    return new Set(project.phases.filter(p => !collapsed.has(p.id)).map(p => p.id));
  });

  // Persiste no projeto sempre que o conjunto de capítulos minimizados mudar.
  // Compara antes de propagar para evitar loop com onProjectChange → re-render.
  useEffect(() => {
    const collapsedNow = project.phases
      .filter(p => !expandedPhases.has(p.id))
      .map(p => p.id)
      .sort();
    const collapsedPrev = [...(project.uiState?.collapsedPhaseIds ?? [])].sort();
    const same =
      collapsedPrev.length === collapsedNow.length &&
      collapsedPrev.every((id, i) => id === collapsedNow[i]);
    if (same) return;
    onProjectChange({
      ...project,
      uiState: { ...(project.uiState ?? {}), collapsedPhaseIds: collapsedNow },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedPhases, project.phases]);

  const [expandedRup, setExpandedRup] = useState<string | null>(null);
  const [expandedDaily, setExpandedDaily] = useState<string | null>(null);
  const [simulating, setSimulating] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSyntheticOpen, setImportSyntheticOpen] = useState(false);
  const additiveFileRef = useRef<HTMLInputElement>(null);
  const [editingPhase, setEditingPhase] = useState<string | null>(null);
  const [phaseNameDraft, setPhaseNameDraft] = useState('');
  const [editingNumberId, setEditingNumberId] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState('');

  // Drag-and-drop state
  const [dragPhaseId, setDragPhaseId] = useState<string | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const handleDragStart = useCallback((phaseId: string, taskId: string) => {
    setDragPhaseId(phaseId);
    setDragTaskId(taskId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, targetTaskId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetId(targetTaskId);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetPhaseId: string, targetTaskId: string) => {
    e.preventDefault();
    if (!dragPhaseId || !dragTaskId || dragTaskId === targetTaskId) {
      setDragPhaseId(null);
      setDragTaskId(null);
      setDropTargetId(null);
      return;
    }

    onProjectChange(withScheduleOrderForMove(project, dragPhaseId, dragTaskId, targetPhaseId, targetTaskId));
    setDragPhaseId(null);
    setDragTaskId(null);
    setDropTargetId(null);
  }, [dragPhaseId, dragTaskId, project, onProjectChange]);

  const handleDragEnd = useCallback(() => {
    setDragPhaseId(null);
    setDragTaskId(null);
    setDropTargetId(null);
  }, []);

  const PHASE_COLORS = [
    'hsl(var(--primary))', 'hsl(var(--info))', 'hsl(var(--warning))',
    'hsl(var(--success))', 'hsl(var(--destructive))', 'hsl(210, 60%, 50%)',
    'hsl(280, 50%, 55%)', 'hsl(160, 50%, 45%)',
  ];

  const addPhase = (parentId?: string) => {
    const newId = `phase-${Date.now()}`;
    const colorIdx = project.phases.length % PHASE_COLORS.length;
    const siblings = project.phases.filter(p => (p.parentId ?? null) === (parentId ?? null));
    const order = siblings.length;
    onProjectChange({
      ...project,
      phases: [
        ...project.phases,
        {
          id: newId,
          name: parentId ? 'Novo Subcapítulo' : 'Novo Capítulo',
          color: PHASE_COLORS[colorIdx],
          tasks: [],
          parentId,
          order,
        },
      ],
    });
    // Subcapítulos novos ficam MINIMIZADOS por padrão (apenas garante o pai expandido).
    // Capítulos principais novos ficam expandidos.
    setExpandedPhases(prev => {
      const next = new Set(prev);
      if (parentId) {
        next.add(parentId);
        next.delete(newId);
      } else {
        next.add(newId);
      }
      return next;
    });
    setEditingPhase(newId);
    setPhaseNameDraft(parentId ? 'Novo Subcapítulo' : 'Novo Capítulo');
  };

  const renamePhase = (phaseId: string) => {
    if (!phaseNameDraft.trim()) return;
    onProjectChange({
      ...project,
      phases: project.phases.map(p => p.id === phaseId ? { ...p, name: phaseNameDraft.trim() } : p),
    });
    setEditingPhase(null);
  };

  const deletePhase = (phaseId: string) => {
    // Ao excluir um capítulo principal, promove os subcapítulos para principais
    onProjectChange({
      ...project,
      phases: project.phases
        .filter(p => p.id !== phaseId)
        .map(p => p.parentId === phaseId ? { ...p, parentId: undefined } : p),
    });
  };

  /** Salva numeração customizada do capítulo. Reordena automaticamente quando numérico. */
  const saveChapterNumber = useCallback((phaseId: string) => {
    const v = numberDraft.trim();
    onProjectChange(reorderChapterByNumber(project, phaseId, v));
    setEditingNumberId(null);
  }, [numberDraft, project, onProjectChange]);

  /** Move um capítulo/subcapítulo para outro pai (ou promove a principal se newParentId === null). */
  const handleMoveChapter = useCallback((chapterId: string, newParentId: string | null) => {
    const { project: nextProject, validation, applied } = safeMoveChapter(project, chapterId, newParentId);
    if (!applied) {
      // Bloqueado por violação dura — oferece "Forçar"
      const first = validation.violations[0];
      const desc = first
        ? `${first.taskName} depende de ${first.predName} (${first.type}).`
        : validation.warnings[0] ?? 'Movimentação inválida.';
      toast.error('Movimentação bloqueada', {
        description: desc,
        action: {
          label: 'Forçar',
          onClick: () => {
            const forced = safeMoveChapter(project, chapterId, newParentId, { force: true });
            if (forced.applied) {
              onProjectChange(forced.project);
              if (newParentId) setExpandedPhases(prev => new Set([...prev, newParentId]));
              toast.warning('Movimentação forçada — dependências conflitantes removidas.');
            }
          },
        },
      });
      return;
    }
    if (validation.warnings.length > 0) {
      toast.warning(validation.warnings[0]);
    }
    onProjectChange(nextProject);
    if (newParentId) setExpandedPhases(prev => new Set([...prev, newParentId]));
  }, [project, onProjectChange]);

  // Drag-and-drop de capítulos (mover/transformar em subcapítulo).
  // IMPORTANTE: o `draggable` fica APENAS no handle (GripVertical) do header.
  // Assim não conflita com o drag de tarefas filhas nem trava cliques.
  const [dragChapterId, setDragChapterId] = useState<string | null>(null);
  const [dropChapterTargetId, setDropChapterTargetId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'inside'>('inside');

  const handleChapterDragStart = useCallback((e: React.DragEvent, chapterId: string) => {
    setDragChapterId(chapterId);
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('application/x-chapter-id', chapterId);
      e.dataTransfer.setData('text/plain', chapterId);
    } catch { /* noop */ }
    document.body.classList.add('cursor-grabbing');
  }, []);

  const handleChapterDragOver = useCallback((e: React.DragEvent, targetId: string) => {
    if (!dragChapterId || dragChapterId === targetId) return;
    // Bloqueia ciclo: se o alvo é descendente do arrastado, ignora
    const isDescendantOfDragged = (() => {
      let current = project.phases.find(p => p.id === targetId);
      const visited = new Set<string>();
      while (current?.parentId) {
        if (visited.has(current.id)) return false;
        visited.add(current.id);
        if (current.parentId === dragChapterId) return true;
        current = project.phases.find(p => p.id === current!.parentId);
      }
      return false;
    })();
    if (isDescendantOfDragged) return;

    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    // Se a origem do evento é o corpo expandido do capítulo, força "inside"
    const overBody = !!(e.target as HTMLElement)?.closest?.('[data-chapter-body]');
    if (overBody) {
      setDropPosition('inside');
      setDropChapterTargetId(targetId);
      return;
    }

    // Caso contrário (header), calcula a posição.
    const dragged = project.phases.find(p => p.id === dragChapterId);
    const target = project.phases.find(p => p.id === targetId);
    const sameLevel =
      !!dragged && !!target && (dragged.parentId ?? null) === (target.parentId ?? null);

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    let pos: 'before' | 'after' | 'inside';
    if (sameLevel) {
      // Reordenação no mesmo nível (inclui subcapítulos): apenas before/after
      // pela metade — facilita acertar e nunca tenta "virar filho do irmão".
      pos = offsetY < rect.height / 2 ? 'before' : 'after';
    } else {
      // Níveis diferentes: terços (before/inside/after) — permite virar subcapítulo.
      const third = rect.height / 3;
      if (offsetY < third) pos = 'before';
      else if (offsetY > rect.height - third) pos = 'after';
      else pos = 'inside';
    }
    setDropPosition(pos);
    setDropChapterTargetId(targetId);
  }, [dragChapterId, project.phases]);

  const handleChapterDrop = useCallback((e: React.DragEvent, targetId: string | null) => {
    if (!dragChapterId) return;
    e.preventDefault();
    if (dragChapterId !== targetId) {
      if (targetId === null) {
        // Promove a principal (root)
        handleMoveChapter(dragChapterId, null);
      } else if (dropPosition === 'inside') {
        // Vira subcapítulo do alvo
        handleMoveChapter(dragChapterId, targetId);
      } else {
        // Reordena no mesmo nível do alvo (antes/depois) e limpa customNumber
        // dos irmãos para que a numeração visual reflita a nova ordem.
        const reordered = reorderChapter(project, dragChapterId, targetId, dropPosition);
        const target = reordered.phases.find(p => p.id === targetId);
        const levelParent = target?.parentId ?? null;
        const cleaned = {
          ...reordered,
          phases: reordered.phases.map(p =>
            (p.parentId ?? null) === levelParent ? { ...p, customNumber: undefined } : p,
          ),
        };
        onProjectChange(cleaned);
      }
    }
    setDragChapterId(null);
    setDropChapterTargetId(null);
    setDropPosition('inside');
  }, [dragChapterId, dropPosition, handleMoveChapter, project, onProjectChange]);

  const handleChapterDragEnd = useCallback(() => {
    setDragChapterId(null);
    setDropChapterTargetId(null);
    setDropPosition('inside');
    document.body.classList.remove('cursor-grabbing');
  }, []);

  const togglePhase = (id: string) => {
    setExpandedPhases(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const updateTask = (phaseId: string, taskId: string, updates: Partial<Task>) => {
    const updated = {
      ...project,
      phases: project.phases.map(p =>
        p.id === phaseId
          ? { ...p, tasks: p.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t) }
          : p
      ),
    };
    onProjectChange(updated);
  };

  const updateLaborComp = (phaseId: string, taskId: string, compId: string, updates: Partial<LaborComposition>) => {
    const updated = {
      ...project,
      phases: project.phases.map(p =>
        p.id === phaseId
          ? {
              ...p,
              tasks: p.tasks.map(t =>
                t.id === taskId
                  ? { ...t, laborCompositions: t.laborCompositions?.map(c => c.id === compId ? { ...c, ...updates } : c) }
                  : t
              ),
            }
          : p
      ),
    };
    onProjectChange(updated);
  };

  const addTask = (phaseId: string) => {
    const phase = project.phases.find(p => p.id === phaseId);
    if (!phase) return;
    const nextId = `t${Date.now()}`;
    const nextOrder = phase.tasks.length;
    const lastTask = phase.tasks[phase.tasks.length - 1];
    const lastEnd = lastTask ? new Date(lastTask.startDate) : new Date(project.startDate);
    if (lastTask) lastEnd.setDate(lastEnd.getDate() + lastTask.duration);

    const newTask: Task = {
      id: nextId,
      name: 'Nova atividade',
      phase: phase.name,
      contractOrder: nextOrder,
      scheduleOrder: nextOrder,
      startDate: lastEnd.toISOString().split('T')[0],
      duration: 5,
      dependencies: lastTask ? [lastTask.id] : [],
      // TI por padrão para que a propagação automática alinhe a nova tarefa ao fim da anterior.
      dependencyDetails: lastTask ? [{ taskId: lastTask.id, type: 'TI' }] : [],
      responsible: '',
      percentComplete: 0,
      level: 0,
      quantity: 100,
      unit: 'un',
      materials: [],
      laborCompositions: [
        { id: `lc-${Date.now()}`, role: 'Servente', rup: 0.5, workerCount: 1 },
      ],
    };

    onProjectChange({
      ...project,
      phases: project.phases.map(p =>
        p.id === phaseId ? { ...p, tasks: [...p.tasks, newTask] } : p
      ),
    });
    setEditingTask(nextId);
  };

  const duplicateTask = (phaseId: string, task: Task) => {
    const newId = `t${Date.now()}`;
    const targetPhase = project.phases.find(p => p.id === phaseId);
    const nextOrder = targetPhase?.tasks.length ?? 0;
    const dup: Task = {
      ...task,
      id: newId,
      name: `${task.name} (cópia)`,
      contractOrder: nextOrder,
      scheduleOrder: nextOrder,
      percentComplete: 0,
      laborCompositions: task.laborCompositions?.map(c => ({ ...c, id: `lc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` })),
      materials: task.materials.map(m => ({ ...m, id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status: 'pendente' as const })),
    };
    onProjectChange({
      ...project,
      phases: project.phases.map(p =>
        p.id === phaseId ? { ...p, tasks: [...p.tasks, dup] } : p
      ),
    });
  };

  const deleteTask = (phaseId: string, taskId: string) => {
    onProjectChange({
      ...project,
      phases: project.phases.map(p =>
        p.id === phaseId
          ? {
              ...p,
              tasks: p.tasks.filter(t => t.id !== taskId).map(t => ({
                ...t,
                dependencies: t.dependencies.filter(d => d !== taskId),
              })),
            }
          : p
      ),
    });
    if (expandedRup === taskId) setExpandedRup(null);
    if (editingTask === taskId) setEditingTask(null);
  };

  const addLabor = (phaseId: string, taskId: string) => {
    const newComp: LaborComposition = {
      id: `lc-${Date.now()}`,
      role: 'Servente',
      rup: 0.5,
      workerCount: 1,
    };
    const updated = {
      ...project,
      phases: project.phases.map(p =>
        p.id === phaseId
          ? { ...p, tasks: p.tasks.map(t => t.id === taskId ? { ...t, laborCompositions: [...(t.laborCompositions || []), newComp] } : t) }
          : p
      ),
    };
    onProjectChange(updated);
  };

  const removeLabor = (phaseId: string, taskId: string, compId: string) => {
    const updated = {
      ...project,
      phases: project.phases.map(p =>
        p.id === phaseId
          ? { ...p, tasks: p.tasks.map(t => t.id === taskId ? { ...t, laborCompositions: t.laborCompositions?.filter(c => c.id !== compId) } : t) }
          : p
      ),
    };
    onProjectChange(updated);
  };

  const doubleTeam = (phaseId: string, taskId: string) => {
    const updated = {
      ...project,
      phases: project.phases.map(p =>
        p.id === phaseId
          ? {
              ...p,
              tasks: p.tasks.map(t =>
                t.id === taskId
                  ? { ...t, laborCompositions: t.laborCompositions?.map(c => ({ ...c, workerCount: c.workerCount * 2 })) }
                  : t
              ),
            }
          : p
      ),
    };
    onProjectChange(updated);
  };

  const simulateDouble = (task: Task) => {
    if (!task.laborCompositions?.length || !task.quantity) return null;
    const doubled = { ...task, laborCompositions: task.laborCompositions.map(c => ({ ...c, workerCount: c.workerCount * 2 })) };
    return calculateRupDuration(doubled);
  };

  const syncAdditiveRup = () => {
    const result = syncAdditiveProductivity(project);
    if (result.updated > 0) {
      onProjectChange(result.project);
      toast.success(
        `${result.updated} composiÃ§Ã£o(Ãµes) do aditivo receberam RUP pela mÃ£o de obra classificada.`,
      );
      if (result.withoutLabor > 0 || result.preserved > 0) {
        toast.info(
          `${result.withoutLabor} sem mÃ£o de obra classificada; ${result.preserved} preservada(s) por jÃ¡ terem produtividade.`,
        );
      }
      return;
    }
    toast.info(
      `Nenhuma tarefa foi atualizada. ${result.withoutLabor} sem mÃ£o de obra classificada; ${result.preserved} jÃ¡ tinham produtividade.`,
    );
  };

  // Get all task IDs for dependency dropdown
  const allTasks = project.phases.flatMap(p => p.tasks);

  // Memoiza árvore/numeração para evitar recomputação a cada toggle.
  const chapterTree = useMemo(() => getChapterTree(project), [project.phases]);
  const chapterNumbering = useMemo(() => getChapterNumbering(project), [project.phases]);
  const mainChapters = useMemo(() => project.phases.filter(p => !p.parentId), [project.phases]);
  const orderedMainChapters = useMemo(() => {
    const mains = project.phases
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => !p.parentId);
    return mains
      .sort((a, b) => {
        const ao = a.p.order ?? a.idx;
        const bo = b.p.order ?? b.idx;
        if (ao !== bo) return ao - bo;
        return a.idx - b.idx;
      })
      .map(({ p }) => p);
  }, [project.phases]);

  return (
    <div
      className="p-6 space-y-4 overflow-x-hidden w-full max-w-full"
      onDragOver={e => { if (dragChapterId) e.preventDefault(); }}
    >
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Estrutura Analítica (EAP)</h2>
          <p className="text-sm text-muted-foreground mt-1">Tarefas com cálculo RUP e composição de mão de obra</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {undoButton}
          <button
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors shadow-sm"
            title="Importa EAP, RUP, mão de obra e quantidades. Não importa valores financeiros."
          >
            <Upload className="w-4 h-4" /> Importar Produtividade
          </button>
          <button
            onClick={() => setImportSyntheticOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-success text-success-foreground font-medium text-sm hover:bg-success/90 transition-colors shadow-sm"
            title="Importa a planilha Sintética do orçamento (alimenta a aba Medição). BDI lido em J8."
          >
            <FileSpreadsheet className="w-4 h-4" /> Importar Sintética
          </button>
          <button
            onClick={() => additiveFileRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-warning text-warning-foreground font-medium text-sm hover:bg-warning/90 transition-colors shadow-sm"
            title="Importa Sintética + Analítica do orçamento de aditivo (alimenta a aba Aditivo)."
          >
            <ArrowUpFromLine className="w-4 h-4" /> Importar Analítica / Aditivo
          </button>
          <button
            onClick={syncAdditiveRup}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-warning/40 bg-warning/10 text-warning font-medium text-sm hover:bg-warning/20 transition-colors shadow-sm"
            title="Preenche RUP das composicoes do aditivo usando apenas insumos classificados como Mao de obra na Lista de Material."
          >
            <Zap className="w-4 h-4" /> Atualizar RUP do Aditivo
          </button>
          <input
            ref={additiveFileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                toast.loading('Importando aditivo...', { id: 'imp-add-tl' });
                const { importAdditiveFromExcel } = await import('@/lib/additiveImport');
                const base = f.name.replace(/\.(xlsx|xls)$/i, '');
                // Localiza um aditivo em rascunho com composições para mesclar a Analítica.
                const draftAdditive =
                  (project.additives ?? []).find(
                    a => (a.status ?? 'rascunho') === 'rascunho' && a.compositions.length > 0,
                  ) ?? null;
                const result = await importAdditiveFromExcel(f, base || 'Aditivo', draftAdditive);

                if (result.mode === 'analytic_only' && draftAdditive) {
                  // Mescla no aditivo existente — preserva id e name
                  const merged = result.additive;
                  onProjectChange({
                    ...project,
                    additives: (project.additives ?? []).map(a =>
                      a.id === draftAdditive.id
                        ? { ...merged, id: draftAdditive.id, name: draftAdditive.name }
                        : a,
                    ),
                  });
                  toast.success(
                    `${result.message} Vinculada ao aditivo "${draftAdditive.name}".`,
                    { id: 'imp-add-tl' },
                  );
                } else if (result.mode === 'analytic_only' && !draftAdditive) {
                  toast.warning(
                    'Importe a Sintética do Aditivo primeiro para vincular a Analítica.',
                    { id: 'imp-add-tl' },
                  );
                } else {
                  // synthetic_only ou both — cria novo aditivo
                  const additive = result.additive;
                  onProjectChange({ ...project, additives: [...(project.additives ?? []), additive] });
                  toast.success(
                    `${result.message} (${additive.compositions.length} composições). Abra a aba Aditivo para revisar.`,
                    { id: 'imp-add-tl' },
                  );
                }
              } catch (err) {
                console.error(err);
                toast.error('Falha ao importar aditivo.', { id: 'imp-add-tl' });
              } finally {
                if (additiveFileRef.current) additiveFileRef.current.value = '';
              }
            }}
          />
          <button
            onClick={() => addPhase()}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-border bg-card text-foreground font-medium text-sm hover:bg-muted/50 transition-colors shadow-sm"
          >
            <FolderPlus className="w-4 h-4" /> Novo Capítulo
          </button>
        </div>
      </div>

      <ImportTasksDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        project={project}
        onProjectChange={onProjectChange}
      />

      <ImportSyntheticDialog
        open={importSyntheticOpen}
        onClose={() => setImportSyntheticOpen(false)}
        project={project}
        onProjectChange={onProjectChange}
      />

      {/* Legenda de equipes */}
      <div className="flex flex-wrap items-center gap-3 px-2 py-2 bg-card rounded-lg border border-border">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mr-1">Equipes:</span>
        {projectTeams.map(def => (
          <div key={def.code} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: def.bgColor, border: `1px solid ${def.borderColor}` }} />
            <span className="text-[10px] font-medium text-foreground">{def.label}</span>
            <span className="text-[9px] text-muted-foreground">({def.composition})</span>
          </div>
        ))}
        <Popover>
          <PopoverTrigger asChild>
            <button className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border text-[10px] text-muted-foreground hover:text-primary hover:border-primary transition-colors">
              <Settings2 className="w-3 h-3" /> Gerenciar
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[480px] p-3" align="end">
            <div className="text-[11px] font-semibold text-foreground mb-2">Gerenciar Equipes</div>
            <GerenciarEquipes project={project} onProjectChange={onProjectChange} />
          </PopoverContent>
        </Popover>
      </div>

      {(() => {
        const tree = chapterTree;
        const numbering = chapterNumbering;

        const renderActionButtons = (phase: Phase, isSub: boolean) => (
          <>
            {editingPhase === phase.id ? (
              <button onClick={() => renamePhase(phase.id)} className="h-7 w-7 flex items-center justify-center rounded hover:bg-success/20 text-success transition-colors flex-shrink-0" title="Salvar nome">
                <Check className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={() => { setEditingPhase(phase.id); setPhaseNameDraft(phase.name); }}
                className="h-7 w-7 flex items-center justify-center rounded hover:bg-primary/20 text-muted-foreground hover:text-primary transition-colors flex-shrink-0"
                title="Renomear capítulo"
              >
                <Edit3 className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => confirmDelete(
                {
                  title: 'Deseja realmente excluir este capítulo?',
                  description: (
                    <>
                      <p>Capítulo: <strong>{phase.name}</strong>.</p>
                      <p>
                        Tarefas, composições RUP, apontamentos diários e demais dados vinculados
                        a este capítulo poderão ser removidos. Subcapítulos serão promovidos a principais.
                      </p>
                    </>
                  ),
                  confirmLabel: 'Excluir capítulo',
                },
                () => deletePhase(phase.id),
              )}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors flex-shrink-0"
              title="Excluir capítulo"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </>
        );

        // Renderiza um cartão de capítulo (com suas tarefas dentro). Reaproveita o layout existente.
        const renderPhaseCard = (phase: Phase, pi: number, isSub: boolean, depth: number = 0) => {
          const phaseProgress = phase.tasks.length ? Math.round(phase.tasks.reduce((s, t) => s + t.percentComplete, 0) / phase.tasks.length) : 0;
          const isExpanded = expandedPhases.has(phase.id);
          const hasCritical = phase.tasks.some(t => t.isCritical);
          const num = numbering.get(phase.id) || '';
          const isDropTarget = dropChapterTargetId === phase.id && dragChapterId !== phase.id;
          const isMainChapter = !phase.parentId;
          // Hierarquia apenas por tipografia/indentação — fundos do tema (mesma lógica do Gantt).
          const headerBgClass = isMainChapter ? 'bg-muted/50' : 'bg-muted/30';

          return (
            <div
              key={phase.id}
              className={isSub ? 'ml-6' : ''}
            >
            <div
              onDragOver={e => handleChapterDragOver(e, phase.id)}
              onDrop={e => handleChapterDrop(e, phase.id)}
              className={`relative bg-card rounded-xl border shadow-sm overflow-hidden transition-all ${
                isDropTarget && dropPosition === 'inside' ? 'border-primary ring-4 ring-primary' :
                isDropTarget ? 'border-primary ring-2 ring-primary/40' : 'border-border'
              } ${dragChapterId === phase.id ? 'opacity-40 scale-[0.98]' : ''}`}
            >
              {isDropTarget && dropPosition === 'inside' && (
                <div className="absolute top-1 right-2 z-10 px-2 py-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold shadow-md pointer-events-none">
                  ➜ Virará subcapítulo de [{num}] {truncateWords(phase.name, 3)}
                </div>
              )}
              <div
                className={`flex items-center relative ${
                  isDropTarget && dropPosition === 'before' ? 'before:absolute before:top-0 before:left-0 before:right-0 before:h-0.5 before:bg-primary' : ''
                } ${
                  isDropTarget && dropPosition === 'after' ? 'after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary' : ''
                }`}
                onDragOver={e => handleChapterDragOver(e, phase.id)}
                onDrop={e => handleChapterDrop(e, phase.id)}
              >
                <div
                  draggable
                  onDragStart={e => handleChapterDragStart(e, phase.id)}
                  onDragEnd={handleChapterDragEnd}
                  className={`flex-1 min-w-0 flex items-center gap-3 px-5 py-2.5 ${headerBgClass} text-foreground transition-colors duration-200 ease-out hover:bg-muted/70 cursor-move`}
                  title="Arraste para mover/reordenar este capítulo"
                >
                  <GripVertical className="w-3.5 h-3.5 text-muted-foreground/60 flex-shrink-0" />
                  <button
                    onClick={e => { e.stopPropagation(); togglePhase(phase.id); }}
                    onMouseDown={e => e.stopPropagation()}
                    onDragStart={e => e.preventDefault()}
                    draggable={false}
                    className="flex-shrink-0 hover:text-primary transition-colors"
                    title={isExpanded ? 'Recolher' : 'Expandir'}
                  >
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                  </button>
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: phase.color }} />
                  {editingNumberId === phase.id ? (
                    <input
                      autoFocus
                      value={numberDraft}
                      onChange={e => setNumberDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveChapterNumber(phase.id); if (e.key === 'Escape') setEditingNumberId(null); }}
                      onBlur={() => saveChapterNumber(phase.id)}
                      onClick={e => e.stopPropagation()}
                      onMouseDown={e => e.stopPropagation()}
                      onDragStart={e => e.preventDefault()}
                      className="text-[11px] font-bold text-foreground bg-transparent border border-primary rounded px-1 py-0 w-14 tabular-nums focus:outline-none"
                      placeholder={String(pi + 1)}
                    />
                  ) : (
                    <button
                      onClick={e => { e.stopPropagation(); setEditingNumberId(phase.id); setNumberDraft(phase.customNumber ?? num); }}
                      onMouseDown={e => e.stopPropagation()}
                      onDragStart={e => e.preventDefault()}
                      draggable={false}
                      className="text-[11px] font-bold text-muted-foreground tabular-nums hover:text-primary hover:bg-primary/10 rounded px-1 py-0.5 transition-colors"
                      title="Clique para editar a numeração"
                    >
                      {num}
                    </button>
                  )}
                  {editingPhase === phase.id ? (
                    <div className="flex items-center gap-2 flex-1 min-w-0" onClick={e => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={phaseNameDraft}
                        onChange={e => setPhaseNameDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') renamePhase(phase.id); if (e.key === 'Escape') setEditingPhase(null); }}
                        onMouseDown={e => e.stopPropagation()}
                        onDragStart={e => e.preventDefault()}
                        className="text-sm font-bold text-foreground bg-transparent border border-primary rounded px-1.5 py-0.5 focus:outline-none w-40"
                      />
                      <select
                        value={phase.parentId ?? ''}
                        onChange={e => handleMoveChapter(phase.id, e.target.value || null)}
                        className="max-w-[10rem] truncate text-[10px] h-7 px-1.5 py-1 rounded border border-border bg-card text-foreground hover:border-primary focus:outline-none focus:border-primary cursor-pointer"
                        title="Mover para outro capítulo"
                        onClick={e => e.stopPropagation()}
                      >
                        <option value="">— Capítulo principal —</option>
                        {orderedMainChapters.filter(c => c.id !== phase.id).map(c => {
                          const cnum = numbering.get(c.id) ?? '';
                          const shortLabel = `${cnum} - ${truncateWords(c.name, 3)}`.trim();
                          return (
                            <option key={c.id} value={c.id} title={`${cnum} - ${c.name}`}>
                              {shortLabel}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  ) : (
                    <span
                      className="truncate text-foreground"
                      style={{
                        fontSize: isMainChapter ? 15 : 13,
                        fontWeight: isMainChapter ? 800 : 700,
                        letterSpacing: isMainChapter ? '0.01em' : 0,
                      }}
                    >{phase.name}</span>
                  )}
                  {hasCritical && <AlertTriangle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />}
                  <span className="text-xs text-muted-foreground ml-1 flex-shrink-0">({phase.tasks.length})</span>
                  <div className="ml-auto flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs font-bold text-muted-foreground w-8 text-right">{phaseProgress}%</span>
                  </div>
                </div>

                <div className="flex items-center gap-1 mr-2 flex-shrink-0 min-w-0 max-w-[260px]" onMouseDown={e => e.stopPropagation()}>
                  {renderActionButtons(phase, isSub)}
                </div>
                <button
                  onClick={() => addTask(phase.id)}
                  onMouseDown={e => e.stopPropagation()}
                  className="mr-4 flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-md bg-primary/10 text-primary font-medium hover:bg-primary/20 transition-colors"
                  title="Adicionar tarefa"
                >
                  <Plus className="w-3 h-3" /> Tarefa
                </button>
              </div>

              {isExpanded && (
                <div className="overflow-hidden" data-chapter-body>
                     <div className="border-t border-border overflow-x-hidden">
                       <div className="w-full">
                       {phase.tasks.length > 0 && (
                         <div className="grid gap-1.5 px-3 py-2 bg-secondary/50 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider" style={{ gridTemplateColumns: '36px 4fr 90px 100px 80px 90px 80px 120px 80px' }}>
                           <div>Eq.</div>
                           <div>Tarefa</div>
                           <div>Qtd.</div>
                           <div className="text-center">Prod./dia</div>
                           <div>Duração</div>
                           <div>Gargalo</div>
                           <div>Depend.</div>
                           <div>Progresso</div>
                           <div>Ações</div>
                         </div>
                       )}

                      {sortTasksForSchedule(phase.tasks).map(task => {
                        const endDate = new Date(task.startDate);
                        // Fim = último dia trabalhado = start + (duration − 1)
                        endDate.setDate(endDate.getDate() + Math.max(0, task.duration - 1));
                        const isDelayed = endDate < new Date() && task.percentComplete < 100;
                        const showRup = expandedRup === task.id;
                        const sim = simulating === task.id ? simulateDouble(task) : null;
                        const isEditing = editingTask === task.id;

                        return (
                          <div
                            key={task.id}
                            draggable
                            onDragStart={() => handleDragStart(phase.id, task.id)}
                            onDragOver={(e) => handleDragOver(e, task.id)}
                            onDrop={(e) => handleDrop(e, phase.id, task.id)}
                            onDragEnd={handleDragEnd}
                            className={`${dropTargetId === task.id && dragTaskId !== task.id ? 'border-t-2 border-t-primary' : ''} ${dragTaskId === task.id ? 'opacity-40' : ''}`}
                          >
                            {(() => {
                              const rowTeam = teamDef(task.team);
                              return (
                            <div
                              onClick={(e) => {
                                // Só dispara se o clique for em área neutra da linha
                                // (não em inputs, selects, botões, links etc.)
                                const target = e.target as HTMLElement;
                                if (target.closest('button, input, select, textarea, a, [role="button"]')) return;
                                // Abre Apontamento Diário desta tarefa, fecha o RUP da mesma tarefa
                                setExpandedDaily(prev => (prev === task.id ? null : task.id));
                                if (expandedRup === task.id) setExpandedRup(null);
                              }}
                              className={`group grid gap-1.5 px-3 py-1.5 border-t border-border hover:brightness-110 transition-colors items-center cursor-pointer ${
                                expandedDaily === task.id ? 'ring-1 ring-info/40 bg-info/[0.04]' : ''
                              } ${
                                !rowTeam ? (isDelayed ? 'bg-destructive/5' : task.isCritical ? 'bg-destructive/[0.03]' : '') : ''
                              }`}
                              style={{ gridTemplateColumns: '36px 4fr 90px 100px 80px 90px 80px 120px 80px', ...(rowTeam ? { backgroundColor: rowTeam.bgColor, color: rowTeam.textColor } : {}) }}
                            >
                              {/* Equipe inicial */}
                              <div className="flex items-center justify-center">
                                <select
                                  value={task.team || ''}
                                  onChange={e => updateTask(phase.id, task.id, { team: (e.target.value || undefined) as TeamCode | undefined })}
                                  className="w-8 h-7 text-[10px] font-bold text-center rounded cursor-pointer border-0 appearance-none"
                                  style={rowTeam
                                    ? { backgroundColor: rowTeam.bgColor, color: rowTeam.textColor, border: `2px solid ${rowTeam.borderColor}` }
                                    : { backgroundColor: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }
                                  }
                                  title="Selecionar equipe"
                                >
                                  <option value="">—</option>
                                  {projectTeams.map(def => (
                                    <option key={def.code} value={def.code}>{def.label.charAt(0)}</option>
                                  ))}
                                </select>
                              </div>
                              {/* Nome */}
                              <div className="flex items-center gap-1 min-w-0">
                                {task.isCritical && <div className="w-1.5 h-1.5 rounded-full bg-destructive flex-shrink-0" />}
                                {isEditing ? (
                                  <InlineInput
                                    value={task.name}
                                    onChange={v => updateTask(phase.id, task.id, { name: v })}
                                    className="flex-1 min-w-0"
                                  />
                                ) : (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span
                                        className={`text-xs font-medium truncate text-left transition-colors cursor-pointer ${rowTeam ? 'hover:opacity-70' : 'text-foreground hover:text-primary'}`}
                                      >
                                        {truncateWords(task.name, 8)}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-md whitespace-normal break-words">
                                      {task.name}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                                <AdditiveBadge
                                  originAdditiveId={task.originAdditiveId}
                                  originAdditiveName={task.originAdditiveName}
                                  originAdditiveVersion={task.originAdditiveVersion}
                                  additiveHistory={task.additiveHistory}
                                  suppressedByAdditive={task.suppressedByAdditive}
                                  className="ml-1"
                                />

                              </div>

                              {/* Quantidade + Unidade */}
                              <div className="flex items-center gap-0.5">
                                {isEditing ? (
                                  <>
                                    <InlineInput
                                      value={task.quantity || 0}
                                      onChange={v => updateTask(phase.id, task.id, { quantity: Number(v) })}
                                      type="number"
                                      min={0}
                                      className="w-12"
                                    />
                                    <InlineInput
                                      value={task.unit || ''}
                                      onChange={v => updateTask(phase.id, task.id, { unit: v })}
                                      className="w-8"
                                    />
                                  </>
                                ) : (
                                  <span className={`text-[10px] ${rowTeam ? 'opacity-70' : 'text-muted-foreground'}`}>{task.quantity ? `${task.quantity} ${task.unit}` : '—'}</span>
                                )}
                              </div>

                              {/* Produção Diária (auto) */}
                              <div className={`text-[10px] font-medium text-center ${rowTeam ? 'opacity-90' : 'text-foreground'}`}>
                                {getDailyProduction(task)}
                              </div>

                              {/* Duração (auto) */}
                              <div className={`text-[10px] font-bold flex items-center gap-1 ${rowTeam ? '' : 'text-foreground'}`}>
                                {(() => {
                                  const dev = task.baseline ? task.duration - task.baseline.duration : 0;
                                  const showAlert = !!task.baseline && Math.abs(dev) > 2;
                                  return (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="cursor-help flex items-center gap-1">
                                          <span>{task.duration}d</span>
                                          {showAlert && <AlertTriangle className={`w-3 h-3 ${dev > 0 ? 'text-destructive' : 'text-success'}`} />}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="top" className="text-[10px] space-y-0.5">
                                        {task.baseline ? (
                                          <>
                                            <div><strong>Base:</strong> {formatISODateBR(task.baseline.startDate)} → {formatISODateBR(task.baseline.endDate)} ({task.baseline.duration}d)</div>
                                            <div><strong>Previsto:</strong> {formatISODateBR(task.current?.startDate ?? task.startDate)} → {formatISODateBR(task.current?.forecastEndDate ?? task.current?.endDate ?? task.startDate)} ({task.current?.duration ?? task.duration}d)</div>
                                            <div><strong>Desvio:</strong> {dev > 0 ? '+' : ''}{dev} dias</div>
                                            {task.accumulatedDelayQuantity !== undefined && (
                                              <div><strong>Saldo acumulado:</strong> {task.accumulatedDelayQuantity.toFixed(1)} {task.unit || 'un'}</div>
                                            )}
                                            {task.executedQuantityTotal !== undefined && (
                                              <div><strong>Executado:</strong> {task.executedQuantityTotal.toFixed(1)} {task.unit || 'un'}</div>
                                            )}
                                          </>
                                        ) : (
                                          <div>Duração: {task.duration} dias</div>
                                        )}
                                      </TooltipContent>
                                    </Tooltip>
                                  );
                                })()}
                              </div>

                              {/* Gargalo */}
                              <div className="">
                                {task.bottleneckRole ? (
                                  <span
                                    title={task.bottleneckRole}
                                    className={`text-[9px] px-1 py-0.5 rounded font-medium truncate block text-center ${rowTeam ? 'bg-white/20' : 'bg-warning/15 text-warning'}`}
                                  >
                                    {abbreviateRole(task.bottleneckRole)}
                                  </span>
                                ) : <span className={`text-[10px] ${rowTeam ? 'opacity-60' : 'text-muted-foreground'}`}>—</span>}
                              </div>

                              {/* Dependências */}
                              <div className="min-w-0">
                                {isEditing ? (
                                  <select
                                    multiple
                                    value={task.dependencies}
                                    onChange={e => {
                                      const selected = Array.from(e.target.selectedOptions, o => o.value);
                                      updateTask(phase.id, task.id, { dependencies: selected });
                                    }}
                                    className="w-full text-[9px] bg-transparent border border-current/30 rounded px-1 py-0.5"
                                    style={rowTeam ? { color: 'inherit' } : undefined}
                                  >
                                    {allTasks.filter(t => t.id !== task.id).map(t => (
                                      <option key={t.id} value={t.id}>{t.name}</option>
                                    ))}
                                  </select>
                                ) : task.dependencies.length > 0 ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold cursor-help ${rowTeam ? 'bg-white/20' : 'bg-muted text-muted-foreground'}`}>
                                        {task.dependencies.length} dep
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-xs whitespace-normal">
                                      {task.dependencies.map(d => allTasks.find(t => t.id === d)?.name || d).join(' • ')}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  <span className={`text-[9px] ${rowTeam ? 'opacity-60' : 'text-muted-foreground'}`}>—</span>
                                )}
                              </div>

                              {/* Progresso */}
                              <div className="">
                                <div className="flex items-center gap-1">
                                  <div className={`flex-1 h-1.5 rounded-full overflow-hidden ${rowTeam ? 'bg-white/20' : 'bg-muted'}`}>
                                    <div
                                      className={`h-full rounded-full transition-all ${rowTeam ? 'bg-white/70' : (isDelayed ? 'bg-destructive' : 'bg-primary')}`}
                                      style={{ width: `${task.percentComplete}%` }}
                                    />
                                  </div>
                                  <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={task.percentComplete}
                                    onFocus={e => e.currentTarget.select()}
                                    onChange={e => updateTask(phase.id, task.id, { percentComplete: Math.min(100, Math.max(0, Number(e.target.value))) })}
                                    className={`w-9 text-[10px] font-bold text-center bg-transparent border rounded px-0.5 py-0.5 ${rowTeam ? 'border-current/30' : 'border-border'}`}
                                    style={rowTeam ? { color: 'inherit' } : undefined}
                                  />
                                </div>
                              </div>

                              {/* Ações */}
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => {
                                    setExpandedRup(expandedRup === task.id ? null : task.id);
                                    if (expandedDaily === task.id) setExpandedDaily(null);
                                  }}
                                  className={`p-1 rounded transition-colors ${expandedRup === task.id ? 'bg-warning/30 text-warning' : 'hover:bg-warning/20 text-warning'}`}
                                  title="Ver composição RUP"
                                >
                                  <Zap className="w-3 h-3" />
                                </button>
                                <button
                                  onClick={() => confirmDelete(
                                    {
                                      title: 'Deseja realmente excluir esta tarefa?',
                                      description: (
                                        <>
                                          <p>Tarefa: <strong>{task.name}</strong>.</p>
                                          <p>
                                            Serão removidos: composição RUP, apontamentos diários,
                                            vínculo com cronograma e dados que podem impactar medições futuras.
                                          </p>
                                        </>
                                      ),
                                      confirmLabel: 'Excluir tarefa',
                                    },
                                    () => deleteTask(phase.id, task.id),
                                  )}
                                  className="p-1 rounded hover:bg-destructive/20 text-destructive transition-colors"
                                  title="Excluir tarefa"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                                <div className="hidden group-hover:flex items-center gap-1">
                                  {isEditing ? (
                                    <button onClick={() => setEditingTask(null)} className="p-1 rounded hover:bg-success/20 text-success transition-colors" title="Salvar">
                                      <Check className="w-3 h-3" />
                                    </button>
                                  ) : (
                                    <button onClick={() => { setEditingTask(task.id); setExpandedRup(task.id); }} className="p-1 rounded hover:bg-primary/20 text-primary transition-colors" title="Editar">
                                      <Edit3 className="w-3 h-3" />
                                    </button>
                                  )}
                                  
                                </div>
                              </div>
                            </div>
                              );
                            })()}

                            {/* RUP detail panel */}
                            {showRup && task.laborCompositions?.length !== undefined && (
                              <div className="overflow-hidden border-t border-border bg-muted/20">
                                  <div className="px-8 py-3 space-y-3">
                                    <div className="grid grid-cols-4 gap-2 mb-1 p-2 bg-muted/30 rounded text-[10px]">
                                      <div><span className="text-muted-foreground">Responsável:</span> {task.responsible || '—'}</div>
                                      <div><span className="text-muted-foreground">Horas:</span> {Math.round(task.totalHours || task.duration * DAILY_HOURS)}h</div>
                                      <div><span className="text-muted-foreground">Folga:</span> {task.float !== undefined ? `${task.float}d` : '—'}</div>
                                      <div><span className="text-muted-foreground">Desvio:</span> {task.baseline ? `${task.duration - task.baseline.duration > 0 ? '+' : ''}${task.duration - task.baseline.duration}d` : '—'}</div>
                                    </div>
                                    <h4 className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
                                      <Zap className="w-3.5 h-3.5 text-warning" />
                                      Composição RUP — {task.quantity} {task.unit}
                                    </h4>

                                    <div className="grid grid-cols-7 gap-2 text-[10px] font-semibold text-muted-foreground uppercase">
                                      <div>
                                        <button
                                          onClick={() => addLabor(phase.id, task.id)}
                                          className="text-[10px] font-semibold uppercase text-primary hover:text-primary/80 flex items-center gap-1 transition-colors"
                                          title="Adicionar profissional"
                                        >
                                          <Plus className="w-3 h-3" /> Profissional
                                        </button>
                                      </div>
                                      <div className="text-center">Cargo normalizado</div>
                                      <div className="text-center">RUP (h/{task.unit})</div>
                                      <div className="text-center">Qtd. Trab.</div>
                                      <div className="text-center">Tempo total</div>
                                      <div className="text-center">Tempo efetivo</div>
                                      <div className="text-center">Ação</div>
                                    </div>

                                    {(task.laborCompositions || []).map(comp => {
                                      const totalH = (task.quantity || 0) * comp.rup;
                                      const effectiveH = totalH / comp.workerCount;
                                      const isBottleneck = comp.role === task.bottleneckRole;
                                      return (
                                        <div key={comp.id} className={`grid grid-cols-7 gap-2 text-[11px] items-center py-1 ${isBottleneck ? 'text-warning font-semibold' : 'text-foreground'}`}>
                                          <div className="flex items-center gap-1">
                                            <Users className="w-3 h-3" />
                                            {isEditing ? (
                                              <InlineInput
                                                value={comp.role}
                                                onChange={v => updateLaborComp(phase.id, task.id, comp.id, { role: v })}
                                                className="w-24"
                                              />
                                            ) : (
                                              <>
                                                {comp.role}
                                                {isBottleneck && <span className="text-[8px] bg-warning/20 text-warning px-1 rounded">GARGALO</span>}
                                              </>
                                            )}
                                          </div>
                                          {(() => {
                                            const normalized = normalizeLaborRole(project, {
                                              originalRole: comp.originalRole || comp.role,
                                              parentComposition: task.name,
                                              unit: task.unit,
                                            });
                                            const label = normalized.type === 'cargo_operacional'
                                              ? normalized.roleName
                                              : normalized.type === 'custo_acessorio'
                                                ? 'Custo acessório'
                                                : normalized.type === 'ignorar_no_dimensionamento'
                                                  ? 'Ignorado'
                                                  : 'Revisar';
                                            return (
                                              <div className={`text-center rounded px-1 py-0.5 ${
                                                normalized.type === 'revisar_manualmente'
                                                  ? 'bg-warning/10 text-warning'
                                                  : 'bg-primary/10 text-primary'
                                              }`}>
                                                {label}
                                              </div>
                                            );
                                          })()}
                                          <div className="text-center">
                                            {isEditing ? (
                                              <InlineInput
                                                value={comp.rup}
                                                onChange={v => updateLaborComp(phase.id, task.id, comp.id, { rup: Math.max(0.01, Number(v)) })}
                                                type="number"
                                                step={0.01}
                                                min={0.01}
                                                className="w-14 text-center"
                                              />
                                            ) : comp.rup}
                                          </div>
                                          <div className="text-center">
                                            <input
                                              type="number"
                                              min={1}
                                              value={comp.workerCount}
                                              onFocus={e => e.currentTarget.select()}
                                              onChange={e => updateLaborComp(phase.id, task.id, comp.id, { workerCount: Math.max(1, Number(e.target.value)) })}
                                              className="w-12 text-center bg-transparent border border-border rounded px-1 py-0.5 text-[11px]"
                                            />
                                          </div>
                                          <div className="text-center">{Math.round(totalH)}h</div>
                                          <div className="text-center">{Math.round(effectiveH)}h</div>
                                          <div className="text-center">
                                            {(task.laborCompositions?.length || 0) > 1 && (
                                              <button
                                                onClick={() => confirmDelete(
                                                  {
                                                    title: 'Deseja remover este profissional da composição RUP?',
                                                    description: (
                                                      <>
                                                        <p>Profissional: <strong>{comp.role}</strong>.</p>
                                                        <p>Isso pode alterar duração, gargalo e cronograma da tarefa.</p>
                                                      </>
                                                    ),
                                                    confirmLabel: 'Remover profissional',
                                                  },
                                                  () => removeLabor(phase.id, task.id, comp.id),
                                                )}
                                                className="p-1 rounded hover:bg-destructive/20 text-destructive transition-colors"
                                                title="Remover profissional"
                                              >
                                                <X className="w-3 h-3" />
                                              </button>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}



                                    {task.isCritical && (
                                      <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2">
                                        <AlertTriangle className="w-3.5 h-3.5 text-destructive flex-shrink-0 mt-0.5" />
                                        <p className="text-[10px] text-destructive">
                                          Esta tarefa está no <strong>Caminho Crítico</strong> — qualquer atraso impacta o prazo final. Considere aumentar a equipe de <strong>{task.bottleneckRole}</strong>.
                                        </p>
                                      </div>
                                    )}
                                  </div>
                              </div>
                            )}

                            {/* Daily production log panel */}
                            {expandedDaily === task.id && (
                                <DailyLogsPanel
                                  task={task}
                                  onChange={(logs: DailyProductionLog[]) => {
                                    if (logs.length === 0) {
                                      updateTask(phase.id, task.id, {
                                        dailyLogs: logs,
                                        current: undefined,
                                        executedQuantityTotal: 0,
                                        remainingQuantity: task.quantity,
                                        physicalProgress: 0,
                                        percentComplete: 0,
                                      });
                                      return;
                                    }

                                    const logsComQty = logs.filter(l => (l.actualQuantity ?? 0) > 0);
                                    if (logsComQty.length === 0) {
                                      updateTask(phase.id, task.id, { dailyLogs: logs });
                                      return;
                                    }

                                    const sorted = [...logsComQty].sort((a, b) => a.date.localeCompare(b.date));
                                    const realStartDate = sorted[0].date;
                                    const lastLogDate = sorted[sorted.length - 1].date;

                                    const executedTotal = logsComQty.reduce((s, l) => s + l.actualQuantity, 0);
                                    const remaining = Math.max(0, (task.quantity || 0) - executedTotal);
                                    const physicalProgress = task.quantity
                                      ? Math.min(100, (executedTotal / task.quantity) * 100)
                                      : 0;

                                    const avgDaily = executedTotal / logsComQty.length;
                                    const daysRemaining = avgDaily > 0 ? Math.ceil(remaining / avgDaily) : 0;

                                    const [ly, lm, ld] = lastLogDate.split('-').map(Number);
                                    const forecastDate = new Date(ly, lm - 1, ld + daysRemaining);
                                    const forecastEndDate = `${forecastDate.getFullYear()}-${String(forecastDate.getMonth() + 1).padStart(2, '0')}-${String(forecastDate.getDate()).padStart(2, '0')}`;

                                    const [ry, rm, rd] = realStartDate.split('-').map(Number);
                                    const startMs = new Date(ry, rm - 1, rd).getTime();
                                    const lastMs = new Date(ly, lm - 1, ld).getTime();
                                    const currentDuration = Math.max(1, Math.round((lastMs - startMs) / 86400000) + 1);

                                    updateTask(phase.id, task.id, {
                                      dailyLogs: logs,
                                      executedQuantityTotal: executedTotal,
                                      remainingQuantity: remaining,
                                      physicalProgress,
                                      percentComplete: Math.round(physicalProgress),
                                      current: {
                                        startDate: realStartDate,
                                        duration: currentDuration,
                                        endDate: lastLogDate,
                                        forecastEndDate,
                                        executedQuantityTotal: executedTotal,
                                        remainingQuantity: remaining,
                                        physicalProgress,
                                      },
                                    });
                                  }}
                                />
                            )}
                          </div>
                        );
                      })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        };

        return (
          <div className="space-y-3">
            {/* Drop zone para promover a capítulo principal (apenas para subcapítulos) */}
            {dragChapterId && project.phases.find(p => p.id === dragChapterId)?.parentId && (
              <div
                onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropChapterTargetId('__root__'); }}
                onDrop={e => handleChapterDrop(e, null)}
                className={`px-4 py-3 rounded-xl border-2 border-dashed text-center text-[11px] font-medium transition-colors ${
                  dropChapterTargetId === '__root__'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground'
                }`}
              >
                <ArrowUpFromLine className="w-3.5 h-3.5 inline mr-1" />
                ⬆ Soltar aqui para promover a Capítulo Principal
              </div>
            )}

            {(() => {
              const renderNode = (node: import('@/lib/chapters').ChapterNode, idx: number, depth: number): JSX.Element => (
                <div key={node.phase.id} className="space-y-2" style={{ marginLeft: depth > 0 ? `${depth * 1.5}rem` : undefined }}>
                  {renderPhaseCard(node.phase, idx, depth > 0, depth)}
                  {expandedPhases.has(node.phase.id) && node.children.map((child, cIdx) =>
                    renderNode(child, idx * 100 + cIdx, depth + 1),
                  )}
                  {expandedPhases.has(node.phase.id) && (() => {
                    const isAddDropActive =
                      dragChapterId &&
                      dragChapterId !== node.phase.id &&
                      dropChapterTargetId === `__addsub__:${node.phase.id}`;
                    // Bloqueia drop se o alvo for descendente do arrastado (evita ciclos)
                    const isDescendantOfDragged = (() => {
                      if (!dragChapterId) return false;
                      let current: Phase | undefined = node.phase;
                      const visited = new Set<string>();
                      while (current?.parentId) {
                        if (visited.has(current.id)) return false;
                        visited.add(current.id);
                        if (current.parentId === dragChapterId) return true;
                        current = project.phases.find(p => p.id === current!.parentId);
                      }
                      return current?.id === dragChapterId;
                    })();
                    return (
                      <div>
                        <button
                          onClick={() => addPhase(node.phase.id)}
                          onDragOver={e => {
                            if (!dragChapterId || dragChapterId === node.phase.id || isDescendantOfDragged) return;
                            e.preventDefault();
                            e.stopPropagation();
                            e.dataTransfer.dropEffect = 'move';
                            setDropChapterTargetId(`__addsub__:${node.phase.id}`);
                            setDropPosition('inside');
                          }}
                          onDragLeave={() => {
                            if (dropChapterTargetId === `__addsub__:${node.phase.id}`) {
                              setDropChapterTargetId(null);
                            }
                          }}
                          onDrop={e => {
                            if (!dragChapterId || dragChapterId === node.phase.id || isDescendantOfDragged) return;
                            e.preventDefault();
                            e.stopPropagation();
                            handleMoveChapter(dragChapterId, node.phase.id);
                            setDragChapterId(null);
                            setDropChapterTargetId(null);
                            setDropPosition('inside');
                          }}
                          className={`flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-md border border-dashed transition-colors ${
                            isAddDropActive
                              ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary/40'
                              : 'border-border text-muted-foreground hover:text-primary hover:border-primary'
                          }`}
                          title={dragChapterId ? 'Solte aqui para virar subcapítulo deste capítulo' : undefined}
                        >
                          <FolderPlus className="w-3 h-3" />
                          {isAddDropActive
                            ? `➜ Soltar para virar subcapítulo de ${truncateWords(node.phase.name, 4)}`
                            : `Adicionar subcapítulo a ${node.phase.name}`}
                        </button>
                      </div>
                    );
                  })()}
                </div>
              );
              return tree.map((node, idx) => renderNode(node, idx, 0));
            })()}

            {/* Phases órfãs (parentId apontando para um capítulo inexistente) */}
            {project.phases
              .filter(p => p.parentId && !project.phases.some(c => c.id === p.parentId))
              .map((p, i) => renderPhaseCard(p, tree.length + i, false))}

            {/* Drop zone final: solta um capítulo aqui para enviá-lo ao fim da lista. */}
            {dragChapterId && tree.length > 0 && (() => {
              const lastRoot = tree[tree.length - 1].phase;
              const isActive = dropChapterTargetId === '__end__';
              return (
                <div
                  onDragOver={e => {
                    if (!dragChapterId || dragChapterId === lastRoot.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDropPosition('after');
                    setDropChapterTargetId('__end__');
                  }}
                  onDrop={e => {
                    if (!dragChapterId) return;
                    e.preventDefault();
                    if (dragChapterId !== lastRoot.id) {
                      const reordered = reorderChapter(project, dragChapterId, lastRoot.id, 'after');
                      const cleaned = {
                        ...reordered,
                        phases: reordered.phases.map(p =>
                          !p.parentId ? { ...p, customNumber: undefined } : p,
                        ),
                      };
                      onProjectChange(cleaned);
                    }
                    setDragChapterId(null);
                    setDropChapterTargetId(null);
                    setDropPosition('inside');
                  }}
                  className={`px-4 py-3 rounded-xl border-2 border-dashed text-center text-[11px] font-medium transition-colors ${
                    isActive ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
                  }`}
                >
                  Soltar aqui para mover ao final da lista
                </div>
              );
            })()}
          </div>
        );
      })()}
      {confirmDialog}
    </div>
  );
}
