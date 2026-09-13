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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import {
  ArrowRight,
  CalendarCheck2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
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
  onOpenProduction,
  onRegister,
  teams,
  readOnly = false,
  tone,
  onReschedule,
}: {
  activity: WeeklyRoutineActivity;
  onOpenProduction: (taskId: string, dateISO: string) => void;
  onRegister: (activity: WeeklyRoutineActivity, actualQuantity: number) => void;
  teams: Project['teams'];
  readOnly?: boolean;
  tone: (typeof CHAPTER_TONES)[number];
  onReschedule?: (taskId: string) => void;
}) {
  const team = getTeamDefinition(activity.teamCode, teams?.length ? teams : DEFAULT_TEAMS);
  const [actualDraft, setActualDraft] = useState(() => String(activity.actualQuantity || ''));
  useEffect(() => setActualDraft(activity.actualQuantity ? String(activity.actualQuantity) : ''), [activity.actualQuantity, activity.date, activity.taskId]);
  const actualQuantity = Number(actualDraft);
  const maximumForDate = Math.max(0, activity.totalQuantity - (activity.executedQuantity - activity.actualQuantity));
  const exceedsContract = actualDraft.trim() !== '' && actualQuantity > maximumForDate + 0.000001;
  const canRegister = actualDraft.trim() !== '' && Number.isFinite(actualQuantity) && actualQuantity >= 0 && !exceedsContract;
  return (
    <article className={`group w-full rounded-lg border border-border border-l-4 bg-background p-3 text-left transition ${tone.card}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-3 text-sm font-semibold leading-snug text-foreground">{activity.taskName}</p>
        {activity.completed && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label="Atividade concluída" />}
      </div>
      {activity.completed && <Badge variant="outline" className="mt-2 border-success/30 bg-success/10 text-[10px] font-semibold text-success">Concluída</Badge>}
      {activity.reprogrammed && <Badge variant="outline" className="mt-2 border-violet-300 bg-violet-50 text-[10px] font-semibold text-violet-800">Atividade reprogramada</Badge>}
      <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <div><dt className="sr-only">Equipe</dt><dd>{team?.label ?? 'Sem equipe'}</dd></div>
        <div className="text-right tabular-nums">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Meta do dia</dt>
          <dd className="font-medium text-foreground" aria-label={`Meta do dia: ${activity.plannedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${activity.unit}`}>
            {activity.plannedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {activity.unit}
          </dd>
        </div>
        <div><dt className="sr-only">Período</dt><dd>{formatShortDate(activity.startDate)}–{formatShortDate(activity.endDate)}</dd></div>
        <div className="truncate text-right"><dt className="sr-only">Responsável</dt><dd>{activity.responsible || 'Sem responsável'}</dd></div>
      </dl>
      <div className="mt-3 rounded-md bg-muted/35 p-2.5">
        <div className="grid grid-cols-2 gap-x-2 text-xs text-muted-foreground">
          <span>Total: <strong className="font-semibold text-foreground">{activity.totalQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {activity.unit}</strong></span>
          <span className="text-right">Executado: <strong className="font-semibold text-foreground">{activity.executedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {activity.unit}</strong></span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
          <span>Conclusão da atividade</span>
          <span className="text-foreground">{activity.progressPercent.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>
        </div>
        <Progress value={activity.progressPercent} className="mt-1.5 h-2" aria-label={`${activity.progressPercent}% concluído`} />
      </div>
      {!readOnly && !activity.completed && (
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
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
      <Button type="button" variant="outline" size="sm" className="mt-2 min-h-10 w-full" onClick={() => onOpenProduction(activity.taskId, activity.date)}>
        Ir para produção <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
      </Button>
      {onReschedule && !activity.completed && <Button type="button" variant="ghost" size="sm" className="mt-1 min-h-9 w-full text-violet-700" onClick={() => onReschedule(activity.taskId)}>
        <CalendarClock className="mr-1.5 h-3.5 w-3.5" /> Reprogramar atividade
      </Button>}
    </article>
  );
}

function ActivityGroups({ groups, date, teams, onOpenProduction, onRegister, readOnly, onReschedule, depth = 0, rootChapterId }: {
  groups: WeeklyRoutineActivityGroup[];
  date: string;
  teams: Project['teams'];
  onOpenProduction: (taskId: string, dateISO: string) => void;
  onRegister: (activity: WeeklyRoutineActivity, actualQuantity: number) => void;
  readOnly: boolean;
  onReschedule?: (taskId: string) => void;
  depth?: number;
  rootChapterId?: string;
}) {
  return (
    <div className={`space-y-2 ${depth ? 'border-l border-primary/20 pl-2' : ''}`}>
      {groups.map(group => {
        const chapterRootId = rootChapterId ?? group.chapter.id;
        const tone = chapterTone(chapterRootId);
        return (
        <section key={group.chapter.id} className="space-y-2">
          <div className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 ${depth ? tone.nested : tone.header}`}>
            <p className="min-w-0 truncate text-[11px] font-bold uppercase tracking-wide text-foreground">
              {group.chapter.number ? `${group.chapter.number} · ` : ''}{group.chapter.name}
            </p>
            <Badge variant="outline" className={`shrink-0 text-[10px] ${tone.badge}`}>{group.totalActivities}</Badge>
          </div>
          {group.activities.map(activity => (
            <ActivityCard
              key={`${date}:${activity.taskId}`}
              activity={activity}
              teams={teams}
              onOpenProduction={onOpenProduction}
              onRegister={onRegister}
              readOnly={readOnly}
              tone={tone}
              onReschedule={onReschedule}
            />
          ))}
          {group.children.length > 0 && <ActivityGroups groups={group.children} date={date} teams={teams} onOpenProduction={onOpenProduction} onRegister={onRegister} readOnly={readOnly} onReschedule={onReschedule} depth={depth + 1} rootChapterId={chapterRootId} />}
        </section>
      )})}
    </div>
  );
}

function SelectedChapterActivities({ group, date, teams, onOpenProduction, onRegister, readOnly, onReschedule }: {
  group?: WeeklyRoutineActivityGroup;
  date: string;
  teams: Project['teams'];
  onOpenProduction: (taskId: string, dateISO: string) => void;
  onRegister: (activity: WeeklyRoutineActivity, actualQuantity: number) => void;
  readOnly: boolean;
  onReschedule?: (taskId: string) => void;
}) {
  if (!group) return <p className="py-8 text-center text-xs text-muted-foreground">Sem atividade</p>;
  const tone = chapterTone(group.chapter.id);
  return (
    <div className="space-y-2">
      {group.activities.map(activity => (
        <ActivityCard key={`${date}:${activity.taskId}`} activity={activity} teams={teams} onOpenProduction={onOpenProduction} onRegister={onRegister} readOnly={readOnly} tone={tone} onReschedule={onReschedule} />
      ))}
      {group.children.length > 0 && <ActivityGroups groups={group.children} date={date} teams={teams} onOpenProduction={onOpenProduction} onRegister={onRegister} readOnly={readOnly} onReschedule={onReschedule} depth={1} rootChapterId={group.chapter.id} />}
    </div>
  );
}

export default function ManagementRoutine({ project, onProjectChange, onOpenDailyReport, onOpenProduction, readOnly = false, canRequestReschedule = false, canApproveReschedule = false, auditActor = {}, initialWeek, onWeekChange, undoButton }: Props) {
  const routine = useMemo(() => ensureRoutine(project), [project]);
  const [activeTab, setActiveTab] = useState('agenda');
  const [rescheduleTaskId, setRescheduleTaskId] = useState<string | null>(null);
  const [selectedWeekStart, setSelectedWeekStart] = useState(() => startOfWeekISO(initialWeek || todayISO()));
  const [selectedChapterId, setSelectedChapterId] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchDate, setSearchDate] = useState(() => initialWeek || todayISO());
  const [searchQuery, setSearchQuery] = useState('');
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
  const rootChapters = useMemo(() => project.phases.filter(phase => !phase.parentId), [project.phases]);
  const activeRootChapterIds = useMemo(() => new Set(
    week.flatMap(day => day.activities.map(activity => activity.chapterPath[0]?.id).filter((id): id is string => !!id)),
  ), [week]);
  const selectedChapter = rootChapters.find(chapter => chapter.id === selectedChapterId);
  const selectedWeekEnd = week.at(-1)?.date ?? selectedWeekStart;
  const filteredWeek = useMemo(() => week.map(day => ({
    ...day,
    activities: day.activities.filter(activity => activity.chapterPath[0]?.id === selectedChapterId),
  })), [selectedChapterId, week]);
  const groupsByDay = useMemo(
    () => new Map(filteredWeek.map(day => [day.date, groupWeeklyRoutineActivities(day.activities)])),
    [filteredWeek],
  );
  const activities = filteredWeek.flatMap(day => day.activities);
  const uniqueActivities = new Set(activities.map(activity => activity.taskId)).size;
  const completedActivities = new Set(activities.filter(activity => activity.completed).map(activity => activity.taskId)).size;
  const filledReports = week.filter(day => day.diaryStatus === 'filled' || day.diaryStatus === 'impediment' || day.diaryStatus === 'noProduction').length;
  const pendingReports = week.filter(day => day.date <= todayISO() && day.diaryStatus === 'notFilled').length;
  const searchedActivities = useMemo(
    () => buildRoutineSearchActivities(project, searchDate, searchQuery, pendingAdditiveTaskIds, obraCalendar)
      .filter(activity => activity.chapterPath[0]?.id === selectedChapterId),
    [obraCalendar, pendingAdditiveTaskIds, project, searchDate, searchQuery, selectedChapterId],
  );
  const registerActivityProduction = (activity: WeeklyRoutineActivity, actualQuantity: number): boolean => {
    const currentTask = getAllTasks(project).find(task => task.id === activity.taskId);
    if (!currentTask) return false;
    const candidateLogs = upsertDailyProductionLog(currentTask, activity.date, actualQuantity);
    const initialValidation = validateDailyProductionLogs(currentTask, candidateLogs);
    if (!initialValidation.allowed) {
      toast({ variant: 'destructive', title: 'Quantidade acima do contrato', description: initialValidation.message });
      return false;
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
    return true;
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
      setSearchDate(initialWeek);
    }
  }, [initialWeek]);

  useEffect(() => {
    const storageKey = `obraplanner:routine-chapter:${project.id}`;
    let storedChapterId = '';
    try {
      storedChapterId = localStorage.getItem(storageKey) ?? '';
    } catch {
      // A preferência visual não pode bloquear a Rotina.
    }
    const storedExists = rootChapters.some(chapter => chapter.id === storedChapterId);
    const firstActive = rootChapters.find(chapter => activeRootChapterIds.has(chapter.id));
    setSelectedChapterId(storedExists ? storedChapterId : (firstActive?.id ?? rootChapters[0]?.id ?? ''));
  }, [activeRootChapterIds, project.id, rootChapters]);

  useEffect(() => {
    if (!selectedChapterId) return;
    try {
      localStorage.setItem(`obraplanner:routine-chapter:${project.id}`, selectedChapterId);
    } catch {
      // A preferência visual não pode bloquear a Rotina.
    }
  }, [project.id, selectedChapterId]);

  const selectWeek = (date: string) => {
    const normalized = startOfWeekISO(date);
    setSelectedWeekStart(normalized);
    onWeekChange?.(normalized);
  };

  const openActivitySearch = () => {
    const today = todayISO();
    const calendarWeekEnd = addDaysISO(selectedWeekStart, 6);
    const currentSearchDateInWeek = searchDate >= selectedWeekStart && searchDate <= calendarWeekEnd;
    const todayInWeek = today >= selectedWeekStart && today <= calendarWeekEnd;
    if (!currentSearchDateInWeek) setSearchDate(todayInWeek ? today : (week[0]?.date ?? selectedWeekStart));
    setSearchQuery('');
    setSearchOpen(true);
  };

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
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Capítulo</p>
              {rootChapters.length ? (
                <div className="mt-2 flex gap-2 overflow-x-auto pb-1" role="list" aria-label="Capítulos da rotina">
                  {rootChapters.map(chapter => {
                    const selected = chapter.id === selectedChapterId;
                    return (
                      <div key={chapter.id} role="listitem" className="shrink-0">
                        <button
                          type="button"
                          aria-pressed={selected}
                          title={chapter.name}
                          onClick={() => { setSelectedChapterId(chapter.id); setSearchOpen(false); setSearchQuery(''); }}
                          className={`min-h-11 rounded-lg border px-4 py-2 text-sm font-semibold transition ${selected ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'border-border bg-background text-foreground hover:border-primary/40 hover:bg-muted/50'}`}
                        >
                          {chapter.name}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : <p className="mt-2 text-sm text-muted-foreground">Nenhum capítulo cadastrado.</p>}
            </div>
            <div className="flex flex-col gap-3 border-t border-border pt-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Semana selecionada</p>
                <p className="mt-1 text-base font-semibold">{formatDateBR(selectedWeekStart)} a {formatDateBR(selectedWeekEnd)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" className="min-h-11" onClick={() => selectWeek(addDaysISO(selectedWeekStart, -7))}>
                  <ChevronLeft className="mr-1 h-4 w-4" /> Semana anterior
                </Button>
                <Button variant="outline" size="sm" className="min-h-11" onClick={() => selectWeek(todayISO())}>Hoje</Button>
                <Button variant="outline" size="sm" className="min-h-11" onClick={() => selectWeek(addDaysISO(selectedWeekStart, 7))}>
                  Próxima semana <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
                <Button variant="secondary" size="sm" className="min-h-11" disabled={!selectedChapterId} onClick={openActivitySearch}>
                  <Search className="mr-1.5 h-4 w-4" /> Buscar atividade
                </Button>
              </div>
            </div>
          </section>

          <section className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-muted/25 px-4 py-3 text-sm" aria-label="Resumo da semana">
            <span><strong className="tabular-nums text-foreground">{uniqueActivities}</strong> atividades programadas</span>
            <span><strong className="tabular-nums text-success">{completedActivities}</strong> concluídas</span>
            <span><strong className="tabular-nums text-success">{filledReports}</strong> Diários preenchidos</span>
            <span><strong className={`tabular-nums ${pendingReports ? 'text-warning' : 'text-foreground'}`}>{pendingReports}</strong> Diários pendentes</span>
          </section>

          {!selectedChapter ? (
            <Card className="border-dashed"><CardContent className="py-12 text-center text-sm text-muted-foreground">Cadastre um capítulo no Cronograma para organizar a Rotina.</CardContent></Card>
          ) : (
            <>
              {!activities.length && <p className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-sm text-muted-foreground">Nenhuma atividade de {selectedChapter.name} está programada nesta semana. Use “Buscar atividade” para fazer um lançamento fora da programação.</p>}
              <section className={`hidden gap-3 lg:grid ${filteredWeek.length === 6 ? 'grid-cols-6' : 'grid-cols-5'}`}>
                {filteredWeek.map(day => {
                  const diary = DIARY_META[day.diaryStatus];
                  const isToday = day.date === todayISO();
                  const rootGroup = groupsByDay.get(day.date)?.find(group => group.chapter.id === selectedChapterId);
                  return (
                    <div key={day.date} className={`min-w-0 rounded-xl border bg-card ${isToday ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border'}`}>
                      <div className="border-b border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{dayName(day.date)}</p><p className="text-base font-bold">{formatShortDate(day.date)}</p></div>
                          {isToday && <Badge>Hoje</Badge>}
                        </div>
                        <Badge variant="outline" className={`mt-2 max-w-full truncate text-[11px] ${diary.className}`}>{diary.label}</Badge>
                        <p className="mt-2 text-xs text-muted-foreground">{day.activities.length} atividade(s)</p>
                      </div>
                      <div className="space-y-2 p-2.5">
                        <SelectedChapterActivities group={rootGroup} date={day.date} teams={project.teams} onOpenProduction={onOpenProduction} onRegister={registerActivityProduction} readOnly={readOnly} onReschedule={canRequestReschedule || canApproveReschedule ? setRescheduleTaskId : undefined} />
                      </div>
                      <div className="border-t border-border p-2.5"><Button variant="ghost" size="sm" className="min-h-10 w-full text-xs" onClick={() => onOpenDailyReport(day.date)}><NotebookPen className="mr-1.5 h-4 w-4" /> Abrir diário</Button></div>
                    </div>
                  );
                })}
              </section>

              <section className="space-y-3 lg:hidden">
                {filteredWeek.map(day => {
                  const diary = DIARY_META[day.diaryStatus];
                  const rootGroup = groupsByDay.get(day.date)?.find(group => group.chapter.id === selectedChapterId);
                  return (
                    <Card key={day.date}>
                      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
                        <div><CardTitle className="text-base">{dayName(day.date)}, {formatDateBR(day.date)}</CardTitle><Badge variant="outline" className={`mt-2 text-xs ${diary.className}`}>{diary.label}</Badge><p className="mt-2 text-xs text-muted-foreground">{day.activities.length} atividade(s)</p></div>
                        <Button size="sm" className="min-h-11" onClick={() => onOpenDailyReport(day.date)}><NotebookPen className="mr-1.5 h-4 w-4" /> Abrir diário</Button>
                      </CardHeader>
                      <CardContent className="space-y-2"><SelectedChapterActivities group={rootGroup} date={day.date} teams={project.teams} onOpenProduction={onOpenProduction} onRegister={registerActivityProduction} readOnly={readOnly} onReschedule={canRequestReschedule || canApproveReschedule ? setRescheduleTaskId : undefined} /></CardContent>
                    </Card>
                  );
                })}
              </section>
            </>
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
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Buscar atividade em {selectedChapter?.name ?? 'capítulo'}</DialogTitle>
            <DialogDescription>Escolha a data do lançamento e localize uma atividade deste capítulo. Se a data estiver fora da programação, a reprogramação seguirá as permissões atuais.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="routine-search-date">Data da execução</Label>
              <Input id="routine-search-date" type="date" value={searchDate} onChange={event => setSearchDate(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="routine-search-query">Atividade</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="routine-search-query" autoFocus value={searchQuery} onChange={event => setSearchQuery(event.target.value)} className="pl-9" placeholder="Digite o nome, número ou subcapítulo" />
              </div>
            </div>
          </div>
          <div className="max-h-[58vh] space-y-3 overflow-y-auto pr-1">
            {!searchQuery.trim() ? (
              <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Digite para localizar uma atividade do capítulo selecionado.</p>
            ) : searchedActivities.length ? searchedActivities.map(activity => (
              <div key={activity.taskId} className="space-y-1.5">
                {activity.chapterPath.length > 1 && <p className="truncate text-xs font-medium text-muted-foreground">{activity.chapterPath.slice(1).map(chapter => chapter.name).join(' › ')}</p>}
                <ActivityCard
                  activity={activity}
                  teams={project.teams}
                  onOpenProduction={onOpenProduction}
                  onRegister={(candidate, quantity) => {
                    if (registerActivityProduction(candidate, quantity)) {
                      setSearchOpen(false);
                      setSearchQuery('');
                    }
                  }}
                  readOnly={readOnly}
                  tone={chapterTone(selectedChapterId)}
                  onReschedule={canRequestReschedule || canApproveReschedule ? setRescheduleTaskId : undefined}
                />
              </div>
            )) : (
              <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Nenhuma atividade encontrada neste capítulo.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
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
