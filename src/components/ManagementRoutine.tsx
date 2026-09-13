import { useEffect, useMemo, useState } from 'react';
import type {
  ManagementActionStatus,
  ManagementChecklistItem,
  ManagementChecklistStatus,
  ManagementMeetingAction,
  ManagementRoleAssignment,
  ManagementRoutine as ManagementRoutineData,
  ManagementWeeklyMeeting,
  Project,
  WeeklyRoutineActivity,
  WeeklyRoutineDiaryStatus,
} from '@/types/project';
import type { AuditUserInfo } from '@/lib/audit';
import { DEFAULT_TEAMS, getTeamDefinition } from '@/lib/teams';
import {
  addDaysISO,
  buildRoutineSearchActivities,
  buildWeeklyRoutine,
  findNextScheduledActivity,
  groupWeeklyRoutineActivities,
  startOfWeekISO,
  taskSchedule,
  todayISO,
  type WeeklyRoutineActivityGroup,
} from '@/lib/weeklyRoutine';
import { buildPendingAdditiveSuspensionMap, isStatusOnlySuspension } from '@/lib/additiveSchedule';
import { getAllTasks } from '@/data/sampleProject';
import { updateProjectTask } from '@/lib/taskTree';
import { resolveObraConfig } from '@/lib/obraConfig';
import { ModulePageHeader } from '@/components/ModulePageHeader';
import { applyDailyProductionLogs, upsertDailyProductionLog } from '@/lib/dailyProductionLogs';
import { validateDailyProductionLogs } from '@/lib/productionQuantityLimit';
import TaskRescheduleDialog from '@/components/TaskRescheduleDialog';
import { approveRescheduleRequest, createRescheduleRequest, rejectRescheduleRequest, submitRescheduleRequest } from '@/lib/taskRescheduling';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import {
  CalendarCheck2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ClipboardCheck,
  Clock3,
  NotebookPen,
  Plus,
  Save,
  Settings2,
  Users,
  CalendarClock,
  Search,
} from 'lucide-react';

interface Props {
  project: Project;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
  onOpenDailyReport: (dateISO: string) => void;
  onOpenProduction: (taskId: string, dateISO: string) => void;
  readOnly?: boolean;
  canRequestReschedule?: boolean;
  canApproveReschedule?: boolean;
  auditActor?: AuditUserInfo;
  initialWeek?: string;
  onWeekChange?: (weekStartISO: string) => void;
  undoButton?: React.ReactNode;
}

const DAY_NAMES = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

function dayName(date: string): string {
  return DAY_NAMES[new Date(`${date}T12:00:00`).getDay() === 0
    ? 6
    : new Date(`${date}T12:00:00`).getDay() - 1];
}

const ROLE_LABEL: Record<ManagementRoleAssignment['role'], string> = {
  gestor_obra: 'Gestor da obra',
  mestre_encarregado: 'Mestre / encarregado',
  compras: 'Compras',
  medicao: 'Medição',
  diario_obra: 'Diário de obra',
  almoxarifado: 'Almoxarifado',
  financeiro: 'Financeiro',
  qualidade: 'Qualidade',
};

const CHECK_STATUS_LABEL: Record<ManagementChecklistStatus, string> = {
  pendente: 'Pendente',
  feito: 'Feito',
  nao_aplicavel: 'N/A',
};

const ACTION_STATUS_LABEL: Record<ManagementActionStatus, string> = {
  aberta: 'Aberta',
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

const DEFAULT_CHECKLIST: Array<Pick<ManagementChecklistItem, 'id' | 'title' | 'ownerRole' | 'status'>> = [
  { id: 'cronograma-atualizado', title: 'Cronograma atualizado', ownerRole: 'gestor_obra', status: 'pendente' },
  { id: 'diario-preenchido', title: 'Diário de obra preenchido', ownerRole: 'diario_obra', status: 'pendente' },
  { id: 'restricoes-revisadas', title: 'Restrições da semana revisadas', ownerRole: 'gestor_obra', status: 'pendente' },
  { id: 'materiais-criticos', title: 'Materiais críticos conferidos', ownerRole: 'compras', status: 'pendente' },
  { id: 'medicoes-pendentes', title: 'Medições pendentes revisadas', ownerRole: 'medicao', status: 'pendente' },
  { id: 'notas-pendentes', title: 'Notas fiscais pendentes conferidas', ownerRole: 'almoxarifado', status: 'pendente' },
  { id: 'custo-real', title: 'Custo real atualizado', ownerRole: 'financeiro', status: 'pendente' },
  { id: 'decisoes-registradas', title: 'Decisões da semana registradas', ownerRole: 'gestor_obra', status: 'pendente' },
];

const DEFAULT_ROLES: ManagementRoleAssignment[] = [
  { id: 'gestor_obra', role: 'gestor_obra', personName: '' },
  { id: 'mestre_encarregado', role: 'mestre_encarregado', personName: '' },
  { id: 'compras', role: 'compras', personName: '' },
  { id: 'medicao', role: 'medicao', personName: '' },
  { id: 'diario_obra', role: 'diario_obra', personName: '' },
  { id: 'almoxarifado', role: 'almoxarifado', personName: '' },
  { id: 'financeiro', role: 'financeiro', personName: '' },
  { id: 'qualidade', role: 'qualidade', personName: '' },
];

function uid(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function formatDateBR(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function formatShortDate(value: string) {
  const [, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}`;
}

function ensureRoutine(project: Project): ManagementRoutineData {
  const existing = project.managementRoutine;
  return {
    responsibleName: existing?.responsibleName ?? '',
    foremanName: existing?.foremanName ?? '',
    buyerName: existing?.buyerName ?? '',
    measurementResponsibleName: existing?.measurementResponsibleName ?? '',
    dailyReportResponsibleName: existing?.dailyReportResponsibleName ?? '',
    weeklyMeetingDay: existing?.weeklyMeetingDay ?? 'segunda-feira',
    measurementPeriod: existing?.measurementPeriod ?? 'mensal',
    internalApprovalRule: existing?.internalApprovalRule ?? '',
    roles: DEFAULT_ROLES.map(role => ({ ...role, ...(existing?.roles ?? []).find(saved => saved.role === role.role) })),
    weeklyChecklist: DEFAULT_CHECKLIST.map(item => ({ ...item, ...(existing?.weeklyChecklist ?? []).find(saved => saved.id === item.id) })),
    meetings: existing?.meetings ?? [],
    weeklyPlans: existing?.weeklyPlans ?? [],
  };
}

const DIARY_META: Record<WeeklyRoutineDiaryStatus, { label: string; className: string }> = {
  notFilled: { label: 'Não preenchido', className: 'border-border bg-muted/40 text-muted-foreground' },
  filled: { label: 'Preenchido', className: 'border-success/30 bg-success/10 text-success' },
  noProduction: { label: 'Sem produção', className: 'border-warning/30 bg-warning/10 text-warning' },
  impediment: { label: 'Com impedimento', className: 'border-destructive/30 bg-destructive/10 text-destructive' },
};

/** Identificação visual estável por capítulo principal; não representa status operacional. */
const CHAPTER_TONES = [
  { card: 'border-l-sky-400 bg-sky-50/35 hover:border-sky-300 hover:bg-sky-50/60', header: 'border border-sky-200/80 bg-sky-50/75 text-sky-950', nested: 'border border-sky-100 bg-sky-50/45 text-sky-950', badge: 'border-sky-200 bg-white/70 text-sky-700' },
  { card: 'border-l-emerald-400 bg-emerald-50/30 hover:border-emerald-300 hover:bg-emerald-50/55', header: 'border border-emerald-200/80 bg-emerald-50/75 text-emerald-950', nested: 'border border-emerald-100 bg-emerald-50/45 text-emerald-950', badge: 'border-emerald-200 bg-white/70 text-emerald-700' },
  { card: 'border-l-violet-400 bg-violet-50/30 hover:border-violet-300 hover:bg-violet-50/55', header: 'border border-violet-200/80 bg-violet-50/75 text-violet-950', nested: 'border border-violet-100 bg-violet-50/45 text-violet-950', badge: 'border-violet-200 bg-white/70 text-violet-700' },
  { card: 'border-l-amber-400 bg-amber-50/35 hover:border-amber-300 hover:bg-amber-50/60', header: 'border border-amber-200/80 bg-amber-50/75 text-amber-950', nested: 'border border-amber-100 bg-amber-50/45 text-amber-950', badge: 'border-amber-200 bg-white/70 text-amber-700' },
  { card: 'border-l-rose-400 bg-rose-50/30 hover:border-rose-300 hover:bg-rose-50/55', header: 'border border-rose-200/80 bg-rose-50/75 text-rose-950', nested: 'border border-rose-100 bg-rose-50/45 text-rose-950', badge: 'border-rose-200 bg-white/70 text-rose-700' },
  { card: 'border-l-cyan-400 bg-cyan-50/30 hover:border-cyan-300 hover:bg-cyan-50/55', header: 'border border-cyan-200/80 bg-cyan-50/75 text-cyan-950', nested: 'border border-cyan-100 bg-cyan-50/45 text-cyan-950', badge: 'border-cyan-200 bg-white/70 text-cyan-700' },
] as const;

function chapterTone(chapterId: string) {
  let hash = 0;
  for (let index = 0; index < chapterId.length; index += 1) hash = (hash * 31 + chapterId.charCodeAt(index)) | 0;
  return CHAPTER_TONES[Math.abs(hash) % CHAPTER_TONES.length];
}

function ActivityCard({
  activity,
  onRegister,
  teams,
  readOnly = false,
  tone,
  onReschedule,
  expanded,
  onToggle,
}: {
  activity: WeeklyRoutineActivity;
  onRegister: (activity: WeeklyRoutineActivity, actualQuantity: number) => void;
  teams: Project['teams'];
  readOnly?: boolean;
  tone: (typeof CHAPTER_TONES)[number];
  onReschedule?: (taskId: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const team = getTeamDefinition(activity.teamCode, teams?.length ? teams : DEFAULT_TEAMS);
  const [actualDraft, setActualDraft] = useState(() => String(activity.actualQuantity || ''));
  useEffect(() => setActualDraft(activity.actualQuantity ? String(activity.actualQuantity) : ''), [activity.actualQuantity, activity.date, activity.taskId]);
  const actualQuantity = Number(actualDraft);
  const maximumForDate = Math.max(0, activity.totalQuantity - (activity.executedQuantity - activity.actualQuantity));
  const exceedsContract = actualDraft.trim() !== '' && actualQuantity > maximumForDate + 0.000001;
  const canRegister = actualDraft.trim() !== '' && Number.isFinite(actualQuantity) && actualQuantity >= 0 && !exceedsContract;
  return (
    <article className={`overflow-hidden rounded-lg border border-l-4 bg-background transition ${tone.card}`}>
      <button type="button" className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 p-3 text-left" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-foreground">{activity.taskName}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{formatShortDate(activity.startDate)}–{formatShortDate(activity.endDate)} · Meta {activity.plannedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {activity.unit}</span>
        </span>
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          {activity.reprogrammed && <Badge variant="outline" className="border-violet-300 bg-violet-50 text-[11px] font-semibold text-violet-800">Reprogramada</Badge>}
          {activity.completed ? <Badge variant="outline" className="border-success/30 bg-success/10 text-success">Concluída</Badge> : <Badge variant="outline" className="tabular-nums">{activity.progressPercent.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</Badge>}
        </span>
      </button>
      {expanded && <div className="border-t border-border bg-background/80 p-3 sm:pl-10">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><p className="text-xs text-muted-foreground">Equipe</p><p className="text-sm font-medium">{team?.label ?? 'Sem equipe'}</p></div>
          <div><p className="text-xs text-muted-foreground">Executado</p><p className="text-sm font-medium tabular-nums">{activity.executedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} de {activity.totalQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {activity.unit}</p></div>
          <div><p className="text-xs text-muted-foreground">Responsável</p><p className="truncate text-sm font-medium">{activity.responsible || 'Sem responsável'}</p></div>
        </div>
        <Progress value={activity.progressPercent} className="mt-3 h-2" aria-label={`${activity.progressPercent}% concluído`} />
        {!readOnly && !activity.completed && (
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:max-w-lg">
          <label className="min-w-0 text-[11px] font-medium text-muted-foreground">
            Executado em {formatShortDate(activity.date)} ({activity.unit})
            <Input
              type="number"
              min={0}
              max={maximumForDate}
              step="0.01"
              value={actualDraft}
              onChange={event => setActualDraft(event.target.value)}
              className="mt-1 h-10 text-sm"
              aria-label={`Quantidade executada em ${formatDateBR(activity.date)} para ${activity.taskName}`}
            />
            {exceedsContract && <span className="mt-1 block text-[10px] font-medium text-destructive">Máximo permitido: {maximumForDate.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {activity.unit}.</span>}
          </label>
          <Button type="button" size="sm" className="mt-[18px] min-h-10" disabled={!canRegister} title={exceedsContract ? `Saldo disponível: ${maximumForDate.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${activity.unit}` : undefined} onClick={() => onRegister(activity, actualQuantity)}>
            Registrar
          </Button>
        </div>
        )}
      {onReschedule && !activity.completed && <Button type="button" variant="ghost" size="sm" className="mt-1 min-h-9 w-full text-violet-700" onClick={() => onReschedule(activity.taskId)}>
        <CalendarClock className="mr-1.5 h-3.5 w-3.5" /> Reprogramar atividade
      </Button>}
      </div>}
    </article>
  );
}

function ActivityGroups({ groups, date, teams, onRegister, readOnly, onReschedule, depth = 0, rootChapterId, expandedGroups, onToggleGroup, expandedTaskId, onToggleTask, forceOpen = false }: {
  groups: WeeklyRoutineActivityGroup[];
  date: string;
  teams: Project['teams'];
  onRegister: (activity: WeeklyRoutineActivity, actualQuantity: number) => void;
  readOnly: boolean;
  onReschedule?: (taskId: string) => void;
  depth?: number;
  rootChapterId?: string;
  expandedGroups: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  expandedTaskId: string | null;
  onToggleTask: (id: string) => void;
  forceOpen?: boolean;
}) {
  return (
    <div className={`space-y-2 ${depth ? 'border-l border-primary/20 pl-2' : ''}`}>
      {groups.map(group => {
        const chapterRootId = rootChapterId ?? group.chapter.id;
        const tone = chapterTone(chapterRootId);
        const isOpen = forceOpen || expandedGroups.has(group.chapter.id);
        return (
        <section key={group.chapter.id} className="space-y-2">
          <button type="button" onClick={() => onToggleGroup(group.chapter.id)} aria-expanded={isOpen} className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left ${depth ? tone.nested : tone.header}`}>
            <span className="flex min-w-0 items-center gap-2">
              {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
            <p className="min-w-0 truncate text-[11px] font-bold uppercase tracking-wide text-foreground">
              {group.chapter.number ? `${group.chapter.number} · ` : ''}{group.chapter.name}
            </p>
            </span>
            <Badge variant="outline" className={`shrink-0 text-[10px] ${tone.badge}`}>{group.totalActivities}</Badge>
          </button>
          {isOpen && group.activities.map(activity => (
            <ActivityCard
              key={`${date}:${activity.taskId}`}
              activity={activity}
              teams={teams}
              onRegister={onRegister}
              readOnly={readOnly}
              tone={tone}
              onReschedule={onReschedule}
              expanded={expandedTaskId === activity.taskId}
              onToggle={() => onToggleTask(activity.taskId)}
            />
          ))}
          {isOpen && group.children.length > 0 && <ActivityGroups groups={group.children} date={date} teams={teams} onRegister={onRegister} readOnly={readOnly} onReschedule={onReschedule} depth={depth + 1} rootChapterId={chapterRootId} expandedGroups={expandedGroups} onToggleGroup={onToggleGroup} expandedTaskId={expandedTaskId} onToggleTask={onToggleTask} forceOpen={forceOpen} />}
        </section>
      )})}
    </div>
  );
}

export default function ManagementRoutine({ project, onProjectChange, onOpenDailyReport, readOnly = false, canRequestReschedule = false, canApproveReschedule = false, auditActor = {}, initialWeek, onWeekChange, undoButton }: Props) {
  const routine = useMemo(() => ensureRoutine(project), [project]);
  const [activeTab, setActiveTab] = useState('agenda');
  const [rescheduleTaskId, setRescheduleTaskId] = useState<string | null>(null);
  const [selectedWeekStart, setSelectedWeekStart] = useState(() => startOfWeekISO(initialWeek || todayISO()));
  const [selectedDate, setSelectedDate] = useState(() => initialWeek || todayISO());
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`obraplanner:routine-expanded:${project.id}`) || '[]'));
    } catch {
      return new Set();
    }
  });
  const obraCalendar = useMemo(() => resolveObraConfig(project), [project]);
  const pendingAdditiveTaskIds = useMemo(() => new Set(
    Object.entries(buildPendingAdditiveSuspensionMap(project))
      .filter(([, suspension]) => isStatusOnlySuspension(suspension))
      .map(([taskId]) => taskId),
  ), [project]);
  const week = useMemo(
    () => buildWeeklyRoutine(project, selectedWeekStart, pendingAdditiveTaskIds, obraCalendar),
    [obraCalendar, pendingAdditiveTaskIds, project, selectedWeekStart],
  );
  const selectedDay = week.find(day => day.date === selectedDate);
  const searchedActivities = useMemo(
    () => buildRoutineSearchActivities(project, selectedDate, searchQuery, pendingAdditiveTaskIds, obraCalendar),
    [obraCalendar, pendingAdditiveTaskIds, project, searchQuery, selectedDate],
  );
  const visibleActivities = useMemo(
    () => searchQuery.trim() ? searchedActivities : (selectedDay?.activities ?? []),
    [searchQuery, searchedActivities, selectedDay?.activities],
  );
  const visibleGroups = useMemo(() => groupWeeklyRoutineActivities(visibleActivities), [visibleActivities]);
  const nextActivity = useMemo(
    () => findNextScheduledActivity(project, addDaysISO(selectedWeekStart, 7), pendingAdditiveTaskIds, obraCalendar),
    [obraCalendar, pendingAdditiveTaskIds, project, selectedWeekStart],
  );
  const registerActivityProduction = (activity: WeeklyRoutineActivity, actualQuantity: number) => {
    const currentTask = getAllTasks(project).find(task => task.id === activity.taskId);
    if (!currentTask) return;
    const candidateLogs = upsertDailyProductionLog(currentTask, activity.date, actualQuantity);
    const initialValidation = validateDailyProductionLogs(currentTask, candidateLogs);
    if (!initialValidation.allowed) {
      toast({ variant: 'destructive', title: 'Quantidade acima do contrato', description: initialValidation.message });
      return;
    }
    onProjectChange(previous => {
      let next = previous;
      const taskBefore = getAllTasks(next).find(task => task.id === activity.taskId);
      if (!taskBefore) return previous;
      const isOutsideSchedule = !taskSchedule(taskBefore, obraCalendar).workDays.has(activity.date);
      if (isOutsideSchedule && canRequestReschedule) {
        const request = createRescheduleRequest(
          taskBefore,
          activity.date,
          `Produção registrada fora da programação em ${formatDateBR(activity.date)}.`,
          obraCalendar,
          auditActor,
        );
        next = submitRescheduleRequest(next, request, auditActor);
        if (canApproveReschedule) next = approveRescheduleRequest(next, request.id, obraCalendar, auditActor);
      }
      next = updateProjectTask(next, activity.taskId, task => {
        const logs = upsertDailyProductionLog(task, activity.date, actualQuantity);
        if (!validateDailyProductionLogs(task, logs).allowed) return task;
        return { ...task, ...applyDailyProductionLogs(task, logs) };
      });
      return next;
    });
    if (!taskSchedule(currentTask, obraCalendar).workDays.has(activity.date)) {
      toast({ title: canApproveReschedule ? 'Produção e cronograma atualizados' : 'Produção registrada', description: canApproveReschedule ? 'A atividade foi reprogramada automaticamente.' : 'A reprogramação foi enviada para aprovação.' });
    }
  };

  const submitTaskReschedule = (request: Parameters<typeof submitRescheduleRequest>[1], approveNow: boolean) => {
    const requested = submitRescheduleRequest(project, request, auditActor);
    onProjectChange(approveNow ? approveRescheduleRequest(requested, request.id, obraCalendar, auditActor) : requested);
  };
  const approveTaskReschedule = (requestId: string) => onProjectChange(approveRescheduleRequest(project, requestId, obraCalendar, auditActor));
  const rejectTaskReschedule = (requestId: string, reason: string) => onProjectChange(rejectRescheduleRequest(project, requestId, reason, auditActor));

  useEffect(() => {
    if (initialWeek) {
      setSelectedWeekStart(startOfWeekISO(initialWeek));
      setSelectedDate(initialWeek);
    }
  }, [initialWeek]);

  useEffect(() => {
    try {
      localStorage.setItem(`obraplanner:routine-expanded:${project.id}`, JSON.stringify([...expandedGroups]));
    } catch {
      // A expansão é apenas preferência visual; indisponibilidade local não bloqueia a Rotina.
    }
  }, [expandedGroups, project.id]);

  const selectDate = (date: string) => {
    setSelectedDate(date);
    setSelectedWeekStart(startOfWeekISO(date));
    setExpandedTaskId(null);
    onWeekChange?.(date);
  };

  const toggleGroup = (id: string) => setExpandedGroups(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const [meetingDraft, setMeetingDraft] = useState<ManagementWeeklyMeeting>(() => ({
    id: uid('meeting'),
    date: todayISO(),
    participants: '',
    problems: '',
    decisions: '',
    nextPending: '',
    actions: [],
    createdAt: nowISO(),
    updatedAt: nowISO(),
  }));
  const [actionDraft, setActionDraft] = useState<ManagementMeetingAction>({
    id: uid('action'),
    title: '',
    responsible: '',
    dueDate: '',
    status: 'aberta',
  });

  const updateRoutine = (patch: Partial<ManagementRoutineData>) => {
    onProjectChange(previous => ({ ...previous, managementRoutine: { ...ensureRoutine(previous), ...patch } }));
  };

  const updateRole = (role: ManagementRoleAssignment['role'], patch: Partial<ManagementRoleAssignment>) => {
    updateRoutine({ roles: routine.roles.map(item => item.role === role ? { ...item, ...patch } : item) });
  };

  const updateChecklist = (id: string, patch: Partial<ManagementChecklistItem>) => {
    updateRoutine({
      weeklyChecklist: routine.weeklyChecklist.map(item => item.id === id ? { ...item, ...patch, updatedAt: nowISO() } : item),
    });
  };

  const addActionToDraft = () => {
    const title = actionDraft.title.trim();
    if (!title) return;
    setMeetingDraft(previous => ({ ...previous, actions: [...previous.actions, { ...actionDraft, id: uid('action'), title }] }));
    setActionDraft({ id: uid('action'), title: '', responsible: '', dueDate: '', status: 'aberta' });
  };

  const saveMeeting = () => {
    if (!meetingDraft.date) return;
    const saved = { ...meetingDraft, id: uid('meeting'), createdAt: nowISO(), updatedAt: nowISO() };
    updateRoutine({ meetings: [saved, ...routine.meetings].slice(0, 40) });
    setMeetingDraft({ id: uid('meeting'), date: todayISO(), participants: '', problems: '', decisions: '', nextPending: '', actions: [], createdAt: nowISO(), updatedAt: nowISO() });
  };

  return (
    <div className="mx-auto max-w-[1800px] space-y-5 p-4 lg:p-6">
      <ModulePageHeader
        eyebrow={(
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <CalendarCheck2 className="h-4 w-4 text-primary" /> Visão geral
          </div>
        )}
        title="Rotina semanal"
        description="Atividades programadas e situação dos Diários de Obra, sem duplicar o Cronograma."
        actions={undoButton}
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid h-auto min-h-11 w-full grid-cols-2 sm:inline-flex sm:w-auto">
          <TabsTrigger value="agenda" className="min-h-10 gap-2 px-4 text-sm"><CalendarDays className="h-4 w-4" /> Agenda da semana</TabsTrigger>
          <TabsTrigger value="configuracao" className="min-h-10 gap-2 px-4 text-sm"><Settings2 className="h-4 w-4" /> Configuração da rotina</TabsTrigger>
        </TabsList>

        <TabsContent value="agenda" className="mt-5 space-y-5">
          <section className="space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" className="min-h-11 min-w-11" onClick={() => selectDate(addDaysISO(selectedDate, -1))} aria-label="Dia anterior"><ChevronLeft className="h-4 w-4" /></Button>
                <Input type="date" value={selectedDate} onChange={event => selectDate(event.target.value)} className="min-h-11 w-[170px]" aria-label="Data da rotina" />
                <Button variant="outline" size="icon" className="min-h-11 min-w-11" onClick={() => selectDate(addDaysISO(selectedDate, 1))} aria-label="Próximo dia"><ChevronRight className="h-4 w-4" /></Button>
                <Button variant="outline" className="min-h-11" onClick={() => selectDate(todayISO())}>Hoje</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={selectedDay ? DIARY_META[selectedDay.diaryStatus].className : ''}>{selectedDay ? DIARY_META[selectedDay.diaryStatus].label : 'Dia sem expediente'}</Badge>
                <span className="text-sm text-muted-foreground">{visibleActivities.length} atividade(s)</span>
                <Button size="sm" className="min-h-11" onClick={() => onOpenDailyReport(selectedDate)}><NotebookPen className="mr-1.5 h-4 w-4" /> Abrir diário</Button>
              </div>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchQuery} onChange={event => { setSearchQuery(event.target.value); setExpandedTaskId(null); }} className="min-h-11 pl-9" placeholder="Buscar qualquer atividade por nome, número ou capítulo" aria-label="Buscar atividade" />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {Array.from({ length: 7 }, (_, index) => addDaysISO(selectedWeekStart, index)).map(date => {
                const day = week.find(item => item.date === date);
                const active = date === selectedDate;
                return <button key={date} type="button" onClick={() => selectDate(date)} className={`min-w-[86px] rounded-lg border px-3 py-2 text-left transition ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted/60'}`}>
                  <span className="block text-xs font-semibold uppercase">{dayName(date)}</span>
                  <span className="block text-sm font-bold">{formatShortDate(date)}</span>
                  <span className={`block text-xs ${active ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{day?.activities.length ?? 0} atividade(s)</span>
                </button>;
              })}
            </div>
          </section>

          {visibleActivities.length ? (
            <section className="space-y-3">
              <ActivityGroups groups={visibleGroups} date={selectedDate} teams={project.teams} onRegister={registerActivityProduction} readOnly={readOnly} onReschedule={canRequestReschedule || canApproveReschedule ? setRescheduleTaskId : undefined} expandedGroups={expandedGroups} onToggleGroup={toggleGroup} expandedTaskId={expandedTaskId} onToggleTask={id => setExpandedTaskId(previous => previous === id ? null : id)} forceOpen={!!searchQuery.trim()} />
            </section>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center py-12 text-center">
                <CalendarDays className="h-9 w-9 text-muted-foreground" />
                <h2 className="mt-3 text-lg font-semibold">Nenhuma atividade encontrada</h2>
                <p className="mt-2 text-sm text-muted-foreground">Altere a data ou busque uma atividade de qualquer período.</p>
                {!searchQuery.trim() && nextActivity && <Button variant="outline" className="mt-4" onClick={() => selectDate(nextActivity.date)}>Ir para {formatDateBR(nextActivity.date)}</Button>}
              </CardContent>
            </Card>
          )}

        </TabsContent>

        <TabsContent value="configuracao" className="mt-5 space-y-5">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Settings2 className="h-4 w-4 text-primary" /> Responsáveis e parâmetros</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              {[
                ['Responsável pela obra', 'responsibleName'],
                ['Mestre / encarregado', 'foremanName'],
                ['Responsável por compras', 'buyerName'],
                ['Responsável por medição', 'measurementResponsibleName'],
                ['Responsável pelo diário', 'dailyReportResponsibleName'],
                ['Dia da reunião semanal', 'weeklyMeetingDay'],
                ['Período padrão de medição', 'measurementPeriod'],
                ['Regra de aprovação interna', 'internalApprovalRule'],
              ].map(([label, key]) => (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={`routine-${key}`}>{label}</Label>
                  <Input id={`routine-${key}`} value={String(routine[key as keyof ManagementRoutineData] ?? '')} onChange={event => updateRoutine({ [key]: event.target.value })} />
                </div>
              ))}
            </CardContent>
          </Card>

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ClipboardCheck className="h-4 w-4 text-primary" /> Checklist de apoio</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {routine.weeklyChecklist.map(item => (
                  <div key={item.id} className="rounded-lg border border-border p-3">
                    <p className="text-sm font-semibold">{item.title}</p>
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_150px]">
                      <div className="space-y-1.5">
                        <Label htmlFor={`check-note-${item.id}`} className="text-xs">Observação</Label>
                        <Input id={`check-note-${item.id}`} value={item.notes ?? ''} onChange={event => updateChecklist(item.id, { notes: event.target.value })} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`check-status-${item.id}`} className="text-xs">Situação</Label>
                        <select id={`check-status-${item.id}`} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={item.status} onChange={event => updateChecklist(item.id, { status: event.target.value as ManagementChecklistStatus })}>
                          {Object.entries(CHECK_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4 text-primary" /> Papéis e responsabilidades</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {routine.roles.map(role => (
                  <div key={role.role} className="grid grid-cols-1 gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
                    <p className="sm:col-span-2 text-sm font-semibold">{ROLE_LABEL[role.role]}</p>
                    <div className="space-y-1.5">
                      <Label htmlFor={`role-owner-${role.role}`} className="text-xs">Responsável direto</Label>
                      <Input id={`role-owner-${role.role}`} value={role.personName} onChange={event => updateRole(role.role, { personName: event.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`role-approval-${role.role}`} className="text-xs">Quem aprova</Label>
                      <Input id={`role-approval-${role.role}`} value={role.approvalPersonName ?? ''} onChange={event => updateRole(role.role, { approvalPersonName: event.target.value })} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>

          <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="h-4 w-4 text-primary" /> Ata da reunião semanal</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5"><Label htmlFor="meeting-date">Data</Label><Input id="meeting-date" type="date" value={meetingDraft.date} onChange={event => setMeetingDraft(previous => ({ ...previous, date: event.target.value }))} /></div>
                <div className="space-y-1.5"><Label htmlFor="meeting-participants">Participantes</Label><Textarea id="meeting-participants" value={meetingDraft.participants ?? ''} onChange={event => setMeetingDraft(previous => ({ ...previous, participants: event.target.value }))} /></div>
                <div className="space-y-1.5"><Label htmlFor="meeting-problems">Problemas encontrados</Label><Textarea id="meeting-problems" value={meetingDraft.problems ?? ''} onChange={event => setMeetingDraft(previous => ({ ...previous, problems: event.target.value }))} /></div>
                <div className="space-y-1.5"><Label htmlFor="meeting-decisions">Decisões tomadas</Label><Textarea id="meeting-decisions" value={meetingDraft.decisions ?? ''} onChange={event => setMeetingDraft(previous => ({ ...previous, decisions: event.target.value }))} /></div>
                <div className="space-y-1.5"><Label htmlFor="meeting-pending">Pendências para a próxima reunião</Label><Textarea id="meeting-pending" value={meetingDraft.nextPending ?? ''} onChange={event => setMeetingDraft(previous => ({ ...previous, nextPending: event.target.value }))} /></div>

                <div className="rounded-lg border border-border p-3">
                  <p className="text-sm font-semibold">Ações da reunião</p>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_150px_145px_auto]">
                    <Input aria-label="Ação ou decisão" placeholder="Ação ou decisão" value={actionDraft.title} onChange={event => setActionDraft(previous => ({ ...previous, title: event.target.value }))} />
                    <Input aria-label="Responsável pela ação" placeholder="Responsável" value={actionDraft.responsible ?? ''} onChange={event => setActionDraft(previous => ({ ...previous, responsible: event.target.value }))} />
                    <Input aria-label="Prazo da ação" type="date" value={actionDraft.dueDate ?? ''} onChange={event => setActionDraft(previous => ({ ...previous, dueDate: event.target.value }))} />
                    <Button type="button" variant="outline" className="min-h-10" onClick={addActionToDraft}><Plus className="h-4 w-4" /><span className="sr-only">Adicionar ação</span></Button>
                  </div>
                  {meetingDraft.actions.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {meetingDraft.actions.map(action => <li key={action.id} className="rounded-md bg-muted/40 p-2 text-sm">{action.title} · {action.responsible || 'Sem responsável'}</li>)}
                    </ul>
                  )}
                </div>
                <Button onClick={saveMeeting} className="min-h-11"><Save className="mr-2 h-4 w-4" /> Salvar reunião</Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Clock3 className="h-4 w-4 text-primary" /> Histórico e pendências</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {routine.meetings.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Nenhuma reunião registrada.</p>
                ) : routine.meetings.map(meeting => (
                  <article key={meeting.id} className="rounded-lg border border-border p-4">
                    <p className="text-sm font-semibold">Reunião de {formatDateBR(meeting.date)}</p>
                    {meeting.decisions && <p className="mt-2 text-sm text-muted-foreground">{meeting.decisions}</p>}
                    {meeting.actions.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {meeting.actions.map(action => (
                          <div key={action.id} className="flex items-center justify-between gap-3 rounded-md bg-muted/40 p-2 text-sm">
                            <span>{action.title}</span>
                            <Badge variant="outline">{ACTION_STATUS_LABEL[action.status]}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </CardContent>
            </Card>
          </section>
        </TabsContent>
      </Tabs>
      <TaskRescheduleDialog
        open={!!rescheduleTaskId}
        onOpenChange={open => { if (!open) setRescheduleTaskId(null); }}
        project={project}
        task={getAllTasks(project).find(task => task.id === rescheduleTaskId)}
        config={obraCalendar}
        actor={auditActor}
        canRequest={canRequestReschedule}
        canApprove={canApproveReschedule}
        onSubmit={submitTaskReschedule}
        onApprove={approveTaskReschedule}
        onReject={rejectTaskReschedule}
      />
    </div>
  );
}
