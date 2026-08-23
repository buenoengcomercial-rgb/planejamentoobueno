import { Project, Task, ViewMode, DependencyType, TaskDependency } from '@/types/project';
import type { AuditUserInfo } from '@/lib/audit';
import { getTeamDefinition, DEFAULT_TEAMS, TeamCode, TeamDefinition } from '@/lib/teams';
import GerenciarEquipes from './GerenciarEquipes';
import { Settings2 } from 'lucide-react';
import { getAllTasks } from '@/data/sampleProject';
import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, Flag, Pencil, CalendarClock, SlidersHorizontal } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { GanttDatePickerCalendar } from './gantt/GanttDatePickerCalendar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import DependencyArrows from './gantt/DependencyArrows';
import ConfiguracaoObra, { ObraConfig, loadObraConfig } from './ConfiguracaoObra';
import { DAY_WIDTH, ROW_HEIGHT, FlatTask } from './gantt/types';
import { addDays, diffDays, formatDateFull, formatDateShort, getEndDate, getWorkEndDate, MONTH_NAMES_PT, dateToISO, toISODateLocal, parseISODateLocal, countWorkDays } from './gantt/utils';
import { getFeriadosMap, FeriadoInfo, calcularDiasUteis, isDiaUtil } from '@/lib/feriados';
import {
  calculateRupDuration,
  propagateAllDependencies,
  recalculateTaskAndSuccessors,
  checkDependencyViolation,
  wouldCreateDependencyCycle,
} from '@/lib/calculations';
import { flattenPhasesByChapter, getChapterNumbering, getChapterTasks } from '@/lib/chapters';
import { beginBarMutation, endBarMutation, endAllBarMutations, setTransform, setTransition, setOpacity, setLeftPx, setWidthPx, type BarMutationSession } from './gantt/barTransform';
import { toast } from 'sonner';
import { AdditiveBadge } from '@/components/shared/AdditiveBadge';
import GanttFinancialForecast from './gantt/GanttFinancialForecast';
import { sortTasksForSchedule, withScheduleOrderForMove } from '@/lib/taskOrdering';
import { buildLaborPlanningAnalysis, type LaborPlanningGranularity } from '@/lib/laborDimensioning';
import {
  buildAdditiveScheduleAnalysisProject,
  buildPendingAdditiveSuspensionMap,
  isStatusOnlySuspension,
  type AdditiveScheduleSuspensionMeta,
} from '@/lib/additiveSchedule';
import { getWorkStartDate } from '@/lib/workStartDate';
import TaskRescheduleDialog from '@/components/TaskRescheduleDialog';
import { approveRescheduleRequest, rejectRescheduleRequest, submitRescheduleRequest } from '@/lib/taskRescheduling';

interface GanttChartProps {
  project: Project;
  onProjectChange?: (project: Project) => void;
  undoButton?: React.ReactNode;
  context?: 'official' | 'additive-preview';
  title?: string;
  subtitle?: string;
  suspensionMap?: Record<string, AdditiveScheduleSuspensionMeta>;
  onToggleSuspension?: (taskId: string, checked: boolean) => void;
  onEditSuspension?: (taskId: string) => void;
  financialForecastNode?: React.ReactNode | null;
  monthlyFinancialForecast?: Array<{
    key: string;
    contractedReleased: number;
    proposed: number;
  }>;
  /** Tarefas exibidas a partir de uma prévia de aditivo e editáveis somente nela. */
  lockedTaskLabels?: Record<string, string>;
  readOnly?: boolean;
  collapsedPhaseIds?: string[];
  onCollapsedPhaseIdsChange?: (phaseIds: string[]) => void;
  canRequestReschedule?: boolean;
  canApproveReschedule?: boolean;
  auditActor?: AuditUserInfo;
}

export default function GanttChart({
  project,
  onProjectChange,
  undoButton,
  context = 'official',
  title = 'Cronograma',
  subtitle = 'Gantt Interativo com CPM',
  suspensionMap: providedSuspensionMap,
  onToggleSuspension,
  onEditSuspension,
  financialForecastNode,
  monthlyFinancialForecast,
  lockedTaskLabels = {},
  readOnly = false,
  collapsedPhaseIds: controlledCollapsedPhaseIds,
  onCollapsedPhaseIdsChange,
  canRequestReschedule = false,
  canApproveReschedule = false,
  auditActor = {},
}: GanttChartProps) {
  const isTaskScheduleLocked = useCallback((taskId: string) => !!lockedTaskLabels[taskId], [lockedTaskLabels]);
  const scheduleLockLabel = useCallback((taskId: string) => lockedTaskLabels[taskId], [lockedTaskLabels]);
  // Lista de equipes do projeto (com fallback aos defaults).
  const projectTeams: TeamDefinition[] = project.teams ?? DEFAULT_TEAMS;
  // Helper local que sempre busca a definição na lista do projeto.
  const teamDef = useCallback((code?: TeamCode) => getTeamDefinition(code, projectTeams), [projectTeams]);
  const viewModeStorageKey = `obraplanner-gantt-viewmode-${project.id}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem(viewModeStorageKey);
      if (saved === 'days' || saved === 'weeks' || saved === 'months') return saved;
    } catch {
      // O cronograma continua funcional quando o armazenamento local está indisponível.
    }
    return 'weeks';
  });
  // Recarrega ao trocar de projeto
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`obraplanner-gantt-viewmode-${project.id}`);
      if (saved === 'days' || saved === 'weeks' || saved === 'months') setViewMode(saved);
      else setViewMode('weeks');
    } catch {
      // O cronograma continua funcional quando o armazenamento local está indisponível.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);
  // Persiste a cada mudança
  useEffect(() => {
    try { localStorage.setItem(viewModeStorageKey, viewMode); } catch {
      // Preferência visual não é crítica para a operação.
    }
  }, [viewMode, viewModeStorageKey]);
  // Estado de capítulos minimizados — inicializa com a persistência do projeto.
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(
    () => new Set(controlledCollapsedPhaseIds ?? project.uiState?.ganttCollapsedPhaseIds ?? [])
  );
  const [showCriticalOnly, setShowCriticalOnly] = useState(false);
  const [showZeroSuppressed, setShowZeroSuppressed] = useState(false);
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [phaseFilter, setPhaseFilter] = useState<string>('all');
  const [showDelayedOnly, setShowDelayedOnly] = useState(false);
  const [showWithDependenciesOnly, setShowWithDependenciesOnly] = useState(false);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [laborPeriodMode, setLaborPeriodMode] = useState<LaborPlanningGranularity>('week');
  const [showLaborOnlyDeficits, setShowLaborOnlyDeficits] = useState(true);
  const [laborPanelExpanded, setLaborPanelExpanded] = useState(false);
  const [laborIssueMode, setLaborIssueMode] = useState<'deficit' | 'availability' | 'data'>('deficit');
  const [highlightedLaborTaskIds, setHighlightedLaborTaskIds] = useState<Set<string>>(() => new Set());
  const [obraConfig, setObraConfig] = useState<ObraConfig>(loadObraConfig);
  const [rescheduleTaskId, setRescheduleTaskId] = useState<string | null>(null);
  const suspensionMap = useMemo(
    () => providedSuspensionMap ?? (context === 'official' ? buildPendingAdditiveSuspensionMap(project) : {}),
    [context, project, providedSuspensionMap],
  );
  const isStatusOnlyTask = useCallback(
    // Pending additive restrictions are operational states in both views: keep
    // the row for traceability, but replace its planned bar with the status.
    (taskId: string) => isStatusOnlySuspension(suspensionMap[taskId]),
    [suspensionMap],
  );
  const analysisProject = useMemo(
    // Never persist this projection. It only prevents pending/suppressed work
    // from contributing to the operational CPM, labor and financial analyses.
    () => buildAdditiveScheduleAnalysisProject(project, suspensionMap),
    [project, suspensionMap],
  );

  // Synchronize controlled state when switching projects/additives.
  useEffect(() => {
    const incoming = controlledCollapsedPhaseIds ?? project.uiState?.ganttCollapsedPhaseIds ?? [];
    setCollapsedPhases(current => {
      const now = [...current].sort();
      const next = [...incoming].sort();
      const same = now.length === next.length && now.every((id, index) => id === next[index]);
      return same ? current : new Set(incoming);
    });
  }, [controlledCollapsedPhaseIds, project.id]);

  // Persiste no projeto/aditivo sempre que o conjunto de minimizados mudar.
  useEffect(() => {
    const now = [...collapsedPhases].sort();
    const persisted = controlledCollapsedPhaseIds ?? project.uiState?.ganttCollapsedPhaseIds ?? [];
    const prev = [...persisted].sort();
    const same = now.length === prev.length && now.every((id, i) => id === prev[i]);
    if (same) return;
    if (onCollapsedPhaseIdsChange) {
      onCollapsedPhaseIdsChange(now);
      return;
    }
    if (!onProjectChange) return;
    onProjectChange({
      ...project,
      uiState: { ...(project.uiState ?? {}), ganttCollapsedPhaseIds: now },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsedPhases]);

  // Drag state
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartX = useRef(0);
  const dragStartLeft = useRef(0);
  const ganttRootRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  // Refs para throttle do drag (rAF) — evita re-render por pixel
  const dragRafPending = useRef(false);
  const lastDragDx = useRef(0);
  const lastDragDays = useRef<number | null>(null);

  // Resize state
  const [resizingTaskId, setResizingTaskId] = useState<string | null>(null);
  const [resizeSide, setResizeSide] = useState<'left' | 'right' | null>(null);
  const [resizeDelta, setResizeDelta] = useState(0);
  const resizeStartX = useRef(0);

  // Refs DOM por tarefa para mutação direta durante drag/resize (evita re-render)
  const barRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const setBarRef = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) barRefs.current.set(id, el);
    else barRefs.current.delete(id);
  }, []);

  // Local duration edit state
  const [editingDurationTaskId, setEditingDurationTaskId] = useState<string | null>(null);
  const [localDuration, setLocalDuration] = useState<string>('');

  // Real-time drag propagation: temporary task overrides during drag
  const [dragTempTasks, setDragTempTasks] = useState<Map<string, { startDate: string }>>(new Map());

  // Reorder state (drag de linhas da sidebar para reordenar tarefas)
  const [reorderDragPhaseId, setReorderDragPhaseId] = useState<string | null>(null);
  const [reorderDragTaskId, setReorderDragTaskId] = useState<string | null>(null);
  const [reorderDropTargetId, setReorderDropTargetId] = useState<string | null>(null);
  const [reorderDropPos, setReorderDropPos] = useState<'before' | 'after' | null>(null);

  const handleRowDragStart = useCallback((e: React.DragEvent, phaseId: string, taskId: string) => {
    if (isTaskScheduleLocked(taskId)) return;
    setReorderDragPhaseId(phaseId);
    setReorderDragTaskId(taskId);
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', taskId);
    } catch {
      // O arraste ainda funciona pelo estado React quando o navegador bloqueia setData.
    }
  }, [isTaskScheduleLocked]);

  const handleRowDragOver = useCallback((e: React.DragEvent, targetTaskId: string) => {
    if (!reorderDragTaskId || isTaskScheduleLocked(targetTaskId)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos: 'before' | 'after' = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after';
    setReorderDropTargetId(targetTaskId);
    setReorderDropPos(pos);
  }, [isTaskScheduleLocked, reorderDragTaskId]);

  const handleRowDrop = useCallback((e: React.DragEvent, targetPhaseId: string, targetTaskId: string) => {
    if (!reorderDragPhaseId || !reorderDragTaskId || !onProjectChange || isTaskScheduleLocked(targetTaskId)) {
      setReorderDragPhaseId(null);
      setReorderDragTaskId(null);
      setReorderDropTargetId(null);
      setReorderDropPos(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const pos = reorderDropPos ?? 'before';

    if (reorderDragTaskId === targetTaskId) {
      setReorderDragPhaseId(null);
      setReorderDragTaskId(null);
      setReorderDropTargetId(null);
      setReorderDropPos(null);
      return;
    }

    onProjectChange(withScheduleOrderForMove(project, reorderDragPhaseId, reorderDragTaskId, targetPhaseId, targetTaskId, pos));
    setReorderDragPhaseId(null);
    setReorderDragTaskId(null);
    setReorderDropTargetId(null);
    setReorderDropPos(null);
  }, [isTaskScheduleLocked, reorderDragPhaseId, reorderDragTaskId, reorderDropPos, project, onProjectChange]);

  const handleRowDragEnd = useCallback(() => {
    setReorderDragPhaseId(null);
    setReorderDragTaskId(null);
    setReorderDropTargetId(null);
    setReorderDropPos(null);
  }, []);

  const today = new Date();

  const isZeroOrSuppressedTask = useCallback((task: Task) => {
    const latest = task.additiveHistory?.[task.additiveHistory.length - 1];
    const finalQuantity = latest?.newQuantity ?? task.quantity ?? task.remainingQuantity ?? 0;
    const totalAdded = (task.additiveHistory ?? []).reduce((sum, item) => sum + (item.addedQuantity || 0), 0);
    const totalSuppressed = (task.additiveHistory ?? []).reduce((sum, item) => sum + (item.suppressedQuantity || 0), 0);
    const baseQuantity = task.additiveHistory?.[0]?.previousQuantity ?? task.quantity ?? 0;
    const fullySuppressed = baseQuantity > 0 && totalSuppressed >= baseQuantity + totalAdded;

    // Only schedule visibility changes here. Contract tabs still render these tasks.
    return task.suppressedByAdditive === true || finalQuantity <= 0 || fullySuppressed;
  }, []);

  const isDelayedTask = useCallback((task: Task) => {
    const endDate = addDays(parseISODateLocal(task.startDate), Math.max(0, task.duration - 1));
    return endDate < today && task.percentComplete < 100;
  }, [today]);

  const tasks = useMemo(() => getAllTasks(project), [project]);
  const scheduledTasks = useMemo(() => getAllTasks(analysisProject), [analysisProject]);
  const laborPlanning = useMemo(
    () => buildLaborPlanningAnalysis(analysisProject, laborPeriodMode),
    [analysisProject, laborPeriodMode],
  );
  const laborRowsToShow = useMemo(() => {
    const baseRows =
      laborIssueMode === 'availability'
        ? laborPlanning.missingAvailabilityRows
        : laborIssueMode === 'data'
          ? []
          : showLaborOnlyDeficits
            ? laborPlanning.deficitRows
            : laborPlanning.rows.filter(row => row.hours > 0 && row.status !== 'missing_availability');
    const rows = laborIssueMode === 'data' ? [] : baseRows;
    return rows.slice(0, 8);
  }, [laborIssueMode, laborPlanning, showLaborOnlyDeficits]);
  const laborTopDeficit = laborPlanning.deficitRows[0];
  const laborDataIssuesToShow = useMemo(
    () => laborPlanning.dataIssues.slice(0, 8),
    [laborPlanning.dataIssues],
  );
  const highlightLaborTasks = useCallback((taskIds: string[]) => {
    setHighlightedLaborTaskIds(new Set(taskIds));
  }, []);
  const clearLaborHighlight = useCallback(() => {
    setHighlightedLaborTaskIds(new Set());
  }, []);
  const selectedPhaseIds = useMemo(() => {
    if (phaseFilter === 'all') return null;
    const allowedPhaseIds = new Set<string>([phaseFilter]);
    if (phaseFilter !== 'all') {
      project.phases.forEach(phase => {
        let current = phase.parentId;
        while (current) {
          if (current === phaseFilter) {
            allowedPhaseIds.add(phase.id);
            break;
          }
          current = project.phases.find(p => p.id === current)?.parentId;
        }
      });
    }
    return allowedPhaseIds;
  }, [phaseFilter, project.phases]);

  const visibleTaskIds = useMemo(() => {
    return new Set(tasks
      .filter(task => isStatusOnlyTask(task.id) || showZeroSuppressed || !isZeroOrSuppressedTask(task))
      .filter(task => isStatusOnlyTask(task.id) || teamFilter === 'all' || (task.team ?? '_none') === teamFilter)
      .filter(task => !selectedPhaseIds || project.phases.some(phase => (
        selectedPhaseIds.has(phase.id) && phase.tasks.some(t => t.id === task.id)
      )))
      .filter(task => isStatusOnlyTask(task.id) || !showDelayedOnly || isDelayedTask(task))
      .filter(task => isStatusOnlyTask(task.id) || !showWithDependenciesOnly || (task.dependencies?.length ?? 0) > 0 || (task.dependencyDetails?.length ?? 0) > 0)
      .filter(task => isStatusOnlyTask(task.id) || !showCriticalOnly || task.isCritical)
      .map(task => task.id));
  }, [
    isDelayedTask,
    isStatusOnlyTask,
    isZeroOrSuppressedTask,
    project.phases,
    selectedPhaseIds,
    showCriticalOnly,
    showDelayedOnly,
    showWithDependenciesOnly,
    showZeroSuppressed,
    tasks,
    teamFilter,
  ]);
  const getVisiblePhaseTasks = useCallback((phase: typeof project.phases[0]) => (
    sortTasksForSchedule(phase.tasks).filter(task => visibleTaskIds.has(task.id))
  ), [visibleTaskIds]);
  const criticalCount = useMemo(
    () => tasks.filter(task => task.isCritical && visibleTaskIds.has(task.id) && !isStatusOnlyTask(task.id)).length,
    [isStatusOnlyTask, tasks, visibleTaskIds],
  );
  const scheduledProjectStart = useMemo(
    () => scheduledTasks.length
      ? new Date(Math.min(...scheduledTasks.map(t => parseISODateLocal(t.startDate).getTime())))
      : parseISODateLocal(project.startDate),
    [project.startDate, scheduledTasks],
  );
  const workStartDate = useMemo(
    () => getWorkStartDate(project, toISODateLocal(scheduledProjectStart)),
    [project, scheduledProjectStart],
  );
  const workStart = useMemo(() => parseISODateLocal(workStartDate), [workStartDate]);
  const projectStart = useMemo(
    () => new Date(Math.min(scheduledProjectStart.getTime(), workStart.getTime())),
    [scheduledProjectStart, workStart],
  );
  const scheduledProjectEnd = useMemo(
    () => scheduledTasks.length
      ? new Date(Math.max(...scheduledTasks.map(t => addDays(parseISODateLocal(t.startDate), Math.max(0, t.duration - 1)).getTime())))
      : parseISODateLocal(project.endDate || project.startDate),
    [project.endDate, project.startDate, scheduledTasks],
  );
  const projectEnd = useMemo(
    () => new Date(Math.max(scheduledProjectEnd.getTime(), workStart.getTime())),
    [scheduledProjectEnd, workStart],
  );
  const totalDays = useMemo(() => diffDays(projectStart, projectEnd) + 10, [projectStart, projectEnd]);
  const dayWidth = DAY_WIDTH[viewMode];
  const taskRowHeight = context === 'additive-preview'
    ? (density === 'compact' ? 34 : 40)
    : density === 'compact' ? 24 : ROW_HEIGHT;
  const phaseHeaderHeight = taskRowHeight + (density === 'compact' ? 16 : 20);
  // O subtítulo repete as colunas da tabela. Uma altura um pouco maior evita
  // que "Descrição", "Início" e "Fim" pareçam sobrepostos em telas densas.
  const taskSubHeaderHeight = density === 'compact' ? 22 : 24;
  // A descrição pode ocupar duas linhas. Esta base é usada também do lado das
  // barras para que a régua do Gantt continue na mesma linha visual.
  const descriptionRowHeight = density === 'compact' ? 40 : 44;
  const getTaskRowHeight = useCallback((task: Task) => {
    const hasActualProgress = (task.dailyLogs || []).some(log => (log.actualQuantity ?? 0) > 0);
    const hasActualDates = hasActualProgress && !!task.current?.startDate;
    const hasTwoLineProduction = hasActualProgress && !!task.quantity;
    const hasScheduleLabel = isTaskScheduleLocked(task.id);
    const hasManualBlockingNotice = context === 'additive-preview'
      && suspensionMap[task.id]?.kind === 'manual'
      && !!suspensionMap[task.id]?.blockingCompositions?.length;

    // Datas real/prevista, produção real e a origem no aditivo ocupam linhas
    // adicionais. O bloqueio manual também acrescenta uma linha explicativa.
    // A altura precisa ser a mesma na tabela e na área das barras.
    if (!hasActualDates && !hasTwoLineProduction && !hasScheduleLabel && !hasManualBlockingNotice) return descriptionRowHeight;
    return Math.max(descriptionRowHeight, density === 'compact' ? 56 : 60);
  }, [context, density, descriptionRowHeight, isTaskScheduleLocked, suspensionMap]);
  const chartWidth = useMemo(() => totalDays * dayWidth, [totalDays, dayWidth]);

  const todayOffset = diffDays(projectStart, today);
  const workStartOffset = diffDays(projectStart, workStart);

  // Holiday map for the project range
  const feriadoMap = useMemo(() => {
    return getFeriadosMap(projectStart, projectEnd, obraConfig.uf, obraConfig.municipio);
  }, [projectStart.getTime(), projectEnd.getTime(), obraConfig.uf, obraConfig.municipio]);

  // Day info for visual highlighting
  const dayInfos = useMemo(() => {
    const infos: { date: Date; dow: number; feriado?: FeriadoInfo }[] = [];
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(projectStart, i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      infos.push({ date: d, dow: d.getDay(), feriado: feriadoMap.get(key) });
    }
    return infos;
  }, [projectStart, totalDays, feriadoMap]);

  // Coleta tarefas do capítulo: se for capítulo principal, inclui as dos subcapítulos.
  const getEffectiveChapterTasks = useCallback((phase: typeof project.phases[0]) => {
    return getChapterTasks(project, phase.id).filter(task => visibleTaskIds.has(task.id) && !isStatusOnlyTask(task.id));
  }, [isStatusOnlyTask, project, visibleTaskIds]);

  // Chapter business days
  const getChapterDiasUteis = useCallback((phase: typeof project.phases[0]) => {
    const items = getEffectiveChapterTasks(phase);
    if (items.length === 0) return { dias: 0, horas: 0 };
    const starts = items.map(t => parseISODateLocal(t.startDate).getTime());
    const ends = items.map(t => addDays(parseISODateLocal(t.startDate), Math.max(0, t.duration - 1)).getTime());
    const inicio = new Date(Math.min(...starts));
    const fim = new Date(Math.max(...ends));
    return calcularDiasUteis(inicio, fim, obraConfig.uf, obraConfig.municipio, obraConfig.trabalhaSabado, obraConfig.jornadaDiaria);
  }, [obraConfig, getEffectiveChapterTasks]);

  const getPhaseRange = (phase: typeof project.phases[0]) => {
    const items = getEffectiveChapterTasks(phase);
    if (items.length === 0) return { start: '', end: '' };
    const starts = items.map(t => parseISODateLocal(t.startDate).getTime());
    const ends = items.map(t => addDays(parseISODateLocal(t.startDate), Math.max(0, t.duration - 1)).getTime());
    return {
      start: dateToISO(new Date(Math.min(...starts))),
      end: dateToISO(new Date(Math.max(...ends))),
    };
  };

  const togglePhase = (id: string) => {
    setCollapsedPhases(prev => {
      const n = new Set(prev);
      // Apenas alterna o próprio capítulo/subcapítulo.
      // O estado individual dos subcapítulos é preservado — quando o pai
      // for re-expandido, cada filho mantém o estado em que foi deixado.
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const taskNumbering = useMemo(() => {
    const map = new Map<string, number>();
    let num = 0;
    project.phases.forEach(phase => {
      sortTasksForSchedule(phase.tasks).forEach(task => {
        if (!visibleTaskIds.has(task.id)) return;
        num++;
        map.set(task.id, num);
      });
    });
    return map;
  }, [project, visibleTaskIds]);

  const numberToTaskId = useMemo(() => {
    const map = new Map<number, string>();
    taskNumbering.forEach((num, id) => map.set(num, id));
    return map;
  }, [taskNumbering]);

  // Phases ordenadas: capítulo principal seguido de seus subcapítulos
  const allPhases = useMemo(() => flattenPhasesByChapter(project), [project]);
  const phaseDepth = useMemo(() => {
    const map = new Map<string, number>();
    const byId = new Map(project.phases.map(p => [p.id, p]));
    const compute = (id: string): number => {
      if (map.has(id)) return map.get(id)!;
      const ph = byId.get(id);
      const d = ph?.parentId ? compute(ph.parentId) + 1 : 0;
      map.set(id, d);
      return d;
    };
    project.phases.forEach(p => compute(p.id));
    return map;
  }, [project.phases]);
  const displayPhases = useMemo(
    () => {
      const collapsedAncestor = (p: { parentId?: string }) => {
        let cur = p.parentId;
        const byId = new Map(allPhases.map(x => [x.id, x]));
        while (cur) {
          if (collapsedPhases.has(cur)) return true;
          cur = byId.get(cur)?.parentId;
        }
        return false;
      };
      return allPhases.filter(p => !collapsedAncestor(p) && (!selectedPhaseIds || selectedPhaseIds.has(p.id)));
    },
    [allPhases, collapsedPhases, selectedPhaseIds]
  );
  const chapterNumbering = useMemo(() => getChapterNumbering(project), [project]);

  const flatTasks = useMemo(() => {
    const result: FlatTask[] = [];
    let rowIdx = 0;
    displayPhases.forEach(phase => {
      rowIdx++;
      if (!collapsedPhases.has(phase.id)) {
        getVisiblePhaseTasks(phase).forEach(task => {
            result.push({ task, phaseId: phase.id, phaseName: phase.name, rowIndex: rowIdx });
            rowIdx++;
          });
      }
    });
    return result;
  }, [displayPhases, collapsedPhases, getVisiblePhaseTasks]);

  // Compute Y positions for dependency arrows (relative to bars area)
  const taskYPositions = useMemo(() => {
    const map = new Map<string, number>();
    const PHASE_HEADER_HEIGHT = phaseHeaderHeight;
    const SUBHEADER_HEIGHT = taskSubHeaderHeight;
    let y = 0;
    displayPhases.forEach(phase => {
      // Header do capítulo é sempre renderizado (botão + linha de datas)
      y += PHASE_HEADER_HEIGHT;
      if (!collapsedPhases.has(phase.id)) {
        const visibleTasks = getVisiblePhaseTasks(phase);
        if (visibleTasks.length > 0) y += SUBHEADER_HEIGHT;
        visibleTasks.forEach(task => {
            const rowHeight = getTaskRowHeight(task);
            map.set(task.id, y + rowHeight / 2);
            y += rowHeight;
          });
      }
    });
    return map;
  }, [displayPhases, collapsedPhases, getTaskRowHeight, getVisiblePhaseTasks, phaseHeaderHeight, taskSubHeaderHeight]);
  const violationMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    tasks.forEach(task => {
      if (isStatusOnlyTask(task.id)) return;
      const details = task.dependencyDetails || [];
      details.forEach(dep => {
        const pred = tasks.find(t => t.id === dep.taskId);
        if (!pred || isStatusOnlyTask(pred.id)) return;
        const predStart = parseISODateLocal(pred.startDate);
        const predEnd = addDays(predStart, pred.duration);
        const taskStart = parseISODateLocal(task.startDate);
        const taskEnd = addDays(taskStart, task.duration);
        let violated = false;
        switch (dep.type) {
          case 'TI': violated = taskStart < predEnd; break;
          case 'II': violated = taskStart < predStart; break;
          case 'TT': violated = taskEnd < predEnd; break;
          case 'IT': violated = taskEnd < predStart; break;
        }
        if (violated) {
          if (!map.has(task.id)) map.set(task.id, new Set());
          map.get(task.id)!.add(dep.taskId);
        }
      });
    });
    return map;
  }, [isStatusOnlyTask, tasks]);

  const weekDates = useMemo(() => {
    const dates: { day: number; month: number; year: number; offset: number; width: number }[] = [];
    if (viewMode === 'weeks') {
      for (let i = 0; i < totalDays; i += 7) {
        const d = addDays(projectStart, i);
        dates.push({ day: d.getDate(), month: d.getMonth(), year: d.getFullYear(), offset: i * dayWidth, width: 7 * dayWidth });
      }
    }
    return dates;
  }, [viewMode, totalDays, dayWidth]);

  const monthGroups = useMemo(() => {
    if (viewMode !== 'weeks' || weekDates.length === 0) return [];
    const groups: { key: string; label: string; offset: number; width: number }[] = [];
    let currentKey = `${weekDates[0].year}-${weekDates[0].month}`;
    let currentOffset = weekDates[0].offset;
    let currentWidth = weekDates[0].width;
    let currentMonth = weekDates[0].month;
    let currentYear = weekDates[0].year;

    for (let i = 1; i < weekDates.length; i++) {
      const key = `${weekDates[i].year}-${weekDates[i].month}`;
      if (key === currentKey) {
        currentWidth += weekDates[i].width;
      } else {
        groups.push({ key: `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`, label: `${MONTH_NAMES_PT[currentMonth]} ${currentYear}`, offset: currentOffset, width: currentWidth });
        currentKey = key;
        currentOffset = weekDates[i].offset;
        currentWidth = weekDates[i].width;
        currentMonth = weekDates[i].month;
        currentYear = weekDates[i].year;
      }
    }
    groups.push({ key: `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`, label: `${MONTH_NAMES_PT[currentMonth]} ${currentYear}`, offset: currentOffset, width: currentWidth });
    return groups;
  }, [weekDates, viewMode]);

  const headerDates = useMemo(() => {
    const dates: { key?: string; label: string; offset: number; width: number }[] = [];
    if (viewMode === 'days') {
      for (let i = 0; i < totalDays; i++) {
        const d = addDays(projectStart, i);
        dates.push({ label: d.getDate().toString(), offset: i * dayWidth, width: dayWidth });
      }
    } else if (viewMode === 'weeks') {
      for (let i = 0; i < totalDays; i += 7) {
        const d = addDays(projectStart, i);
        dates.push({ label: d.getDate().toString().padStart(2, '0'), offset: i * dayWidth, width: 7 * dayWidth });
      }
    } else {
      let current = new Date(projectStart);
      while (current <= projectEnd) {
        const monthStart = diffDays(projectStart, current);
        const monthEnd = new Date(current.getFullYear(), current.getMonth() + 1, 0);
        const visibleEnd = monthEnd < projectEnd ? monthEnd : projectEnd;
        const visibleDays = diffDays(current, visibleEnd) + 1;
        dates.push({
          key: `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`,
          label: current.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
          offset: monthStart * dayWidth,
          width: visibleDays * dayWidth,
        });
        current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
      }
    }
    return dates;
  }, [viewMode, totalDays, dayWidth]);

  const getBarStyle = (task: Task) => {
    const start = diffDays(projectStart, parseISODateLocal(task.startDate));
    const endISO = getWorkEndDate(task.startDate, task.duration, obraConfig.trabalhaSabado);
    const endOffset = diffDays(projectStart, parseISODateLocal(endISO));
    const width = (endOffset - start + 1) * dayWidth;
    const isDelayed = addDays(parseISODateLocal(task.startDate), Math.max(0, task.duration - 1)) < today && task.percentComplete < 100;
    const isCritical = !!task.isCritical && !isDelayed && task.percentComplete < 100;
    const isComplete = task.percentComplete === 100;
    return { left: start * dayWidth, width, isDelayed, isCritical, isComplete };
  };

  // Helper: team production info for a task
  const getTaskTeamInfo = (task: Task) => {
    const totalWorkers = (task.laborCompositions || []).reduce((sum, c) => sum + (c.workerCount || 0), 0);
    const bottleneckComp = task.bottleneckRole
      ? (task.laborCompositions || []).find(c => c.role === task.bottleneckRole)
      : undefined;
    const mainRole = task.bottleneckRole || bottleneckComp?.role || task.responsible || 'Equipe';
    const mainWorkers = bottleneckComp ? bottleneckComp.workerCount : (totalWorkers || 0);
    const totalHours = task.totalHours || 0;
    const hoursPerDay = task.duration > 0 ? totalHours / task.duration : 0;
    return { mainRole, mainWorkers, totalWorkers, totalHours, hoursPerDay };
  };

  const formatTeamLabel = (task: Task) => {
    const info = getTaskTeamInfo(task);
    if (info.totalHours === 0 && info.mainWorkers === 0) return '';
    return `${info.mainRole} (${info.mainWorkers}) • ${Math.round(info.totalHours)}h • ${info.hoursPerDay.toFixed(1)}h/dia`;
  };

  const updateTask = useCallback((taskId: string, updates: Partial<Task>) => {
    if (!onProjectChange) return;
    const newProject = {
      ...project,
      phases: project.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t),
      })),
    };
    onProjectChange(newProject);
  }, [project, onProjectChange]);

  const getViolations = useCallback((task: Task): string[] => {
    const violations: string[] = [];
    const details = task.dependencyDetails || [];
    details.forEach(dep => {
      const predTask = tasks.find(t => t.id === dep.taskId);
      if (!predTask) return;
      const predNum = taskNumbering.get(dep.taskId);
      const predStart = parseISODateLocal(predTask.startDate);
      const predEnd = addDays(predStart, predTask.duration);
      const taskStart = parseISODateLocal(task.startDate);
      const taskEnd = addDays(taskStart, task.duration);

      switch (dep.type) {
        case 'TI':
          if (taskStart < predEnd) violations.push(`Conflito de dependência com tarefa #${predNum} (TI)`);
          break;
        case 'II':
          if (taskStart < predStart) violations.push(`Conflito de dependência com tarefa #${predNum} (II)`);
          break;
        case 'TT':
          if (taskEnd < predEnd) violations.push(`Conflito de dependência com tarefa #${predNum} (TT)`);
          break;
        case 'IT':
          if (taskEnd < predStart) violations.push(`Conflito de dependência com tarefa #${predNum} (IT)`);
          break;
      }
    });
    return violations;
  }, [tasks, taskNumbering]);

  const handleDateChange = (taskId: string, field: 'start' | 'end', date: Date | undefined) => {
    if (!date || isTaskScheduleLocked(taskId)) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    let updates: Partial<Task>;
    if (field === 'start') {
      if ((task.durationMode || 'manual') === 'manual') {
        updates = { startDate: dateToISO(date) };
      } else {
        const oldEnd = addDays(parseISODateLocal(task.startDate), Math.max(0, task.duration - 1));
        const newDuration = Math.max(1, diffDays(date, oldEnd) + 1);
        updates = { startDate: dateToISO(date), duration: newDuration };
      }
    } else {
      const start = parseISODateLocal(task.startDate);
      const newDuration = Math.max(1, countWorkDays(start, date, obraConfig.trabalhaSabado));
      updates = { duration: newDuration, durationMode: 'manual' };
    }

    if (!onProjectChange) return;
    const updatedProject: Project = {
      ...project,
      phases: project.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t),
      })),
    };
    commitWithDependencyPropagation(updatedProject, taskId);
  };

  const handleDurationChange = (taskId: string, value: string) => {
    if (isTaskScheduleLocked(taskId)) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const newDuration = Math.max(1, parsed);
    if (newDuration === task.duration) return;
    // Sempre força modo manual ao editar a duração diretamente
    const updatedProject: Project = {
      ...project,
      phases: project.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(item => item.id === taskId
          ? {
              ...item,
              duration: newDuration,
              durationMode: 'manual',
              isManual: true,
              manualDuration: newDuration,
            }
          : item),
      })),
    };
    commitWithDependencyPropagation(updatedProject, taskId);
  };
  const handleBaselineDateChange = (taskId: string, field: 'start' | 'end', date: Date | undefined) => {
    if (!date || !onProjectChange) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task || !task.baseline) return;

    const isRup = (task.durationMode || 'manual') === 'rup';
    const rupDuration = isRup ? calculateRupDuration(task, obraConfig).duration : task.baseline.duration;

    let newStart: Date;
    let newDuration: number;
    let newEnd: Date;

    if (field === 'start') {
      newStart = date;
      if (isRup) {
        newDuration = rupDuration;
        newEnd = addDays(newStart, newDuration);
      } else {
        // Manual: keep duration, shift end
        newDuration = task.baseline.duration;
        newEnd = addDays(newStart, newDuration);
      }
    } else {
      newEnd = date;
      if (isRup) {
        // RUP: keep duration, shift start backward
        newDuration = rupDuration;
        newStart = addDays(newEnd, -newDuration);
      } else {
        // Manual: keep start, recalc duration
        newStart = parseISODateLocal(task.baseline.startDate);
        newDuration = Math.max(1, diffDays(newStart, newEnd));
        newEnd = addDays(newStart, newDuration);
      }
    }

    const newBaseline = {
      ...task.baseline,
      startDate: dateToISO(newStart),
      duration: newDuration,
      endDate: dateToISO(newEnd),
      plannedDailyProduction: task.quantity && newDuration > 0 ? task.quantity / newDuration : task.baseline.plannedDailyProduction,
    };

    updateTask(taskId, { baseline: newBaseline });
  };
  const handleChapterDateChange = (phaseId: string, field: 'start' | 'end', date: Date | undefined) => {
    if (!date || !onProjectChange) return;
    const phase = project.phases.find(p => p.id === phaseId);
    if (!phase || getVisiblePhaseTasks(phase).length === 0) return;

    const range = getPhaseRange(phase);
    const oldStart = new Date(range.start);
    const oldEnd = new Date(range.end);
    const oldSpan = diffDays(oldStart, oldEnd) || 1;

    let newStart: Date, newEnd: Date;
    if (field === 'start') {
      newStart = date;
      newEnd = oldEnd;
      if (newStart >= newEnd) newEnd = addDays(newStart, oldSpan);
    } else {
      newStart = oldStart;
      newEnd = date;
      if (newEnd <= newStart) newStart = addDays(newEnd, -oldSpan);
    }
    const newSpan = diffDays(newStart, newEnd) || 1;
    const ratio = newSpan / oldSpan;

    const newProject = {
      ...project,
      phases: project.phases.map(p => {
        if (p.id !== phaseId) return p;
        return {
          ...p,
          tasks: p.tasks.map(t => {
            const tStart = parseISODateLocal(t.startDate);
            const offsetFromOldStart = diffDays(oldStart, tStart);
            const newTaskStart = addDays(newStart, Math.round(offsetFromOldStart * ratio));
            const newDuration = Math.max(1, Math.round(t.duration * ratio));
            return { ...t, startDate: dateToISO(newTaskStart), duration: newDuration };
          }),
        };
      }),
    };
    onProjectChange(newProject);
  };

  const commitWithDependencyPropagation = useCallback((
    projectToCommit: Project,
    taskId: string,
    includeEditedTask = false,
  ) => {
    if (!onProjectChange) return;
    const allTasks = getAllTasks(projectToCommit);
    const result = includeEditedTask
      ? recalculateTaskAndSuccessors(allTasks, taskId, obraConfig)
      : propagateAllDependencies(allTasks, taskId, obraConfig);
    const updatedById = new Map(result.tasks.map(task => [task.id, task]));
    const nextProject = result.changed
      ? {
          ...projectToCommit,
          phases: projectToCommit.phases.map(phase => ({
            ...phase,
            tasks: phase.tasks.map(task => updatedById.get(task.id) ?? task),
          })),
        }
      : projectToCommit;

    onProjectChange(nextProject);
    if (result.changed) {
      const types = Array.from(result.adjustedTypes).join(', ');
      toast.info(`Datas ajustadas automaticamente por depend\u00eancia${types ? ` [${types}]` : ''}`);
    }
  }, [obraConfig, onProjectChange]);

  const submitTaskReschedule = useCallback((request: Parameters<typeof submitRescheduleRequest>[1], approveNow: boolean) => {
    if (!onProjectChange) return;
    const requested = submitRescheduleRequest(project, request, auditActor);
    onProjectChange(approveNow ? approveRescheduleRequest(requested, request.id, obraConfig, auditActor) : requested);
    toast.success(approveNow ? 'Atividade reprogramada e dependências atualizadas.' : 'Solicitação de reprogramação enviada para aprovação.');
  }, [auditActor, obraConfig, onProjectChange, project]);

  const approveTaskReschedule = useCallback((requestId: string) => {
    if (!onProjectChange) return;
    onProjectChange(approveRescheduleRequest(project, requestId, obraConfig, auditActor));
    toast.success('Reprogramação aprovada e aplicada ao cronograma.');
  }, [auditActor, obraConfig, onProjectChange, project]);

  const rejectTaskReschedule = useCallback((requestId: string, reason: string) => {
    if (!onProjectChange) return;
    onProjectChange(rejectRescheduleRequest(project, requestId, reason, auditActor));
    toast.info('Reprogramação rejeitada.');
  }, [auditActor, onProjectChange, project]);


  // Compute temporary propagation for real-time drag preview
  const computeDragPropagation = useCallback((taskId: string, newStartDate: string) => {
    const allTasks = getAllTasks(project).map(t =>
      t.id === taskId ? { ...t, startDate: newStartDate } : t
    );
    const result = propagateAllDependencies(allTasks, taskId, obraConfig);
    const tempMap = new Map<string, { startDate: string }>();
    result.tasks.forEach(t => {
      if (t.id !== taskId) {
        tempMap.set(t.id, { startDate: t.startDate });
      }
    });
    return tempMap;
  }, [project, obraConfig]);

  const handleMouseDown = (e: React.MouseEvent, taskId: string, barLeft: number) => {
    e.preventDefault();
    setDraggingTaskId(taskId);
    dragStartX.current = e.clientX;
    dragStartLeft.current = barLeft;
    setDragOffset(0);
    setDragTempTasks(new Map());

    lastDragDays.current = null;
    dragRafPending.current = false;

    // Sessões de mutação: arrastada + propagadas. Cada sessão guarda o snapshot
    // inline original e só é capaz de tocar nas propriedades declaradas.
    const draggedEl = barRefs.current.get(taskId);
    const draggedSession = beginBarMutation(draggedEl, ['transform', 'transition']);
    const successorSessions = new Map<string, { session: BarMutationSession; origLeft: number }>();

    const cleanup = () => {
      endBarMutation(draggedSession);
      endAllBarMutations(Array.from(successorSessions.values()).map(s => s.session));
      successorSessions.clear();
    };

    const handleMove = (ev: MouseEvent) => {
      lastDragDx.current = ev.clientX - dragStartX.current;
      if (dragRafPending.current) return;
      dragRafPending.current = true;
      requestAnimationFrame(() => {
        dragRafPending.current = false;
        const dx = lastDragDx.current;
        // Mutação DOM via camada utilitária — sem setState, sem re-render
        setTransition(draggedSession, 'none');
        setTransform(draggedSession, `translateX(${dx}px)`);

        const daysMoved = Math.round(dx / dayWidth);
        if (daysMoved !== lastDragDays.current) {
          lastDragDays.current = daysMoved;
          const task = tasks.find(t => t.id === taskId);
          if (!task) return;
          const newStart = addDays(parseISODateLocal(task.startDate), daysMoved);
          const tempMap = computeDragPropagation(taskId, dateToISO(newStart));

          // Encerra sucessores que não estão mais propagados
          for (const [sid, info] of successorSessions) {
            if (!tempMap.has(sid)) {
              endBarMutation(info.session);
              successorSessions.delete(sid);
            }
          }

          // Aplica/atualiza sucessores presentes
          tempMap.forEach((data, sid) => {
            const sEl = barRefs.current.get(sid);
            if (!sEl) return;
            let entry = successorSessions.get(sid);
            if (!entry) {
              const session = beginBarMutation(sEl, ['transform', 'transition', 'opacity']);
              if (!session) return;
              const origLeft = parseFloat(sEl.style.left || '0') || 0;
              entry = { session, origLeft };
              successorSessions.set(sid, entry);
            }
            const tempStart = diffDays(projectStart, parseISODateLocal(data.startDate));
            const targetLeft = tempStart * dayWidth;
            setTransition(entry.session, 'none');
            setTransform(entry.session, `translateX(${targetLeft - entry.origLeft}px)`);
            setOpacity(entry.session, '0.85');
          });
        }
      });
    };

    const handleUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      window.removeEventListener('blur', handleCancel);
      document.removeEventListener('keydown', handleKey);
      dragRafPending.current = false;

      const dx = ev.clientX - dragStartX.current;
      const daysMoved = Math.round(dx / dayWidth);
      if (daysMoved !== 0) {
        const task = tasks.find(t => t.id === taskId);
        if (task) {
          const newStart = addDays(parseISODateLocal(task.startDate), daysMoved);
          const newStartISO = dateToISO(newStart);

          // Check precedence violation (if this task is a successor)
          const violation = checkDependencyViolation(task, newStartISO, tasks, obraConfig);
          if (violation) {
            toast.error(`Não é possível: a tarefa depende do término da tarefa "${violation.predName}" (${violation.type})`, {
              action: {
                label: 'Forçar mesmo assim',
                onClick: () => {
                  const newDetails = (task.dependencyDetails || []).filter(d => d.taskId !== violation.predId);
                  const newDeps = newDetails.map(d => d.taskId);
                  const updatedProject = {
                    ...project,
                    phases: project.phases.map(phase => ({
                      ...phase,
                      tasks: phase.tasks.map(t => t.id === taskId
                        ? { ...t, startDate: newStartISO, dependencies: newDeps, dependencyDetails: newDetails }
                        : t),
                    })),
                  };
                  onProjectChange?.(updatedProject);
                  toast.info('Dependência removida e tarefa movida');
                },
              },
            });
          } else {
            const updatedProject = {
              ...project,
              phases: project.phases.map(phase => ({
                ...phase,
                tasks: phase.tasks.map(t => t.id === taskId ? { ...t, startDate: newStartISO } : t),
              })),
            };
            commitWithDependencyPropagation(updatedProject, taskId);
          }
        }
      }
      cleanup();
      setDraggingTaskId(null);
      setDragOffset(0);
      setDragTempTasks(new Map());
    };

    // Cancelamento (ESC, perda de foco da janela, etc.) — limpa sem aplicar
    const handleCancel = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      window.removeEventListener('blur', handleCancel);
      document.removeEventListener('keydown', handleKey);
      dragRafPending.current = false;
      cleanup();
      setDraggingTaskId(null);
      setDragOffset(0);
      setDragTempTasks(new Map());
    };
    const handleKey = (kev: KeyboardEvent) => {
      if (kev.key === 'Escape') handleCancel();
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    window.addEventListener('blur', handleCancel);
    document.addEventListener('keydown', handleKey);
  };

  const handleDepChange = (taskId: string, value: string) => {
    if (!onProjectChange || isTaskScheduleLocked(taskId)) return;
    const nums = value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const existingDetails = task.dependencyDetails || [];
    const existingByTaskId = new Map(existingDetails.map(d => [d.taskId, d.type]));
    const deps: TaskDependency[] = [];
    const seen = new Set<string>();
    let ignored = 0;

    for (const num of nums) {
      const depTaskId = numberToTaskId.get(num);
      if (!depTaskId || depTaskId === taskId || seen.has(depTaskId)) {
        ignored++;
        continue;
      }
      const tasksWithAcceptedDependencies = tasks.map(item => item.id === taskId
        ? { ...item, dependencies: deps.map(dep => dep.taskId), dependencyDetails: deps }
        : item);
      if (wouldCreateDependencyCycle(tasksWithAcceptedDependencies, taskId, depTaskId)) {
        ignored++;
        continue;
      }
      seen.add(depTaskId);
      deps.push({ taskId: depTaskId, type: existingByTaskId.get(depTaskId) || 'TI' });
    }
    const unchanged = deps.length === existingDetails.length
      && deps.every((dependency, index) => (
        dependency.taskId === existingDetails[index]?.taskId
        && dependency.type === existingDetails[index]?.type
      ));
    if (unchanged) {
      if (ignored > 0) toast.warning('Depend\u00eancias inv\u00e1lidas, duplicadas ou c\u00edclicas foram ignoradas.');
      return;
    }
    const updatedProject = {
      ...project,
      phases: project.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(t => t.id === taskId
          ? { ...t, dependencies: deps.map(d => d.taskId), dependencyDetails: deps }
          : t),
        })),
    };
    commitWithDependencyPropagation(updatedProject, taskId, true);
    if (ignored > 0) toast.warning('Depend\u00eancias inv\u00e1lidas, duplicadas ou c\u00edclicas foram ignoradas.');
  };

  const handleDependencyKeyDown = (taskId: string, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const inputs = Array.from(ganttRootRef.current?.querySelectorAll<HTMLInputElement>(
      '[data-gantt-dependency-input="true"]:not(:disabled)',
    ) ?? []);
    const currentIndex = inputs.indexOf(event.currentTarget);
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    const targetTaskId = inputs[currentIndex + direction]?.dataset.ganttDependencyTaskId ?? taskId;

    // O blur confirma a edição uma única vez; depois buscamos o DOM atualizado e movemos o foco.
    event.currentTarget.blur();
    window.setTimeout(() => {
      const nextInput = Array.from(ganttRootRef.current?.querySelectorAll<HTMLInputElement>(
        '[data-gantt-dependency-input="true"]:not(:disabled)',
      ) ?? []).find(input => input.dataset.ganttDependencyTaskId === targetTaskId);
      nextInput?.focus();
      nextInput?.select();
    }, 0);
  };

  const handleDepTypeChange = (taskId: string, depIndex: number, newType: DependencyType) => {
    if (!onProjectChange || isTaskScheduleLocked(taskId)) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const details = [...(task.dependencyDetails || [])];
    if (depIndex < details.length) {
      details[depIndex] = { ...details[depIndex], type: newType };
      const updatedProject = {
        ...project,
        phases: project.phases.map(phase => ({
          ...phase,
          tasks: phase.tasks.map(t => t.id === taskId
            ? { ...t, dependencies: details.map(d => d.taskId), dependencyDetails: details }
            : t),
        })),
      };
      commitWithDependencyPropagation(updatedProject, taskId, true);
    }
  };

  const getDepDisplay = (task: Task): string => {
    return (task.dependencyDetails || []).map(d => {
      const num = taskNumbering.get(d.taskId);
      return num ? String(num) : '';
    }).filter(Boolean).join(', ');
  };

  const getDepTypes = (task: Task) => {
    return (task.dependencyDetails || []).map((d, index) => ({
      taskId: d.taskId, type: d.type, num: taskNumbering.get(d.taskId) || 0, index,
    })).filter(d => d.num > 0);
  };

  const financialByMonth = useMemo(
    () => new Map((monthlyFinancialForecast ?? []).map(month => [month.key, month])),
    [monthlyFinancialForecast],
  );
  const showMonthlyFinancialHeader = financialByMonth.size > 0 && viewMode !== 'days';
  const headerHeightPx = viewMode === 'weeks'
    ? (showMonthlyFinancialHeader ? 68 : 52)
    : viewMode === 'months' && showMonthlyFinancialHeader ? 54 : 32;
  const formatHeaderMoney = (value: number) => value.toLocaleString('pt-BR', {
    style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  const getDragDate = (task: Task) => {
    if (draggingTaskId !== task.id) return null;
    const daysMoved = Math.round(dragOffset / dayWidth);
    const newStart = addDays(parseISODateLocal(task.startDate), daysMoved);
    const newEnd = addDays(newStart, Math.max(0, task.duration - 1));
  };

  // Forecast delay (em dias) baseado no ritmo médio dos apontamentos
  const calcForecastDelay = (task: Task): number | null => {
    const logs = (task.dailyLogs || []).filter(l => (l.actualQuantity ?? 0) > 0);
    if (logs.length === 0 || !task.quantity || !task.duration) return null;
    const executed = logs.reduce((s, l) => s + (l.actualQuantity || 0), 0);
    const remaining = task.quantity - executed;
    if (remaining <= 0) return 0;
    const avgDaily = executed / logs.length;
    if (avgDaily <= 0) return null;
    const daysNeeded = Math.ceil(remaining / avgDaily);
    const plannedRemaining = task.duration - logs.length;
    return daysNeeded - plannedRemaining;
  };

  // Check if task has zero working days
  const hasNoWorkingDays = useCallback((task: Task) => {
    const start = parseISODateLocal(task.startDate);
    const end = addDays(start, task.duration);
    const result = calcularDiasUteis(start, end, obraConfig.uf, obraConfig.municipio, obraConfig.trabalhaSabado, obraConfig.jornadaDiaria);
    return result.dias === 0;
  }, [obraConfig]);

  const showSuspensionColumn = context === 'additive-preview';
  // Datas continuam legíveis, mas a descrição recebe o espaço predominante.
  // A mesma grade é aplicada ao cabeçalho, às linhas e aos dois cronogramas.
  const sidebarCols = `${showSuspensionColumn ? '34px ' : ''}22px minmax(285px, 1fr) 74px 74px 44px 56px 62px`;
  const sidebarWidth = showSuspensionColumn ? 710 : 676;

  // Toggle duration mode and recalculate if switching to RUP
  const toggleDurationMode = (taskId: string) => {
    if (isTaskScheduleLocked(taskId)) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const currentMode = task.durationMode || 'manual';
    const newMode = currentMode === 'manual' ? 'rup' : 'manual';
    const updates: Partial<Task> = { durationMode: newMode };
    if (newMode === 'rup' && task.laborCompositions?.length && task.quantity) {
      const { duration, totalHours, bottleneckRole } = calculateRupDuration(task, obraConfig);
      updates.duration = duration;
      updates.totalHours = totalHours;
      updates.bottleneckRole = bottleneckRole;
      updates.calculatedDuration = duration;
    }
    const updatedProject: Project = {
      ...project,
      phases: project.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(item => item.id === taskId ? { ...item, ...updates } : item),
      })),
    };
    commitWithDependencyPropagation(updatedProject, taskId);
  };

  const handleManualDurationChange = (taskId: string, value: number) => {
    if (value < 1 || isTaskScheduleLocked(taskId)) return;
    const updatedProject = {
      ...project,
      phases: project.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(t => t.id === taskId
          ? { ...t, duration: value, durationMode: 'manual' as const, isManual: true, manualDuration: value }
          : t),
      })),
    };
    commitWithDependencyPropagation(updatedProject, taskId);
  };

  // Resize handlers
  const handleResizeMouseDown = (e: React.MouseEvent, taskId: string, side: 'left' | 'right') => {
    if (isTaskScheduleLocked(taskId)) return;
    e.preventDefault();
    e.stopPropagation();
    setResizingTaskId(taskId);
    setResizeSide(side);
    setResizeDelta(0);
    resizeStartX.current = e.clientX;

    // Captura largura/posição original da barra
    const barEl = barRefs.current.get(taskId);
    const origWidth = barEl ? barEl.getBoundingClientRect().width : 0;
    const origLeftPx = barEl ? (parseFloat(barEl.style.left || '0') || 0) : 0;
    const minWidth = dayWidth;

    // Sessão owna left + width + transition (não toca em transform/opacity etc.)
    const session = beginBarMutation(barEl, ['left', 'width', 'transition']);

    let resizeRafPending = false;
    let lastResizeDx = 0;
    const handleMove = (ev: MouseEvent) => {
      lastResizeDx = ev.clientX - resizeStartX.current;
      if (resizeRafPending) return;
      resizeRafPending = true;
      requestAnimationFrame(() => {
        resizeRafPending = false;
        if (!session) return;
        const dx = lastResizeDx;
        setTransition(session, 'none');
        if (side === 'right') {
          setWidthPx(session, Math.max(minWidth, origWidth + dx));
        } else {
          const delta = Math.min(dx, origWidth - minWidth);
          setLeftPx(session, origLeftPx + delta);
          setWidthPx(session, origWidth - delta);
        }
      });
    };

    const finalize = (commitDx: number | null) => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      window.removeEventListener('blur', handleCancel);
      document.removeEventListener('keydown', handleKey);
      resizeRafPending = false;

      if (commitDx !== null) {
        const daysDelta = Math.round(commitDx / dayWidth);
        const task = tasks.find(t => t.id === taskId);
        if (task && daysDelta !== 0) {
          let updates: Partial<Task>;
          if (side === 'right') {
            const newDuration = Math.max(1, task.duration + daysDelta);
            updates = { duration: newDuration, durationMode: 'manual', isManual: true, manualDuration: newDuration };
          } else {
            const newDuration = Math.max(1, task.duration - daysDelta);
            const newStart = addDays(parseISODateLocal(task.startDate), daysDelta);
            updates = { startDate: dateToISO(newStart), duration: newDuration, durationMode: 'manual', isManual: true, manualDuration: newDuration };
          }
          const updatedProject = {
            ...project,
            phases: project.phases.map(phase => ({
              ...phase,
              tasks: phase.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t),
            })),
          };
          commitWithDependencyPropagation(updatedProject, taskId);
        }
      }
      // Restaura APENAS as propriedades que tocamos (left/width/transition)
      endBarMutation(session);
      setResizingTaskId(null);
      setResizeSide(null);
      setResizeDelta(0);
    };

    const handleUp = (ev: MouseEvent) => finalize(ev.clientX - resizeStartX.current);
    const handleCancel = () => finalize(null);
    const handleKey = (kev: KeyboardEvent) => {
      if (kev.key === 'Escape') handleCancel();
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    window.addEventListener('blur', handleCancel);
    document.addEventListener('keydown', handleKey);
  };

  // Helper: get 3 first words of a name
  const getShortLabel = (name: string) => {
    const words = name.split(/\s+/);
    return words.length > 3 ? words.slice(0, 3).join(' ') + '…' : name;
  };

  // Get chapter bar info for milestones
  const getChapterBarInfo = (phase: typeof project.phases[0]) => {
    const items = getVisiblePhaseTasks(phase).filter(task => !isStatusOnlyTask(task.id));
    if (items.length === 0) return null;
    const starts = items.map(t => parseISODateLocal(t.startDate).getTime());
    const ends = items.map(t => addDays(parseISODateLocal(t.startDate), t.duration).getTime());
    const minStart = new Date(Math.min(...starts));
    const maxEnd = new Date(Math.max(...ends));
    const left = diffDays(projectStart, minStart) * dayWidth;
    const right = diffDays(projectStart, maxEnd) * dayWidth;
    return { left, right, width: Math.max(dayWidth, right - left) };
  };

  // Get day column background color
  const getDayBg = (dayIndex: number): string | undefined => {
    if (dayIndex < 0 || dayIndex >= dayInfos.length) return undefined;
    const info = dayInfos[dayIndex];
    if (info.feriado) {
      return info.feriado.tipo === 'nacional'
        ? 'hsl(var(--gantt-holiday-national))'
        : 'hsl(var(--gantt-holiday-local))';
    }
    if (info.dow === 0) return 'hsl(var(--gantt-sunday))';
    if (info.dow === 6) return 'hsl(var(--gantt-saturday))';
    return undefined;
  };

  return (
    <TooltipProvider>
      <div ref={ganttRootRef} className="p-4 space-y-3">
        {/* Toolbar */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-lg font-bold text-foreground">{title}</h2>
            <p className="text-[10px] text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            {undoButton}
            <ConfiguracaoObra config={obraConfig} onConfigChange={setObraConfig} />
            <button
              onClick={() => setShowCriticalOnly(!showCriticalOnly)}
              className={`flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-md border transition-colors ${
                showCriticalOnly
                  ? 'bg-destructive/10 border-destructive/30 text-destructive'
                  : 'bg-card border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <AlertTriangle className="w-3 h-3" />
              Crítico ({criticalCount})
            </button>
            <div className="flex gap-0.5 bg-secondary rounded-md p-0.5">
              {(['days', 'weeks', 'months'] as ViewMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`px-2.5 py-1 text-[10px] font-medium rounded transition-colors ${
                    viewMode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m === 'days' ? 'Dias' : m === 'weeks' ? 'Semanas' : 'Meses'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-2 shadow-sm">
          <div className="flex flex-wrap items-end gap-2 text-[10px]">
            <label className="flex min-w-[160px] flex-col gap-1">
              <span className="font-medium text-muted-foreground">Equipe</span>
              <Select value={teamFilter} onValueChange={setTeamFilter}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Todas as equipes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as equipes</SelectItem>
                  <SelectItem value="_none">Sem equipe</SelectItem>
                  {projectTeams.map(team => (
                    <SelectItem key={team.code} value={team.code}>{team.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="flex min-w-[220px] flex-col gap-1">
              <span className="font-medium text-muted-foreground">Capítulo/Subcapítulo</span>
              <Select value={phaseFilter} onValueChange={setPhaseFilter}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Todos os capítulos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os capítulos</SelectItem>
                  {allPhases.map(phase => (
                    <SelectItem key={phase.id} value={phase.id}>
                      {chapterNumbering.get(phase.id) ? `${chapterNumbering.get(phase.id)} - ` : ''}{phase.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={showZeroSuppressed}
                onChange={e => setShowZeroSuppressed(e.target.checked)}
              />
              <span>Mostrar itens zerados/suprimidos</span>
            </label>
            <label className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={showDelayedOnly}
                onChange={e => setShowDelayedOnly(e.target.checked)}
              />
              <span>Apenas atrasados</span>
            </label>
            <label className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5">
              <input
                type="checkbox"
                checked={showWithDependenciesOnly}
                onChange={e => setShowWithDependenciesOnly(e.target.checked)}
              />
              <span>Com dependência</span>
            </label>

            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCollapsedPhases(new Set())}
                className="h-8 rounded-md border border-border bg-background px-2.5 font-medium text-muted-foreground hover:text-foreground"
              >
                Expandir tudo
              </button>
              <button
                type="button"
                onClick={() => setCollapsedPhases(new Set(allPhases.map(phase => phase.id)))}
                className="h-8 rounded-md border border-border bg-background px-2.5 font-medium text-muted-foreground hover:text-foreground"
              >
                Recolher tudo
              </button>
              <div className="flex h-8 rounded-md bg-secondary p-0.5">
                {(['comfortable', 'compact'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setDensity(mode)}
                    className={`rounded px-2 text-[10px] font-medium transition-colors ${
                      density === mode ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {mode === 'comfortable' ? 'Confortável' : 'Compacta'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <details className="group rounded-lg border border-border bg-card shadow-sm">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div>
              <h3 className="text-sm font-semibold">Análises do Cronograma</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Mão de obra, disponibilidade e previsão físico-financeira.</p>
            </div>
            <span className="text-xs font-semibold text-primary group-open:hidden">Abrir análises</span>
            <span className="hidden text-xs font-semibold text-primary group-open:inline">Recolher</span>
          </summary>

        <div className="border-t border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto">
              <h3 className="text-sm font-semibold text-foreground">Análise de mão de obra do Cronograma</h3>
              <p className="text-[10px] text-muted-foreground">
                Separa déficit real, falta de cadastro e tarefas sem RUP antes de sugerir reprogramação.
              </p>
            </div>
            {highlightedLaborTaskIds.size > 0 && (
              <button
                type="button"
                onClick={clearLaborHighlight}
                className="h-8 rounded-md border border-blue-200 bg-blue-50 px-2.5 text-[10px] font-semibold text-blue-700 hover:bg-blue-100"
              >
                Limpar destaque ({highlightedLaborTaskIds.size})
              </button>
            )}
            <button
              type="button"
              onClick={() => setLaborPanelExpanded(prev => !prev)}
              className="h-8 rounded-md border border-border bg-background px-3 text-[10px] font-semibold text-foreground hover:bg-secondary"
            >
              {laborPanelExpanded ? 'Recolher análise' : 'Abrir análise'}
            </button>
          </div>

          <div className="mt-2 grid gap-2 md:grid-cols-5">
            <button
              type="button"
              onClick={() => { setLaborIssueMode('deficit'); setLaborPanelExpanded(true); }}
              className={`rounded-md border p-2 text-left transition-colors ${
                laborPlanning.totalDeficitPeriods > 0 ? 'border-orange-300 bg-orange-50 hover:bg-orange-100' : 'border-emerald-200 bg-emerald-50 hover:bg-emerald-100'
              }`}
            >
              <div className="text-[9px] font-semibold uppercase text-muted-foreground">Déficit real</div>
              <div className={`text-lg font-bold ${laborPlanning.totalDeficitPeriods > 0 ? 'text-orange-700' : 'text-emerald-700'}`}>
                {laborPlanning.totalDeficitPeriods}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {laborTopDeficit
                  ? `${laborTopDeficit.roleName}: faltam ${Math.abs(laborTopDeficit.balancePeople)} em ${laborTopDeficit.periodLabel}`
                  : 'Disponibilidade suficiente onde foi cadastrada'}
              </div>
            </button>
            <button
              type="button"
              onClick={() => { setLaborIssueMode('availability'); setLaborPanelExpanded(true); }}
              className={`rounded-md border p-2 text-left transition-colors ${
                laborPlanning.totalMissingAvailabilityPeriods > 0 ? 'border-amber-300 bg-amber-50 hover:bg-amber-100' : 'border-emerald-200 bg-emerald-50 hover:bg-emerald-100'
              }`}
            >
              <div className="text-[9px] font-semibold uppercase text-muted-foreground">Sem disponibilidade</div>
              <div className={`text-lg font-bold ${laborPlanning.totalMissingAvailabilityPeriods > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                {laborPlanning.totalMissingAvailabilityPeriods}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">Cargo usado, mas capacidade não cadastrada</div>
            </button>
            <button
              type="button"
              onClick={() => { setLaborIssueMode('data'); setLaborPanelExpanded(true); }}
              className={`rounded-md border p-2 text-left transition-colors ${
                laborPlanning.dataIssues.length > 0 ? 'border-slate-300 bg-slate-50 hover:bg-slate-100' : 'border-emerald-200 bg-emerald-50 hover:bg-emerald-100'
              }`}
            >
              <div className="text-[9px] font-semibold uppercase text-muted-foreground">Dados incompletos</div>
              <div className="text-lg font-bold text-foreground">{laborPlanning.dataIssues.length}</div>
              <div className="truncate text-[10px] text-muted-foreground">Sem RUP, sem quantidade ou normalização</div>
            </button>
            <div className={`rounded-md border p-2 ${laborPlanning.teamConflicts.length > 0 ? 'border-yellow-300 bg-yellow-50' : 'border-emerald-200 bg-emerald-50'}`}>
              <div className="text-[9px] font-semibold uppercase text-muted-foreground">Equipe sobreposta</div>
              <div className={`text-lg font-bold ${laborPlanning.teamConflicts.length > 0 ? 'text-yellow-700' : 'text-emerald-700'}`}>
                {laborPlanning.teamConflicts.length}
              </div>
              <div className="truncate text-[10px] text-muted-foreground">
                {laborPlanning.teamConflicts[0]
                  ? `${laborPlanning.teamConflicts[0].teamName} em ${laborPlanning.teamConflicts[0].periodLabel}`
                  : 'Sem sobreposição de equipe'}
              </div>
            </div>
            <div className="rounded-md border border-blue-200 bg-blue-50 p-2">
              <div className="text-[9px] font-semibold uppercase text-muted-foreground">Pico planejado</div>
              <div className="text-lg font-bold text-blue-700">{laborPlanning.peakPeople}</div>
              <div className="truncate text-[10px] text-muted-foreground">{laborPlanning.peakPeriod}</div>
            </div>
          </div>

          {!laborPanelExpanded && (
            <div className="mt-2 rounded-md border border-dashed border-border bg-background px-3 py-2 text-[10px] text-muted-foreground">
              Abra a análise para investigar as atividades causadoras. O Gantt fica limpo até você precisar decidir.
            </div>
          )}

          {laborPanelExpanded && (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={laborPeriodMode} onValueChange={(value) => setLaborPeriodMode(value as LaborPlanningGranularity)}>
                  <SelectTrigger className="h-8 w-[120px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="day">Diário</SelectItem>
                    <SelectItem value="week">Semanal</SelectItem>
                    <SelectItem value="month">Mensal</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex h-8 rounded-md bg-secondary p-0.5">
                  {([
                    ['deficit', 'Déficits'],
                    ['availability', 'Disponibilidade'],
                    ['data', 'Dados'],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setLaborIssueMode(mode)}
                      className={`rounded px-2 text-[10px] font-medium transition-colors ${
                        laborIssueMode === mode ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {laborIssueMode === 'deficit' && (
                  <label className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[10px]">
                    <input
                      type="checkbox"
                      checked={showLaborOnlyDeficits}
                      onChange={e => setShowLaborOnlyDeficits(e.target.checked)}
                    />
                    <span>Só déficits</span>
                  </label>
                )}
              </div>

              {laborIssueMode !== 'data' ? (
                <div className="overflow-hidden rounded-md border border-border">
                  <div className="grid grid-cols-[110px_1fr_64px_64px_64px_1.6fr_90px] bg-secondary/60 px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground">
                    <span>Período</span>
                    <span>Cargo</span>
                    <span className="text-center">Disp.</span>
                    <span className="text-center">Nec.</span>
                    <span className="text-center">Saldo</span>
                    <span>Atividades responsáveis</span>
                    <span className="text-right">Ação</span>
                  </div>
                  {laborRowsToShow.length > 0 ? laborRowsToShow.map(row => (
                    <div
                      key={`${row.periodKey}-${row.roleId}`}
                      className={`grid grid-cols-[110px_1fr_64px_64px_64px_1.6fr_90px] items-center border-t border-border px-2 py-1.5 text-[10px] ${
                        row.status === 'deficit' ? 'bg-orange-50/70' : row.status === 'missing_availability' ? 'bg-amber-50/70' : row.status === 'surplus' ? 'bg-blue-50/60' : 'bg-card'
                      }`}
                    >
                      <span className="font-medium text-foreground">{row.periodLabel}</span>
                      <span>{row.roleName}</span>
                      <span className="text-center tabular-nums">{row.availabilityConfigured ? row.availablePeople : '—'}</span>
                      <span className="text-center font-semibold tabular-nums">{row.recommendedPeople}</span>
                      <span className={`text-center font-bold tabular-nums ${row.status === 'deficit' ? 'text-orange-700' : row.status === 'missing_availability' ? 'text-amber-700' : 'text-emerald-700'}`}>
                        {row.status === 'missing_availability' ? 'cad.' : row.balancePeople > 0 ? `+${row.balancePeople}` : row.balancePeople}
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => highlightLaborTasks(row.activities.map(activity => activity.taskId))}
                            className="truncate text-left text-muted-foreground hover:text-foreground"
                          >
                            {row.activities.slice(0, 3).map(activity => activity.taskName).join(' • ')}
                            {row.activities.length > 3 ? ` +${row.activities.length - 3}` : ''}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-lg whitespace-normal text-xs">
                          <div className="space-y-1">
                            {row.activities.slice(0, 8).map(activity => (
                              <div key={activity.taskId}>
                                <strong>{activity.taskName}</strong>
                                <span className="text-muted-foreground"> — {activity.teamName ?? 'sem equipe'} • {Math.round(activity.hours)}h</span>
                              </div>
                            ))}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                      <button
                        type="button"
                        onClick={() => highlightLaborTasks(row.activities.map(activity => activity.taskId))}
                        className="justify-self-end rounded border border-border bg-background px-2 py-1 text-[9px] font-semibold text-foreground hover:bg-secondary"
                      >
                        Ver no Gantt
                      </button>
                    </div>
                  )) : (
                    <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                      Sem ocorrências para o filtro atual.
                    </div>
                  )}
                </div>
              ) : (
                <div className="overflow-hidden rounded-md border border-border">
                  <div className="grid grid-cols-[1.3fr_1fr_1.5fr_90px] bg-secondary/60 px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground">
                    <span>Tarefa</span>
                    <span>Capítulo</span>
                    <span>O que falta</span>
                    <span className="text-right">Ação</span>
                  </div>
                  {laborDataIssuesToShow.length > 0 ? laborDataIssuesToShow.map(issue => (
                    <div
                      key={`${issue.taskId}-${issue.issue}`}
                      className="grid grid-cols-[1.3fr_1fr_1.5fr_90px] items-center border-t border-border bg-slate-50/70 px-2 py-1.5 text-[10px]"
                    >
                      <span className="font-medium text-foreground">{issue.taskName}</span>
                      <span className="truncate text-muted-foreground">{issue.phaseName}</span>
                      <span className="text-muted-foreground">{issue.message}</span>
                      <button
                        type="button"
                        onClick={() => highlightLaborTasks([issue.taskId])}
                        className="justify-self-end rounded border border-border bg-background px-2 py-1 text-[9px] font-semibold text-foreground hover:bg-secondary"
                      >
                        Ver no Gantt
                      </button>
                    </div>
                  )) : (
                    <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                      Sem pendências de RUP ou normalização nas tarefas calculadas.
                    </div>
                  )}
                </div>
              )}

              {laborPlanning.teamConflicts.length > 0 && (
                <div className="rounded-md border border-yellow-300 bg-yellow-50/60 px-3 py-2 text-[10px] text-yellow-900">
                  <strong>Equipe sobreposta:</strong>{' '}
                  {laborPlanning.teamConflicts[0].teamName} em {laborPlanning.teamConflicts[0].periodLabel}.
                  <button
                    type="button"
                    onClick={() => highlightLaborTasks(laborPlanning.teamConflicts[0].tasks.map(task => task.taskId))}
                    className="ml-2 rounded border border-yellow-300 bg-white px-2 py-0.5 font-semibold text-yellow-900 hover:bg-yellow-100"
                  >
                    Destacar atividades
                  </button>
                </div>
              )}

              {laborPlanning.suggestions.length > 0 && laborIssueMode === 'deficit' && (
                <div className="rounded-md border border-dashed border-orange-300 bg-orange-50/60 px-3 py-2 text-[10px] text-orange-900">
                  <strong>Simulação inicial:</strong>{' '}
                  {laborPlanning.suggestions[0].taskName} para {formatDateFull(laborPlanning.suggestions[0].suggestedStartDate)}.
                  <span className="ml-1 text-orange-800">{laborPlanning.suggestions[0].impactNote}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Painel legado preservado temporariamente durante a migração visual.
        <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="mr-auto">
              <h3 className="text-sm font-semibold text-foreground">Planejamento de mão de obra</h3>
              <p className="text-[10px] text-muted-foreground">
                Compara RUP + datas do Cronograma contra a disponibilidade cadastrada da obra.
              </p>
            </div>
            <Select value={laborPeriodMode} onValueChange={(value) => setLaborPeriodMode(value as LaborPlanningGranularity)}>
              <SelectTrigger className="h-8 w-[120px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Diário</SelectItem>
                <SelectItem value="week">Semanal</SelectItem>
                <SelectItem value="month">Mensal</SelectItem>
              </SelectContent>
            </Select>
            <label className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[10px]">
              <input
                type="checkbox"
                checked={showLaborOnlyDeficits}
                onChange={e => setShowLaborOnlyDeficits(e.target.checked)}
              />
              <span>Só déficits</span>
            </label>
          </div>

          <div className="grid gap-2 md:grid-cols-4">
            <div className={`rounded-md border p-2 ${laborPlanning.totalDeficitPeriods > 0 ? 'border-orange-300 bg-orange-50' : 'border-emerald-200 bg-emerald-50'}`}>
              <div className="text-xs font-semibold uppercase text-muted-foreground">Períodos com déficit</div>
              <div className={`text-lg font-bold ${laborPlanning.totalDeficitPeriods > 0 ? 'text-orange-700' : 'text-emerald-700'}`}>
                {laborPlanning.totalDeficitPeriods}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {laborTopDeficit
                  ? `${laborTopDeficit.roleName}: faltam ${Math.abs(laborTopDeficit.balancePeople)} em ${laborTopDeficit.periodLabel}`
                  : 'Capacidade suficiente nos períodos calculados'}
              </div>
            </div>
            <div className="rounded-md border border-blue-200 bg-blue-50 p-2">
              <div className="text-[9px] font-semibold uppercase text-muted-foreground">Pico planejado</div>
              <div className="text-lg font-bold text-blue-700">{laborPlanning.peakPeople}</div>
              <div className="text-[10px] text-muted-foreground">{laborPlanning.peakPeriod}</div>
            </div>
            <div className={`rounded-md border p-2 ${laborPlanning.teamConflicts.length > 0 ? 'border-amber-300 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
              <div className="text-[9px] font-semibold uppercase text-muted-foreground">Conflitos de equipe</div>
              <div className={`text-lg font-bold ${laborPlanning.teamConflicts.length > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                {laborPlanning.teamConflicts.length}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {laborPlanning.teamConflicts[0]
                  ? `${laborPlanning.teamConflicts[0].teamName} em ${laborPlanning.teamConflicts[0].periodLabel}`
                  : 'Nenhuma equipe sobreposta'}
              </div>
            </div>
            <div className="rounded-md border border-border bg-background p-2">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Sugestões iniciais</div>
              <div className="text-lg font-bold text-foreground">{laborPlanning.suggestions.length}</div>
              <div className="text-xs text-muted-foreground">Reprogramações para revisar manualmente</div>
            </div>
          </div>

          <div className="mt-2 overflow-hidden rounded-md border border-border">
            <div className="grid grid-cols-[120px_1fr_70px_70px_70px_1.7fr] bg-secondary/60 px-2 py-1 text-[9px] font-semibold uppercase text-muted-foreground">
              <span>Período</span>
              <span>Cargo</span>
              <span className="text-center">Disp.</span>
              <span className="text-center">Nec.</span>
              <span className="text-center">Saldo</span>
              <span>Atividades responsáveis</span>
            </div>
            {laborRowsToShow.length > 0 ? laborRowsToShow.map(row => (
              <div
                key={`${row.periodKey}-${row.roleId}`}
                className={`grid grid-cols-[120px_1fr_70px_70px_70px_1.7fr] items-center border-t border-border px-2 py-1.5 text-[10px] ${
                  row.status === 'deficit' ? 'bg-orange-50/70' : row.status === 'surplus' ? 'bg-blue-50/60' : 'bg-card'
                }`}
              >
                <span className="font-medium text-foreground">{row.periodLabel}</span>
                <span>{row.roleName}</span>
                <span className="text-center tabular-nums">{row.availablePeople}</span>
                <span className="text-center font-semibold tabular-nums">{row.recommendedPeople}</span>
                <span className={`text-center font-bold tabular-nums ${row.balancePeople < 0 ? 'text-orange-700' : 'text-emerald-700'}`}>
                  {row.balancePeople > 0 ? `+${row.balancePeople}` : row.balancePeople}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="truncate text-muted-foreground">
                      {row.activities.slice(0, 3).map(activity => activity.taskName).join(' â€¢ ')}
                      {row.activities.length > 3 ? ` +${row.activities.length - 3}` : ''}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-lg whitespace-normal text-xs">
                    <div className="space-y-1">
                      {row.activities.slice(0, 8).map(activity => (
                        <div key={activity.taskId}>
                          <strong>{activity.taskName}</strong>
                          <span className="text-muted-foreground"> â€” {activity.teamName ?? 'sem equipe'} â€¢ {Math.round(activity.hours)}h</span>
                        </div>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            )) : (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                Sem demanda de mão de obra para o filtro atual.
              </div>
            )}
          </div>

          {laborPlanning.suggestions.length > 0 && (
            <div className="mt-2 rounded-md border border-dashed border-orange-300 bg-orange-50/60 px-3 py-2 text-[10px] text-orange-900">
              <strong>Sugestão de reprogramação:</strong>{' '}
              {laborPlanning.suggestions[0].taskName} para {formatDateFull(laborPlanning.suggestions[0].suggestedStartDate)}.
              <span className="ml-1 text-orange-800">{laborPlanning.suggestions[0].impactNote}</span>
            </div>
          )}
        </div>

        */}

        {financialForecastNode === undefined
          ? <GanttFinancialForecast project={project} trabalhaSabado={obraConfig.trabalhaSabado} />
          : financialForecastNode}
        </details>

        {/* Legend */}
        <div className="flex items-center gap-3 text-[9px] text-muted-foreground flex-wrap">
          <div className="flex items-center gap-2 mr-2 border-r border-border pr-3">
            <span className="font-medium">Elementos:</span>
            <div className="flex items-center gap-1"><div className="w-4 h-2 rounded" style={{ background: 'hsl(var(--gantt-bar))', border: '1px solid hsl(var(--gantt-bar))' }} /> <span>Planejado — cor da equipe ou status</span></div>
          </div>
          <div className="flex items-center gap-3 ml-2 border-l border-border pl-3">
            <span className="font-medium">Dep:</span>
            <span style={{ color: '#378ADD' }}>TI</span>
            <span style={{ color: '#1D9E75' }}>II</span>
            <span style={{ color: '#BA7517' }}>TT</span>
            <span style={{ color: '#A32D2D' }}>IT</span>
          </div>
          <div className="flex items-center gap-2 ml-2 border-l border-border pl-3">
            <div className="w-3 h-3 rounded" style={{ background: 'hsl(var(--gantt-sunday))' }} /><span>Dom</span>
            <div className="w-3 h-3 rounded" style={{ background: 'hsl(var(--gantt-saturday))' }} /><span>Sáb</span>
            <div className="w-3 h-3 rounded" style={{ background: 'hsl(var(--gantt-holiday-national))' }} /><span>Feriado Nac.</span>
            <div className="w-3 h-3 rounded" style={{ background: 'hsl(var(--gantt-holiday-local))' }} /><span>Feriado Local</span>
          </div>
          <div className="flex items-center gap-3 text-[9px] text-muted-foreground flex-wrap">
            <span className="font-medium">Equipes:</span>
            {projectTeams.map(def => (
              <div key={def.code} className="flex items-center gap-1">
                <div className="w-3 h-1.5 rounded-full" style={{ background: def.bgColor, border: `1px solid ${def.borderColor}` }} />
                <span>{def.label}</span>
                <span className="text-muted-foreground/70">({def.composition})</span>
              </div>
            ))}
            <Popover>
              <PopoverTrigger asChild>
                <button className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border text-[9px] text-muted-foreground hover:text-primary hover:border-primary transition-colors">
                  <Settings2 className="w-3 h-3" /> Gerenciar
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[480px] p-3" align="end">
                <div className="text-[11px] font-semibold text-foreground mb-2">Gerenciar Equipes</div>
                {onProjectChange && (
                  <GerenciarEquipes project={project} onProjectChange={onProjectChange} />
                )}
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div className="bg-card rounded-lg border border-border shadow-sm overflow-hidden">
          <div className="flex">
            {/* Sidebar table */}
            <div style={{ width: sidebarWidth, minWidth: sidebarWidth }} className="border-r border-border flex-shrink-0">
              {/* Header */}
              <div
                className="border-b border-border bg-secondary/50 grid items-center px-1"
                style={{ height: headerHeightPx, gridTemplateColumns: sidebarCols }}
              >
                {showSuspensionColumn && <span className="text-[8px] font-semibold text-muted-foreground uppercase text-center" title="Serviço suspenso por aditivo">Susp.</span>}
                <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-center">#</span>
                <span className="text-[10px] font-semibold text-foreground uppercase tracking-wide pl-1">Descrição</span>
                <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-center">Início</span>
                <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-center">Fim</span>
                <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-center" title="Duração em dias">Dur.</span>
                <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-center">Progresso</span>
                <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-center">Detalhes</span>
              </div>

              {/* Rows */}
              {displayPhases.map(phase => {
                const phaseRange = getPhaseRange(phase);
                const diasUteis = getChapterDiasUteis(phase);
                const visiblePhaseTasks = getVisiblePhaseTasks(phase);

                return (
                  <div key={phase.id}>
                    {/* Phase header with dates */}
                    {(() => {
                      const isMainChapter = !phase.parentId;
                      const depth = Math.min(phaseDepth.get(phase.id) ?? 0, 3);
                      const headerBgClass = isMainChapter ? 'bg-muted/50' : 'bg-muted/30';
                      return (
                    <div
                      className={`border-b border-border ${headerBgClass} transition-colors duration-200 ease-out hover:bg-muted/70 overflow-hidden`}
                      style={{ height: phaseHeaderHeight }}
                    >
                      <button
                        onClick={() => togglePhase(phase.id)}
                        className="w-full flex items-center gap-1.5 px-2 transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 rounded-sm"
                        style={{ height: taskRowHeight, paddingLeft: 8 + depth * 18 }}
                      >
                        {collapsedPhases.has(phase.id)
                          ? <ChevronRight className="w-3 h-3 opacity-60 transition-transform duration-200 ease-out" />
                          : <ChevronDown className="w-3 h-3 opacity-60 transition-transform duration-200 ease-out" />}
                        <span
                          className="font-mono tabular-nums flex-shrink-0 text-muted-foreground"
                          style={{ fontSize: isMainChapter ? 13 : 12, fontWeight: isMainChapter ? 800 : 700 }}
                        >
                          {chapterNumbering.get(phase.id)}
                        </span>
                        <span
                          className="truncate text-foreground"
                          style={{
                            fontSize: isMainChapter ? 15 : 13,
                            fontWeight: isMainChapter ? 800 : 700,
                            letterSpacing: isMainChapter ? '0.01em' : 0,
                          }}
                        >
                          {phase.name}
                        </span>
                        <span className="text-[9px] ml-auto text-muted-foreground">{visiblePhaseTasks.length}</span>
                      </button>
                      {/* Chapter dates row */}
                      <div className="flex items-center gap-2 px-2 text-[9px] overflow-hidden" style={{ height: phaseHeaderHeight - taskRowHeight }}>
                        <Popover>
                          <PopoverTrigger asChild>
                            <button className="text-muted-foreground hover:text-primary transition-colors">
                              Início: <span className="font-semibold text-foreground">{phaseRange.start ? formatDateFull(phaseRange.start) : '—'}</span>
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            {(() => {
                              const sel = phaseRange.start ? parseISODateLocal(phaseRange.start) : undefined;
                              return (
                                <GanttDatePickerCalendar
                                  title="Alterar início do capítulo"
                                  valueDate={sel}
                                  onSelect={(d) => handleChapterDateChange(phase.id, 'start', d)}
                                />
                              );
                            })()}
                          </PopoverContent>
                        </Popover>
                        <Popover>
                          <PopoverTrigger asChild>
                            <button className="text-muted-foreground hover:text-primary transition-colors">
                              Fim: <span className="font-semibold text-foreground">{phaseRange.end ? formatDateFull(phaseRange.end) : '—'}</span>
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            {(() => {
                              const sel = phaseRange.end ? parseISODateLocal(phaseRange.end) : undefined;
                              return (
                                <GanttDatePickerCalendar
                                  title="Alterar fim do capítulo"
                                  valueDate={sel}
                                  onSelect={(d) => handleChapterDateChange(phase.id, 'end', d)}
                                />
                              );
                            })()}
                          </PopoverContent>
                        </Popover>
                        <span className="ml-auto flex items-center gap-2 text-muted-foreground">
                          {(() => {
                            const items = visiblePhaseTasks.filter(task => !isStatusOnlyTask(task.id));
                            if (items.length === 0) return null;
                            const totalDur = items.reduce((s, t) => s + Math.max(1, t.duration), 0) || 1;
                            const weighted = items.reduce((s, t) => s + (t.physicalProgress ?? t.percentComplete ?? 0) * Math.max(1, t.duration), 0);
                            const pct = Math.round(weighted / totalDur);
                            return (
                              <span className="font-bold text-foreground" title="Percentual concluído do capítulo (média ponderada por duração)">
                                {pct}%
                              </span>
                            );
                          })()}
                          <span><span className="font-semibold text-foreground">{diasUteis.dias}d</span> / <span className="font-semibold text-foreground">{diasUteis.horas}h</span> úteis</span>
                        </span>
                      </div>
                    </div>
                      );
                    })()}
                    {!collapsedPhases.has(phase.id) && visiblePhaseTasks.length > 0 && (
                      <div
                        className="border-b border-border bg-secondary/30 grid items-center px-1"
                        style={{ height: taskSubHeaderHeight, gridTemplateColumns: sidebarCols }}
                      >
                        {showSuspensionColumn && <span className="text-[8px] font-semibold text-muted-foreground/80 uppercase text-center">Susp.</span>}
                        <span className="text-[8px] font-semibold text-muted-foreground/80 uppercase tracking-wider text-center">#</span>
                        <span className="text-[9px] font-semibold text-foreground/80 uppercase tracking-wider pl-1">Descrição</span>
                        <span className="text-[8px] font-semibold text-muted-foreground/80 uppercase tracking-wider text-center">Início</span>
                        <span className="text-[8px] font-semibold text-muted-foreground/80 uppercase tracking-wider text-center">Fim</span>
                        <span className="text-[8px] font-semibold text-muted-foreground/80 uppercase tracking-wider text-center" title="Duração em dias">Dur.</span>
                        <span className="text-[8px] font-semibold text-muted-foreground/80 uppercase tracking-wider text-center">Progresso</span>
                        <span className="text-[8px] font-semibold text-muted-foreground/80 uppercase tracking-wider text-center">Detalhes</span>
                      </div>
                    )}
                    {!collapsedPhases.has(phase.id) &&
                      visiblePhaseTasks
                        .map((task, idx) => {
                          const suspension = suspensionMap[task.id];
                          const statusOnly = isStatusOnlyTask(task.id);
                          const endDate = getWorkEndDate(task.startDate, task.duration, obraConfig.trabalhaSabado);
                          const taskNum = taskNumbering.get(task.id) || 0;
                          const violations = statusOnly ? [] : getViolations(task);
                          const hasViolation = violations.length > 0;
                          const depDisplay = getDepDisplay(task);
                          const depTypes = getDepTypes(task);
                          const noWorkDays = !statusOnly && hasNoWorkingDays(task);
                          const laborConflict = statusOnly ? undefined : laborPlanning.taskConflictMap[task.id];
                          const hasLaborConflict = !!laborConflict && (
                            laborConflict.roleDeficits.length > 0 ||
                            laborConflict.teamConflicts.length > 0 ||
                            laborConflict.missingAvailability.length > 0
                          );
                          const isLaborHighlighted = highlightedLaborTaskIds.has(task.id);
                          const rowTeamDef = statusOnly ? undefined : teamDef(task.team);
                          const scheduleLocked = isTaskScheduleLocked(task.id);
                          const scheduleLockSource = scheduleLockLabel(task.id);
                          const rowHeight = getTaskRowHeight(task);
                          const isReorderDragging = reorderDragTaskId === task.id;
                          const isReorderTarget = reorderDropTargetId === task.id && reorderDragTaskId && reorderDragTaskId !== task.id;
                          return (
                            <div
                              key={task.id}
                              data-testid={`gantt-sidebar-row-${task.id}`}
                              draggable={!readOnly && !statusOnly && !scheduleLocked}
                              onDragStart={(e) => handleRowDragStart(e, phase.id, task.id)}
                              onDragOver={(e) => handleRowDragOver(e, task.id)}
                              onDrop={(e) => handleRowDrop(e, phase.id, task.id)}
                              onDragEnd={handleRowDragEnd}
                              title={statusOnly ? suspension?.label : scheduleLocked ? `Planejada pelo aditivo: ${scheduleLockSource}` : 'Arraste para reordenar a tarefa'}
                              className={`grid items-center gap-0.5 px-1 border-b border-border hover:brightness-110 transition-colors ${readOnly || statusOnly || scheduleLocked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'} ${
                                !rowTeamDef ? (idx % 2 === 0 ? 'bg-card' : 'bg-muted/10') : ''
                              } ${task.isCritical && !rowTeamDef ? 'bg-destructive/5' : ''} ${noWorkDays && !rowTeamDef ? 'bg-warning/10' : ''} ${
                                isLaborHighlighted ? 'ring-2 ring-inset ring-blue-500 bg-blue-50/80' : ''
                              } ${
                                isReorderDragging ? 'opacity-40' : ''
                              } ${
                                isReorderTarget && reorderDropPos === 'before' ? 'border-t-2 border-t-primary' : ''
                              } ${
                                isReorderTarget && reorderDropPos === 'after' ? 'border-b-2 border-b-primary' : ''
                              } ${suspension ? 'bg-amber-50/80 ring-1 ring-inset ring-amber-300' : ''
                              }`}
                              style={{
                                height: rowHeight,
                                gridTemplateColumns: sidebarCols,
                                ...(rowTeamDef ? {
                                  backgroundColor: rowTeamDef.bgColor,
                                  color: rowTeamDef.textColor,
                                } : {}),
                              }}
                            >
                              {showSuspensionColumn && (
                                <div className="flex items-center justify-center gap-1">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <input
                                        type="checkbox"
                                        aria-label={`Suspender ${task.name}`}
                                        checked={!!suspension?.checked}
                                        disabled={readOnly || suspension?.disabled}
                                        onChange={event => onToggleSuspension?.(task.id, event.target.checked)}
                                        className="h-3.5 w-3.5 accent-amber-600"
                                      />
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-sm text-xs">
                                      {suspension?.disabled
                                        ? `${suspension.label}. Marcação automática e obrigatória.`
                                        : suspension?.label || 'Marcar como serviço contratado dependente do aditivo.'}
                                      {!!suspension?.blockingCompositions?.length && (
                                        <div className="mt-2 space-y-1 border-t border-border pt-2">
                                          {suspension.blockingCompositions.map(item => (
                                            <div key={item.compositionId}>{[item.item, item.code].filter(Boolean).join(' - ')} {item.description}</div>
                                          ))}
                                        </div>
                                      )}
                                    </TooltipContent>
                                  </Tooltip>
                                  {suspension?.kind === 'manual' && !readOnly && onEditSuspension && (
                                    <button
                                      type="button"
                                      onClick={() => onEditSuspension(task.id)}
                                      className="rounded p-0.5 text-amber-700 hover:bg-amber-100"
                                      aria-label={`Editar bloqueadores de ${task.name}`}
                                      title="Editar composições bloqueadoras"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                  )}
                                </div>
                              )}
                              <div className="text-center">
                                <span className={`text-[9px] font-mono ${rowTeamDef ? 'opacity-70' : 'text-muted-foreground'}`}>{taskNum}</span>
                              </div>
                              <div className="min-w-0 flex items-center gap-1 pl-1">
                                {task.isCritical && <div className="w-1.5 h-1.5 rounded-full bg-destructive flex-shrink-0" />}
                                {hasViolation && <AlertTriangle className="w-3 h-3 flex-shrink-0" style={{ color: 'hsl(0, 75%, 38%)', filter: 'drop-shadow(0 0 1px white)' }} />}
                                {noWorkDays && <AlertTriangle className="w-3 h-3 flex-shrink-0" style={{ color: '#b45309', filter: 'drop-shadow(0 0 1px white)' }} />}
                                {hasLaborConflict && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <AlertTriangle className="w-3 h-3 flex-shrink-0" style={{ color: '#c2410c', filter: 'drop-shadow(0 0 1px white)' }} />
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-md whitespace-normal text-xs">
                                      <div className="space-y-1">
                                        {laborConflict.roleDeficits.map(item => <div key={item}>{item}</div>)}
                                        {laborConflict.teamConflicts.map(item => <div key={item}>Equipe sobreposta: {item}</div>)}
                                        {laborConflict.missingAvailability.map(item => <div key={item}>{item}</div>)}
                                      </div>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                                <div className="relative min-w-0 flex-1">
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <p
                                        data-testid={`gantt-task-description-${task.id}`}
                                        className={`line-clamp-2 break-words pr-4 text-[11px] font-medium leading-tight ${rowTeamDef ? '' : 'text-foreground'}`}
                                      >
                                        {task.name}
                                      </p>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-md whitespace-normal break-words text-xs">
                                      {task.name}
                                    </TooltipContent>
                                  </Tooltip>
                                  {scheduleLocked && (
                                    <p className="truncate text-[8px] font-semibold leading-tight text-sky-700" title={`Edite no Cronograma do Aditivo: ${scheduleLockSource}`}>
                                      Planejada pelo aditivo: {scheduleLockSource}
                                    </p>
                                  )}
                                  {task.operationalReschedule && (
                                    <p className="truncate text-[8px] font-semibold leading-tight text-violet-700" title={task.operationalReschedule.reason}>
                                      Reprogramada: {task.operationalReschedule.startDate} → {task.operationalReschedule.endDate}
                                    </p>
                                  )}
                                  {(canRequestReschedule || canApproveReschedule) && !scheduleLocked && (
                                    <button
                                      type="button"
                                      className="absolute right-0 top-0 rounded p-0.5 text-violet-700 hover:bg-violet-100"
                                      onClick={() => setRescheduleTaskId(task.id)}
                                      aria-label={`Reprogramar ${task.name}`}
                                      title="Reprogramar atividade"
                                    >
                                      <CalendarClock className="h-3 w-3" />
                                    </button>
                                  )}
                                  {context === 'additive-preview' && suspension?.kind === 'quantity_limited' && (
                                    <p
                                      data-testid={`gantt-quantity-limited-${task.id}`}
                                      className="truncate text-[8px] font-bold leading-tight text-sky-800"
                                      title={suspension.label}
                                    >
                                      {suspension.label}
                                    </p>
                                  )}
                                  {context === 'additive-preview' && suspension?.kind === 'manual' && !!suspension.blockingCompositions?.length && (
                                    <p className="truncate text-[8px] font-semibold leading-tight text-amber-800">
                                      Bloqueado por {suspension.blockingCompositions.length} composição(ões) do aditivo
                                    </p>
                                  )}
                                </div>
                                <AdditiveBadge
                                  originAdditiveId={task.originAdditiveId}
                                  originAdditiveName={task.originAdditiveName}
                                  originAdditiveVersion={task.originAdditiveVersion}
                                  additiveHistory={task.additiveHistory}
                                  suppressedByAdditive={task.suppressedByAdditive}
                                  compact
                                  className="ml-1 flex-shrink-0"
                                />
                                {suspension && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <AlertTriangle className="h-3 w-3 flex-shrink-0 text-amber-700" aria-label={suspension.label} />
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-md whitespace-normal text-xs">
                                      <div className="font-semibold">{suspension.label}</div>
                                      <div>{suspension.reason}</div>
                                      {!!suspension.blockingCompositions?.length && (
                                        <div className="mt-2 border-t border-border pt-2">
                                          <div className="font-semibold">Composições bloqueadoras:</div>
                                          {suspension.blockingCompositions.map(item => (
                                            <div key={item.compositionId}>{[item.item, item.code].filter(Boolean).join(' - ')} {item.description}</div>
                                          ))}
                                          {suspension.blockingNote && <div className="mt-1 italic">{suspension.blockingNote}</div>}
                                        </div>
                                      )}
                                      <div className="mt-1 text-muted-foreground">{suspension.additiveName}</div>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                              
                              <div className="flex flex-col gap-0.5">
                                {statusOnly ? <span className="text-center text-[10px] text-muted-foreground">—</span> : (() => {
                                  const hasLogs = (task.dailyLogs?.length ?? 0) > 0;
                                  const hasRealData = (task.dailyLogs || []).some(l => (l.actualQuantity ?? 0) > 0) && !!task.current?.startDate;
                                  const startNonUtil = !isDiaUtil(parseISODateLocal(task.startDate), obraConfig.uf, obraConfig.municipio, obraConfig.trabalhaSabado);
                                  const labelEl = (
                                    <span className={`text-[9px] ${rowTeamDef ? '' : 'text-foreground'} font-medium inline-flex items-center justify-center gap-0.5`}>
                                      {startNonUtil && <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0" style={{ color: '#b45309', filter: 'drop-shadow(0 0 1px white)' }} aria-label="Início em dia não útil" />}
                                      {formatDateFull(task.startDate)}
                                    </span>
                                  );
                                  const realLine = hasRealData ? (
                                    <span
                                      className="text-[9px] font-medium leading-none"
                                      style={{ color: '#1e40af', filter: 'drop-shadow(0 0 1px white)' }}
                                    >
                                      Real: {formatDateFull(task.current!.startDate)}
                                    </span>
                                  ) : null;
                                  if (hasLogs) {
                                    return (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <button disabled className="text-center w-full leading-tight cursor-not-allowed opacity-90 flex flex-col items-center gap-0.5">
                                            {labelEl}
                                            {realLine}
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          <p className="text-xs">Datas reais vêm do apontamento diário</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    );
                                  }
                                  return (
                                    <Popover>
                                      <PopoverTrigger asChild>
                                        <button disabled={readOnly || scheduleLocked} className={`text-center w-full leading-tight transition-colors ${readOnly || scheduleLocked ? 'cursor-default' : rowTeamDef ? 'hover:opacity-70' : 'hover:text-primary'}`} title={scheduleLocked ? `Edite no Cronograma do Aditivo: ${scheduleLockSource}` : undefined}>
                                          {labelEl}
                                        </button>
                                      </PopoverTrigger>
                                      <PopoverContent className="w-auto p-0" align="start">
                                        {(() => {
                                          const sel = parseISODateLocal(task.startDate);
                                          return (
                                            <GanttDatePickerCalendar
                                              title="Alterar início"
                                              valueDate={sel}
                                              onSelect={(d) => handleDateChange(task.id, 'start', d)}
                                            />
                                          );
                                        })()}
                                      </PopoverContent>
                                    </Popover>
                                  );
                                })()}
                              </div>
                              <div className="flex flex-col gap-0.5">
                                {statusOnly ? <span className="text-center text-[10px] text-muted-foreground">—</span> : (() => {
                                  const hasLogs = (task.dailyLogs?.length ?? 0) > 0;
                                  const hasRealData = (task.dailyLogs || []).some(l => (l.actualQuantity ?? 0) > 0) && !!task.current?.startDate;
                                  const endNonUtil = !isDiaUtil(parseISODateLocal(endDate), obraConfig.uf, obraConfig.municipio, obraConfig.trabalhaSabado);
                                  const labelEl = (
                                    <span className={`text-[9px] ${rowTeamDef ? '' : 'text-foreground'} font-medium inline-flex items-center justify-center gap-0.5`}>
                                      {endNonUtil && <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0" style={{ color: '#b45309', filter: 'drop-shadow(0 0 1px white)' }} aria-label="Fim em dia não útil" />}
                                      {formatDateFull(endDate)}
                                    </span>
                                  );
                                  const previsto = task.current?.forecastEndDate || task.current?.endDate;
                                  const isLate = !!previsto && previsto > endDate;
                                  const prevLine = hasRealData && previsto ? (
                                    <span
                                      className="text-[9px] font-medium leading-none"
                                      style={{
                                        color: isLate ? '#991b1b' : '#166534',
                                        filter: 'drop-shadow(0 0 1px white)',
                                      }}
                                    >
                                      Prev: {formatDateFull(previsto)}
                                    </span>
                                  ) : null;
                                  if (hasLogs) {
                                    return (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <button disabled className="text-center w-full leading-tight cursor-not-allowed opacity-90 flex flex-col items-center gap-0.5">
                                            {labelEl}
                                            {prevLine}
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          <p className="text-xs">Datas reais vêm do apontamento diário</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    );
                                  }
                                  return (
                                    <Popover>
                                      <PopoverTrigger asChild>
                                        <button disabled={readOnly || scheduleLocked} className={`text-center w-full leading-tight transition-colors ${readOnly || scheduleLocked ? 'cursor-default' : rowTeamDef ? 'hover:opacity-70' : 'hover:text-primary'}`} title={scheduleLocked ? `Edite no Cronograma do Aditivo: ${scheduleLockSource}` : undefined}>
                                          {labelEl}
                                        </button>
                                      </PopoverTrigger>
                                      <PopoverContent className="w-auto p-0" align="start">
                                        {(() => {
                                          const sel = parseISODateLocal(endDate);
                                          return (
                                            <GanttDatePickerCalendar
                                              title="Alterar fim"
                                              valueDate={sel}
                                              onSelect={(d) => handleDateChange(task.id, 'end', d)}
                                            />
                                          );
                                        })()}
                                      </PopoverContent>
                                    </Popover>
                                  );
                                })()}
                              </div>
                              {/* Duração (editável — força modo Manual) */}
                              <div className="text-center">
                                {statusOnly ? <span className="text-[10px] text-muted-foreground">—</span> : <input
                                  type="number"
                                  min={1}
                                  step={1}
                                  className={`w-full text-[10px] font-medium bg-transparent border-b border-border/50 text-center focus:outline-none focus:border-primary appearance-none ${rowTeamDef ? '' : 'text-foreground'}`}
                                  style={rowTeamDef ? { color: rowTeamDef.textColor } : undefined}
                                  defaultValue={task.duration}
                                  disabled={readOnly || scheduleLocked}
                                  key={`dur-${task.id}-${task.duration}`}
                                  onBlur={(e) => handleDurationChange(task.id, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                    if (e.key === 'Escape') {
                                      (e.target as HTMLInputElement).value = String(task.duration);
                                      (e.target as HTMLInputElement).blur();
                                    }
                                  }}
                                  title={(task.durationMode || 'manual') === 'rup'
                                    ? 'Editar a duração mudará para modo Manual'
                                    : 'Duração em dias (modo Manual)'}
                                />}
                              </div>
                              {/* % Concluído */}
                              <div className="text-center">
                                {(() => {
                                  const pct = Math.round(task.physicalProgress ?? task.percentComplete ?? 0);
                                  // Esperado pelo tempo decorrido
                                  const start = parseISODateLocal(task.startDate);
                                  const totalDays = Math.max(1, task.duration);
                                  const elapsed = Math.max(0, Math.min(totalDays, diffDays(start, today) + 1));
                                  const expected = Math.round((elapsed / totalDays) * 100);
                                  const hasData = (task.percentComplete ?? 0) > 0 || (task.physicalProgress ?? 0) > 0 || (task.dailyLogs?.length ?? 0) > 0;
                                  const color = !hasData
                                    ? '#6b7280'
                                    : pct >= expected ? '#166534' : '#991b1b';
                                  const delay = calcForecastDelay(task);
                                  return (
                                    <div className="flex flex-col items-center gap-0 leading-none">
                                      <span
                                        className="text-[10px] font-bold"
                                        style={{ color, filter: 'drop-shadow(0 0 1px white)' }}
                                        title={`Concluído: ${pct}% • Esperado: ${expected}%`}
                                      >
                                        {pct}%
                                      </span>
                                      {delay !== null && delay !== 0 && (
                                        <span
                                          className={`text-[8px] font-bold px-1 rounded leading-none mt-0.5 ${
                                            delay > 0
                                              ? 'bg-destructive/15 text-destructive'
                                              : 'bg-success/15 text-success'
                                          }`}
                                          title={delay > 0
                                            ? `Previsão: +${delay} dias de atraso com ritmo atual`
                                            : `Previsão: ${Math.abs(delay)} dias adiantado`
                                          }
                                        >
                                          {delay > 0 ? `+${delay}d` : `${delay}d`}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                              <div className="flex justify-center">
                                {statusOnly ? <span className="text-[9px] text-muted-foreground">—</span> : <Popover>
                                  <PopoverTrigger asChild>
                                    <button type="button" aria-label={`Detalhes da tarefa #${taskNum}`} className="inline-flex h-6 items-center gap-1 rounded border border-border bg-background px-1.5 text-[9px] font-medium text-muted-foreground hover:border-primary hover:text-primary" title="Produção, dependências, equipe e modo de duração">
                                      <SlidersHorizontal className="h-3 w-3" /> Ver
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent className="w-72 space-y-3 p-3" align="end">
                                    <div className="text-xs font-semibold">Detalhes operacionais</div>
                                    <div className="grid grid-cols-2 gap-2 rounded bg-muted/50 p-2 text-[10px]">
                                      <span>Planejado/dia</span><strong className="text-right">{task.quantity && task.duration ? `${(task.quantity / task.duration).toFixed(1)} ${task.unit || 'un'}` : '—'}</strong>
                                      <span>Dependências</span><strong className="text-right">{depDisplay || '—'}</strong>
                                    </div>
                                    <div className="space-y-1"><span className="text-[10px] font-medium text-muted-foreground">Predecessoras</span><input title="Nº da tarefa predecessora (ex: 3, 7)" className="h-8 w-full rounded border border-input bg-background px-2 text-xs" defaultValue={depDisplay} key={depDisplay} placeholder="Ex.: 3, 7" disabled={readOnly || scheduleLocked} onBlur={(e) => handleDepChange(task.id, e.target.value)} onKeyDown={(e) => handleDependencyKeyDown(task.id, e)} /></div>
                                    {depTypes.length > 0 && <div className="space-y-1"><span className="text-[10px] font-medium text-muted-foreground">Tipo de dependência</span><select data-testid={`gantt-dependency-types-${task.id}`} aria-label={`Tipo de dependência da tarefa #${taskNum}`} value={depTypes.length === 1 ? `${depTypes[0].index}:${depTypes[0].type}` : '__multiple__'} onChange={(event) => { const [depIndex, dependencyType] = event.target.value.split(':'); if (dependencyType) handleDepTypeChange(task.id, Number(depIndex), dependencyType as DependencyType); }} disabled={readOnly || scheduleLocked || !onProjectChange} className="h-8 w-full rounded border border-input bg-background px-2 text-xs">{depTypes.length > 1 && <option value="__multiple__" disabled>{depTypes.map(dep => dep.type).join('/')}</option>}{depTypes.map(dep => <optgroup key={dep.taskId} label={`Tarefa #${dep.num}`}>{(['TI', 'II', 'TT', 'IT'] as DependencyType[]).map(type => <option key={type} value={`${dep.index}:${type}`}>{type}</option>)}</optgroup>)}</select></div>}
                                    <div className="grid grid-cols-2 gap-2">
                                      <button disabled={readOnly || scheduleLocked} onClick={() => toggleDurationMode(task.id)} className="h-8 rounded border border-input text-xs hover:border-primary disabled:opacity-50">Modo: {(task.durationMode || 'manual') === 'rup' ? 'RUP' : 'Manual'}</button>
                                      <Select value={task.team || '_none'} disabled={readOnly || scheduleLocked || !onProjectChange} onValueChange={(val) => { const newTeam = val === '_none' ? undefined : val as TeamCode; onProjectChange?.({ ...project, phases: project.phases.map(p => ({ ...p, tasks: p.tasks.map(t => t.id === task.id ? { ...t, team: newTeam } : t) })) }); }}><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Equipe" /></SelectTrigger><SelectContent><SelectItem value="_none">Sem equipe</SelectItem>{projectTeams.map(def => <SelectItem key={def.code} value={def.code}>{def.label}</SelectItem>)}</SelectContent></Select>
                                    </div>
                                  </PopoverContent>
                                </Popover>}
                              </div>
                            </div>
                          );
                        })}
                  </div>
                );
              })}
            </div>

            {/* Gantt chart area */}
            <div className="flex-1 overflow-x-auto scrollbar-thin" ref={chartContainerRef}>
              <div style={{ width: chartWidth, minWidth: '100%' }}>
                {/* Header */}
                {viewMode === 'weeks' ? (
              <div className="border-b border-border bg-secondary/50 relative" style={{ height: headerHeightPx }}>
                    {monthGroups.map((g, i) => (
                      <div
                        key={i}
                        data-testid={financialByMonth.has(g.key) ? `gantt-month-financial-${g.key}` : undefined}
                        className="absolute top-0 flex flex-col items-center justify-center overflow-hidden text-[9px] text-foreground font-semibold border-r border-b border-border"
                        style={{ left: g.offset, width: g.width, height: showMonthlyFinancialHeader ? 44 : headerHeightPx / 2 }}
                      >
                        <span>{g.label}</span>
                        {financialByMonth.get(g.key) && (
                          <span className="mt-0.5 flex max-w-full flex-col items-center text-[8px] font-medium leading-tight tabular-nums">
                            <span className="max-w-full truncate text-emerald-700" title={`Contratados liberados: ${formatHeaderMoney(financialByMonth.get(g.key)!.contractedReleased)}`}>
                              {formatHeaderMoney(financialByMonth.get(g.key)!.contractedReleased)}
                            </span>
                            <span className={`${financialByMonth.get(g.key)!.proposed < 0 ? 'text-destructive' : 'text-rose-700'} max-w-full truncate`} title={`Proposta não contratada: ${formatHeaderMoney(financialByMonth.get(g.key)!.proposed)}`}>
                              {formatHeaderMoney(financialByMonth.get(g.key)!.proposed)}
                            </span>
                          </span>
                        )}
                      </div>
                    ))}
                    {headerDates.map((d, i) => (
                      <div
                        key={i}
                        className="absolute flex items-center justify-center text-[9px] text-muted-foreground font-medium border-r border-border"
                        style={{ left: d.offset, width: d.width, top: showMonthlyFinancialHeader ? 44 : headerHeightPx / 2, height: showMonthlyFinancialHeader ? 24 : headerHeightPx / 2 }}
                      >
                        {d.label}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="border-b border-border bg-secondary/50 relative" style={{ height: headerHeightPx }}>
                    {headerDates.map((d, i) => (
                      <div
                        key={i}
                        data-testid={d.key && financialByMonth.has(d.key) ? `gantt-month-financial-${d.key}` : undefined}
                        className="absolute h-full flex flex-col items-center justify-center overflow-hidden text-[9px] text-muted-foreground font-medium border-r border-border"
                        style={{ left: d.offset, width: d.width }}
                      >
                        <span>{d.label}</span>
                        {d.key && financialByMonth.get(d.key) && (
                          <span className="mt-1 flex max-w-full flex-col items-center text-[8px] leading-tight tabular-nums">
                            <span className="max-w-full truncate text-emerald-700" title={`Contratados liberados: ${formatHeaderMoney(financialByMonth.get(d.key)!.contractedReleased)}`}>
                              {formatHeaderMoney(financialByMonth.get(d.key)!.contractedReleased)}
                            </span>
                            <span className={`${financialByMonth.get(d.key)!.proposed < 0 ? 'text-destructive' : 'text-rose-700'} max-w-full truncate`} title={`Proposta não contratada: ${formatHeaderMoney(financialByMonth.get(d.key)!.proposed)}`}>
                              {formatHeaderMoney(financialByMonth.get(d.key)!.proposed)}
                            </span>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Bars area */}
                <div className="relative">
                  {/* Day column backgrounds for holidays/weekends (only in day view for performance) */}
                  {viewMode === 'days' && dayInfos.map((info, i) => {
                    const bg = getDayBg(i);
                    if (!bg) return null;
                    return (
                      <Tooltip key={`bg-${i}`}>
                        <TooltipTrigger asChild>
                          <div
                            className="absolute top-0 bottom-0"
                            style={{ left: i * dayWidth, width: dayWidth, background: bg, zIndex: 1 }}
                          />
                        </TooltipTrigger>
                        {info.feriado && (
                          <TooltipContent>
                            <p className="text-xs font-medium">{info.feriado.nome}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {info.feriado.tipo === 'nacional' ? 'Feriado Nacional' : info.feriado.tipo === 'estadual' ? 'Feriado Estadual' : 'Feriado Municipal'}
                            </p>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    );
                  })}

                  {/* Holiday indicators in header (days view) */}
                  {viewMode === 'days' && dayInfos.map((info, i) => {
                    if (!info.feriado) return null;
                    return (
                      <div
                        key={`flag-${i}`}
                        className="absolute flex items-center justify-center z-10"
                        style={{ left: i * dayWidth, width: dayWidth, top: -headerHeightPx + 4, height: 16 }}
                      >
                        <Flag className="w-2.5 h-2.5" style={{ color: info.feriado.tipo === 'nacional' ? 'hsl(var(--accent))' : 'hsl(280, 50%, 60%)' }} />
                      </div>
                    );
                  })}

                  {/* Today line */}
                  {todayOffset >= 0 && todayOffset <= totalDays && (
                    <div className="absolute top-0 bottom-0 w-px bg-gantt-today z-20" style={{ left: todayOffset * dayWidth }}>
                      <div className="absolute -top-0 -left-1 w-2.5 h-2.5 rounded-full bg-gantt-today" />
                    </div>
                  )}

                  {/* Visual-only start-of-work marker sourced from Measurement. */}
                  {workStartOffset >= 0 && workStartOffset <= totalDays && (
                    <div
                      data-testid="gantt-work-start-marker"
                      className="absolute top-0 bottom-0 z-30 w-0 pointer-events-auto"
                      style={{ left: workStartOffset * dayWidth }}
                      title={`In\u00edcio da obra: ${formatDateFull(workStartDate)}`}
                      aria-label={`In\u00edcio da obra: ${formatDateFull(workStartDate)}`}
                    >
                      <div className="absolute top-0 bottom-0 -left-px w-0.5 bg-emerald-600" />
                      <div className="absolute top-1 left-1 flex items-center gap-1 whitespace-nowrap rounded bg-emerald-700 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow-sm">
                        <Flag className="h-2.5 w-2.5" aria-hidden="true" />
                        <span>{formatDateFull(workStartDate)}</span>
                      </div>
                    </div>
                  )}

                  {/* Vertical grid lines */}
                  {headerDates.map((d, i) => (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0 border-r border-dashed"
                      style={{ left: d.offset + d.width, borderColor: 'hsl(var(--gantt-grid))' }}
                    />
                  ))}

                  {/* Dependency arrows */}
                  {(() => {
                    // During drag, provide tasks with temporary positions for arrows
                    let arrowTasks = tasks.filter(task => visibleTaskIds.has(task.id) && !isStatusOnlyTask(task.id));
                    if (draggingTaskId && (dragOffset !== 0 || dragTempTasks.size > 0)) {
                      const daysMoved = Math.round(dragOffset / dayWidth);
                      arrowTasks = arrowTasks.map(t => {
                        if (t.id === draggingTaskId) {
                          const newStart = addDays(parseISODateLocal(t.startDate), daysMoved);
                          return { ...t, startDate: dateToISO(newStart) };
                        }
                        const temp = dragTempTasks.get(t.id);
                        if (temp) return { ...t, startDate: temp.startDate };
                        return t;
                      });
                    }
                    return (
                      <DependencyArrows
                        tasks={arrowTasks}
                        taskYPositions={taskYPositions}
                        projectStart={projectStart}
                        dayWidth={dayWidth}
                        violations={violationMap}
                      />
                    );
                  })()}

                  {displayPhases.map(phase => {
                    const isMainChapter = !phase.parentId;
                    const ganttRowBgClass = isMainChapter ? 'bg-muted/40' : 'bg-muted/20';
                    const visiblePhaseTasks = getVisiblePhaseTasks(phase);
                    return (
                    <div key={phase.id}>
                      {/* Phase header row with milestone markers */}
                      <div
                        className={`border-b border-border ${ganttRowBgClass} relative`}
                        style={{ height: phaseHeaderHeight }}
                      >
                        {(() => {
                          const chapterBar = getChapterBarInfo(phase);
                          if (!chapterBar) return null;
                          const diamondSize = 10;
                          const midY = phaseHeaderHeight / 2;
                          return (
                            <>
                              {/* Chapter span line */}
                              <div
                                className="absolute bg-foreground/60"
                                style={{
                                  left: chapterBar.left,
                                  width: chapterBar.width,
                                  top: midY - 1,
                                  height: 2,
                                  zIndex: 5,
                                }}
                              />
                              {/* Start milestone diamond */}
                              <div
                                className="absolute z-10 bg-foreground/80"
                                style={{
                                  left: chapterBar.left - diamondSize / 2,
                                  top: midY - diamondSize / 2,
                                  width: diamondSize,
                                  height: diamondSize,
                                  transform: 'rotate(45deg)',
                                  borderRadius: 2,
                                }}
                                title={`Início: ${getPhaseRange(phase).start ? formatDateFull(getPhaseRange(phase).start) : '—'}`}
                              />
                              {/* End milestone diamond */}
                              <div
                                className="absolute z-10 bg-foreground/80"
                                style={{
                                  left: chapterBar.right - diamondSize / 2,
                                  top: midY - diamondSize / 2,
                                  width: diamondSize,
                                  height: diamondSize,
                                  transform: 'rotate(45deg)',
                                  borderRadius: 2,
                                }}
                                title={`Fim: ${getPhaseRange(phase).end ? formatDateFull(getPhaseRange(phase).end) : '—'}`}
                              />
                              {/* Chapter name label */}
                              <div
                                className="absolute z-10 whitespace-nowrap text-foreground"
                                style={{
                                  left: chapterBar.left + diamondSize + 4,
                                  top: midY - 14,
                                  fontSize: isMainChapter ? 10 : 9,
                                  fontWeight: isMainChapter ? 700 : 600,
                                }}
                              >
                                {phase.name}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                      {!collapsedPhases.has(phase.id) && visiblePhaseTasks.length > 0 && (
                        <div className="border-b border-border bg-secondary/30" style={{ height: taskSubHeaderHeight }} />
                      )}
                      {!collapsedPhases.has(phase.id) &&
                        visiblePhaseTasks
                          .map((task, idx) => {
                            const suspension = suspensionMap[task.id];
                            const statusOnly = isStatusOnlyTask(task.id);
                            const proposedLabelOnly = context === 'additive-preview' && suspension?.kind === 'proposed';
                            const bar = getBarStyle(task);
                            const isDragging = draggingTaskId === task.id;
                            const isResizing = resizingTaskId === task.id;
                            const violations = statusOnly ? [] : getViolations(task);
                            const hasViolation = violations.length > 0;
                            const noWorkDays = !statusOnly && hasNoWorkingDays(task);
                            const laborConflict = statusOnly ? undefined : laborPlanning.taskConflictMap[task.id];
                            const hasLaborConflict = !!laborConflict && (
                              laborConflict.roleDeficits.length > 0 ||
                              laborConflict.teamConflicts.length > 0 ||
                              laborConflict.missingAvailability.length > 0
                            );
                            const isLaborHighlighted = highlightedLaborTaskIds.has(task.id);
                            const scheduleLocked = isTaskScheduleLocked(task.id);
                            const scheduleLockSource = scheduleLockLabel(task.id);
                            const rowHeight = getTaskRowHeight(task);
                            // Compute current bar position with drag/resize/propagation
                            let currentLeft = bar.left;
                            let currentWidth = bar.width;
                            const isDragPropagated = dragTempTasks.has(task.id);
                            if (isDragging) {
                              currentLeft = bar.left + dragOffset;
                            } else if (isResizing) {
                              if (resizeSide === 'right') {
                                currentWidth = Math.max(dayWidth, bar.width + resizeDelta);
                              } else if (resizeSide === 'left') {
                                const delta = Math.min(resizeDelta, bar.width - dayWidth);
                                currentLeft = bar.left + delta;
                                currentWidth = bar.width - delta;
                              }
                            } else if (isDragPropagated) {
                              // Real-time propagation: move successor bar
                              const tempData = dragTempTasks.get(task.id)!;
                              const tempStart = diffDays(projectStart, parseISODateLocal(tempData.startDate));
                              currentLeft = tempStart * dayWidth;
                            }

                            const dragDate = getDragDate(task);

                            // Resize tooltip info
                            const getResizeInfo = () => {
                              if (!isResizing) return null;
                              const newDuration = Math.max(1, Math.round(currentWidth / dayWidth));
                              const newStart = addDays(projectStart, Math.round(currentLeft / dayWidth));
                              const newEnd = addDays(newStart, Math.max(0, newDuration - 1));
                              return {
                                start: formatDateFull(dateToISO(newStart)),
                                end: formatDateFull(dateToISO(newEnd)),
                                duration: newDuration,
                              };
                            };
                            const resizeInfo = getResizeInfo();

                            return (
                              <div
                                key={task.id}
                                data-testid={`gantt-chart-row-${task.id}`}
                                className={`border-b border-border relative ${idx % 2 === 0 ? 'bg-card' : 'bg-muted/10'}`}
                                style={{ height: rowHeight }}
                              >
                                {/* Barra planejada = task.startDate + task.duration (Manual ou RUP) */}
                                {statusOnly || proposedLabelOnly ? (
                                  <div
                                    data-testid={proposedLabelOnly
                                      ? `gantt-proposed-label-${task.id}`
                                      : `gantt-status-only-${task.id}`}
                                    className={`absolute top-1/2 z-20 -translate-y-1/2 whitespace-nowrap rounded px-2 py-1 text-[10px] font-extrabold tracking-wide ${
                                      proposedLabelOnly
                                        ? 'border-l-2 border-amber-500 bg-sky-50 text-sky-900'
                                        : suspension?.scheduleState === 'fully_suppressed'
                                          ? 'bg-rose-50 text-rose-800'
                                          : 'bg-amber-50 text-amber-900'
                                    }`}
                                    style={{ left: proposedLabelOnly ? currentLeft : 8 }}
                                    title={`${suspension?.label ?? ''} | ${suspension?.reason ?? ''}`}
                                  >
                                    {proposedLabelOnly
                                      ? 'Aguardando contratação'
                                      : suspension?.scheduleState === 'fully_suppressed'
                                        ? 'Item suprimido'
                                        : 'Aguardando aditivo'}
                                  </div>
                                ) : (() => {
                                  const barLeft = currentLeft;
                                  const barWidth = currentWidth;
                                  return (
                                <div
                                  data-testid={`gantt-bar-${task.id}`}
                                  ref={setBarRef(task.id)}
                                  className={`absolute rounded-md ${hasViolation ? 'animate-pulse ring-2 ring-destructive' : ''} ${noWorkDays ? 'ring-2 ring-warning' : ''} ${hasLaborConflict ? 'ring-2 ring-orange-400' : ''} ${isLaborHighlighted ? 'ring-4 ring-blue-500' : ''} ${suspension ? 'ring-2 ring-amber-500' : ''}`}
                                  title={suspension
                                    ? `${suspension.label} | ${suspension.reason}`
                                    : scheduleLocked
                                      ? `Planejada pelo aditivo: ${scheduleLockSource}. Edite no Cronograma do Aditivo.`
                                      : `${formatDateFull(task.startDate)} → ${formatDateFull(getWorkEndDate(task.startDate, task.duration, obraConfig.trabalhaSabado))} | ${task.duration}d - Arraste para mover`}
                                  style={{
                                    left: barLeft,
                                    width: barWidth,
                                    top: (rowHeight - (density === 'compact' ? 12 : 20)) / 2,
                                    height: density === 'compact' ? 12 : 20,
                                    borderRadius: 6,
                                    background: (() => {
                                      const td = teamDef(task.team);
                                      if (task.team && td) return td.barColor;
                                      if (bar.isDelayed) return 'hsl(var(--gantt-bar-delayed))';
                                      if (bar.isComplete) return 'hsl(var(--gantt-bar-complete))';
                                      if (bar.isCritical) return 'hsl(var(--gantt-critical))';
                                      return 'hsl(var(--gantt-bar))';
                                    })(),
                                    border: (() => {
                                      const td = teamDef(task.team);
                                      return td ? `1.5px solid ${td.borderColor}` : 'none';
                                    })(),
                                    opacity: isDragPropagated ? 0.85 : 0.95,
                                    transition: (isDragging || isResizing || isDragPropagated) ? 'none' : 'left 0.2s ease, width 0.2s ease',
                                    zIndex: 10,
                                    cursor: readOnly || scheduleLocked ? 'default' : 'grab',
                                  }}
                                  onMouseDown={(e) => {
                                    if (readOnly || scheduleLocked) return;
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    const relX = e.clientX - rect.left;
                                    const barW = rect.width;
                                    // Em barras pequenas (<=24px), zona de resize = 0 → tudo é drag
                                    const resizeZone = barW > 24 ? 8 : 0;
                                    if (resizeZone > 0 && relX <= resizeZone && barW > dayWidth) {
                                      handleResizeMouseDown(e, task.id, 'left');
                                    } else if (resizeZone > 0 && relX >= barW - resizeZone) {
                                      handleResizeMouseDown(e, task.id, 'right');
                                    } else {
                                      handleMouseDown(e, task.id, bar.left);
                                    }
                                  }}
                                  onMouseMove={(e) => {
                                    if (readOnly || scheduleLocked) return;
                                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    const relX = e.clientX - rect.left;
                                    const barW = rect.width;
                                    const resizeZone = barW > 24 ? 8 : 0;
                                    if (resizeZone > 0 && (relX <= resizeZone || relX >= barW - resizeZone)) {
                                      (e.currentTarget as HTMLElement).style.cursor = 'col-resize';
                                    } else {
                                      (e.currentTarget as HTMLElement).style.cursor = 'grab';
                                    }
                                  }}
                                >
                                  {/* Progress fill */}
                                  <div
                                    className="h-full rounded-md opacity-30"
                                    style={{ width: `${task.percentComplete}%`, background: 'white', borderRadius: 6 }}
                                  />
                                  {suspension && suspension.kind !== 'quantity_limited' && barWidth >= 160 && (
                                    <div className="absolute inset-0 flex items-center justify-center overflow-hidden px-2 text-[8px] font-bold text-white drop-shadow-sm pointer-events-none">
                                      <span className="truncate">{suspension.label}</span>
                                    </div>
                                  )}
                                  {/* Indicador de ritmo (faixa direita) — só com apontamentos */}
                                  {(() => {
                                    const logs = (task.dailyLogs || []).filter(l => (l.actualQuantity ?? 0) > 0);
                                    if (!logs.length || !task.quantity || !task.duration) return null;
                                    const planned = task.quantity / task.duration;
                                    const real = logs.reduce((s, l) => s + (l.actualQuantity || 0), 0) / logs.length;
                                    const onPace = real >= planned;
                                    return (
                                      <div
                                        className="absolute top-0 right-0 h-full pointer-events-none"
                                        style={{
                                          width: 4,
                                          background: onPace ? '#166534' : '#991b1b',
                                          opacity: 0.85,
                                          borderRadius: '0 6px 6px 0',
                                        }}
                                        title={onPace
                                          ? 'Ritmo no prazo'
                                          : `Ritmo: ${((real / planned) * 100).toFixed(0)}% do planejado`
                                        }
                                      />
                                    );
                                  })()}
                                </div>
                                  );
                                })()}

                                {/* Linha tracejada: intervalo Real → Previsto (apontamento diário) */}
                                {statusOnly ? null : (() => {
                                  const hasRealData = (task.dailyLogs || []).some(l => (l.actualQuantity ?? 0) > 0) && !!task.current?.startDate;
                                  if (!hasRealData) return null;
                                  const realStartISO = task.current!.startDate;
                                  const previstoISO = task.current!.forecastEndDate || task.current!.endDate;
                                  if (!previstoISO) return null;
                                  const realStart = parseISODateLocal(realStartISO);
                                  const previsto = parseISODateLocal(previstoISO);
                                  const leftDays = diffDays(projectStart, realStart);
                                  const spanDays = Math.max(1, diffDays(realStart, previsto) + 1);
                                  const left = leftDays * dayWidth;
                                  const width = spanDays * dayWidth;
                                  const plannedEndISO = dateToISO(addDays(parseISODateLocal(task.startDate), task.duration));
                                  const isLate = previstoISO > plannedEndISO;
                                  // Cor de alto contraste: azul-marinho forte (visível sobre fundos claros e escuros)
                                  // Tom muda para vermelho/verde escuros conforme atrasado/no prazo
                                  const color = isLate ? '#991b1b' : '#1e3a8a';
                                  // Centralizar verticalmente na barra (top:9, height:20 → centro = 19)
                                  // Usa traço branco com contorno escuro para contraste sobre qualquer cor de barra
                                  const BAR_TOP = 9;
                                  const BAR_HEIGHT = 20;
                                  const lineCenter = BAR_TOP + BAR_HEIGHT / 2; // 19
                                  const overlayHeight = 12;
                                  const overlayTop = lineCenter - overlayHeight / 2; // 13
                                  return (
                                    <div
                                      className="absolute pointer-events-none"
                                      style={{ left, width, top: overlayTop, height: overlayHeight, zIndex: 20 }}
                                      title={`Real: ${formatDateFull(realStartISO)} → Previsto: ${formatDateFull(previstoISO)}`}
                                    >
                                      {/* Halo escuro para contraste sobre barras claras */}
                                      <div
                                        style={{
                                          position: 'absolute',
                                          top: overlayHeight / 2 - 2,
                                          left: 0,
                                          right: 0,
                                          height: 4,
                                          borderRadius: 2,
                                          background: 'hsl(var(--background) / 0.55)',
                                          boxShadow: '0 0 0 1px hsl(var(--foreground) / 0.35)',
                                        }}
                                      />
                                      {/* Linha tracejada principal (cor status: vermelho/verde) */}
                                      <div
                                        style={{
                                          position: 'absolute',
                                          top: overlayHeight / 2 - 1,
                                          left: 2,
                                          right: 2,
                                          borderTop: `3px dashed ${color}`,
                                          filter: 'drop-shadow(0 1px 0 white) drop-shadow(0 -1px 0 white)',
                                        }}
                                      />
                                      {/* Marcador início (Real) */}
                                      <div
                                        style={{
                                          position: 'absolute',
                                          left: 0,
                                          top: 0,
                                          width: 3,
                                          height: overlayHeight,
                                          background: color,
                                          borderRadius: 1,
                                          boxShadow: '0 0 0 1px hsl(var(--background))',
                                        }}
                                      />
                                      {/* Marcador fim (Previsto) */}
                                      <div
                                        style={{
                                          position: 'absolute',
                                          right: 0,
                                          top: 0,
                                          width: 3,
                                          height: overlayHeight,
                                          background: color,
                                          borderRadius: 1,
                                          boxShadow: '0 0 0 1px hsl(var(--background))',
                                        }}
                                      />
                                      {/* Badge % concluído ancorado no fim do último apontamento (Real → Projeção) */}
                                      {(() => {
                                        const logs = (task.dailyLogs || []).filter(l => (l.actualQuantity ?? 0) > 0);
                                        if (logs.length === 0) return null;
                                        const lastLogISO = logs.reduce((max, l) => l.date > max ? l.date : max, logs[0].date);
                                        const lastLog = parseISODateLocal(lastLogISO);
                                        const offsetDays = Math.max(0, diffDays(realStart, lastLog));
                                        const offsetPx = Math.min(width, offsetDays * dayWidth);
                                        const pct = Math.round(task.physicalProgress ?? task.percentComplete ?? 0);
                                        return (
                                          <span
                                            className="absolute text-[9px] font-bold px-1 rounded leading-none whitespace-nowrap"
                                            style={{
                                              left: offsetPx + 8,
                                              top: -16,
                                              color,
                                              background: 'white',
                                              boxShadow: `0 0 0 1px ${color}`,
                                              filter: 'drop-shadow(0 0 1px white)',
                                            }}
                                            title={`Concluído: ${pct}% • Último apontamento: ${formatDateFull(lastLogISO)}`}
                                          >
                                            {pct}%
                                          </span>
                                        );
                                      })()}
                                    </div>
                                  );
                                })()}
                              </div>
                            );
                          })}
                    </div>
                  );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <TaskRescheduleDialog
        open={!!rescheduleTaskId}
        onOpenChange={open => { if (!open) setRescheduleTaskId(null); }}
        project={project}
        task={tasks.find(task => task.id === rescheduleTaskId)}
        config={obraConfig}
        actor={auditActor}
        canRequest={canRequestReschedule}
        canApprove={canApproveReschedule}
        onSubmit={submitTaskReschedule}
        onApprove={approveTaskReschedule}
        onReject={rejectTaskReschedule}
      />
    </TooltipProvider>
  );
}
