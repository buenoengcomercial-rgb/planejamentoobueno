import { Fragment, useMemo, useState } from 'react';
import type {
  ManagementActionStatus,
  ManagementChecklistItem,
  ManagementChecklistStatus,
  ManagementMeetingAction,
  ManagementRoleAssignment,
  ManagementRoutine as ManagementRoutineData,
  ManagementWeeklyMeeting,
  ManagementWeeklyPlanItem,
  ManagementWeeklyTaskStatus,
  Project,
  Task,
} from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { DEFAULT_TEAMS, getTeamDefinition, type TeamCode } from '@/lib/teams';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  Plus,
  Save,
  Users,
} from 'lucide-react';

interface Props {
  project: Project;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
  undoButton?: React.ReactNode;
}

const ROLE_LABEL: Record<ManagementRoleAssignment['role'], string> = {
  gestor_obra: 'Gestor da obra',
  mestre_encarregado: 'Mestre / encarregado',
  compras: 'Compras',
  medicao: 'Medicao',
  diario_obra: 'Diario de obra',
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
  concluida: 'Concluida',
  cancelada: 'Cancelada',
};

const WEEKLY_TASK_STATUS_LABEL: Record<ManagementWeeklyTaskStatus, string> = {
  planejada: 'Planejada',
  cumprida: 'Cumprida',
  parcial: 'Parcial',
  nao_cumprida: 'Nao cumprida',
  reprogramar: 'Reprogramar',
};

const DEFAULT_CHECKLIST: Array<Pick<ManagementChecklistItem, 'id' | 'title' | 'ownerRole' | 'status'>> = [
  { id: 'cronograma-atualizado', title: 'Cronograma atualizado', ownerRole: 'gestor_obra', status: 'pendente' },
  { id: 'diario-preenchido', title: 'Diario de obra preenchido', ownerRole: 'diario_obra', status: 'pendente' },
  { id: 'restricoes-revisadas', title: 'Restricoes da semana revisadas', ownerRole: 'gestor_obra', status: 'pendente' },
  { id: 'materiais-criticos', title: 'Materiais criticos conferidos', ownerRole: 'compras', status: 'pendente' },
  { id: 'medicoes-pendentes', title: 'Medicoes pendentes revisadas', ownerRole: 'medicao', status: 'pendente' },
  { id: 'notas-pendentes', title: 'Notas fiscais pendentes conferidas', ownerRole: 'almoxarifado', status: 'pendente' },
  { id: 'custo-real', title: 'Custo real atualizado', ownerRole: 'financeiro', status: 'pendente' },
  { id: 'decisoes-registradas', title: 'Decisoes da semana registradas', ownerRole: 'gestor_obra', status: 'pendente' },
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

function parseISODate(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function toISODate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayISO() {
  return toISODate(new Date());
}

function nowISO() {
  return new Date().toISOString();
}

function weekStartISO(value: string) {
  const date = parseISODate(value);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return toISODate(date);
}

function addDaysISO(value: string, days: number) {
  const date = parseISODate(value);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

function formatDateBR(value?: string) {
  if (!value) return '-';
  const [year, month, day] = value.slice(0, 10).split('-');
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
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

function taskEndISO(task: Task) {
  const date = parseISODate(task.current?.endDate ?? task.baseline?.endDate ?? task.startDate);
  if (!task.current?.endDate && !task.baseline?.endDate) date.setDate(date.getDate() + Math.max(0, (task.duration || 1) - 1));
  return toISODate(date);
}

function overlapDays(startA: string, endA: string, startB: string, endB: string) {
  const start = Math.max(parseISODate(startA).getTime(), parseISODate(startB).getTime());
  const end = Math.min(parseISODate(endA).getTime(), parseISODate(endB).getTime());
  if (end < start) return 0;
  return Math.floor((end - start) / 86400000) + 1;
}

function plannedQuantityForWeek(task: Task, weekStart: string, weekEnd: string) {
  const logsInWeek = (task.dailyLogs ?? []).filter(log => log.date >= weekStart && log.date <= weekEnd);
  const loggedPlanned = logsInWeek.reduce((sum, log) => sum + (Number(log.plannedQuantity) || 0), 0);
  if (loggedPlanned > 0) return Math.round(loggedPlanned * 100) / 100;
  const total = Number(task.quantity) || 0;
  const duration = task.originalDuration ?? task.baseline?.duration ?? task.duration ?? 0;
  if (!total || !duration) return 0;
  const days = overlapDays(task.current?.startDate ?? task.baseline?.startDate ?? task.startDate, taskEndISO(task), weekStart, weekEnd);
  return Math.round((total / Math.max(1, duration)) * days * 100) / 100;
}

function actualQuantityFromLogs(task: Task, weekStart: string, weekEnd: string) {
  return Math.round((task.dailyLogs ?? [])
    .filter(log => log.date >= weekStart && log.date <= weekEnd)
    .reduce((sum, log) => sum + (Number(log.actualQuantity) || 0), 0) * 100) / 100;
}

function taskWasFullySuppressed(task: Task) {
  if (task.suppressedByAdditive) return true;
  return (Number(task.quantity) || 0) <= 0 && (task.additiveHistory ?? []).some(h => (h.suppressedQuantity || 0) > 0);
}

function approvedAdditiveTaskIds(project: Project) {
  const ids = new Set<string>();
  for (const additive of project.additives ?? []) {
    const approved = additive.status === 'aprovado' || additive.status === 'aditivo_contratado' || additive.isContracted;
    if (!approved) continue;
    for (const composition of additive.compositions ?? []) {
      const original = Number(composition.originalQuantity ?? composition.quantity ?? 0) || 0;
      const suppressed = Number(composition.suppressedQuantity ?? 0) || 0;
      const added = Number(composition.addedQuantity ?? 0) || 0;
      const finalQuantity = composition.isNewService ? added : Math.max(0, original + added - suppressed);
      if (finalQuantity <= 0) continue;
      if (composition.linkedTaskId) ids.add(composition.linkedTaskId);
      if (composition.taskId) ids.add(composition.taskId);
      if (composition.isNewService) ids.add(`add-${additive.id}-${composition.id}`);
    }
  }
  return ids;
}

function deriveWeeklyStatus(planned: number, actual: number): ManagementWeeklyTaskStatus {
  if (planned <= 0 && actual <= 0) return 'planejada';
  if (actual >= planned) return 'cumprida';
  if (actual > 0) return 'parcial';
  return 'nao_cumprida';
}

function updateTaskTeam(project: Project, taskId: string, team: TeamCode | undefined): Project {
  const mapTask = (task: Task): Task => ({
    ...task,
    team: task.id === taskId ? team : task.team,
    children: task.children?.map(mapTask),
  });
  return {
    ...project,
    phases: project.phases.map(phase => ({
      ...phase,
      tasks: phase.tasks.map(mapTask),
    })),
  };
}

function buildMainChapterIndex(project: Project) {
  const phaseById = new Map(project.phases.map(phase => [phase.id, phase]));
  const orderByRoot = new Map<string, number>();
  project.phases
    .filter(phase => !phase.parentId)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
    .forEach((phase, index) => orderByRoot.set(phase.id, index));

  const rootForPhase = (phaseId: string) => {
    let current = phaseById.get(phaseId);
    while (current?.parentId && phaseById.has(current.parentId)) {
      current = phaseById.get(current.parentId);
    }
    return current ?? phaseById.get(phaseId);
  };

  const taskChapter = new Map<string, { id: string; name: string; order: number }>();
  const visitTask = (task: Task, chapter: { id: string; name: string; order: number }) => {
    taskChapter.set(task.id, chapter);
    task.children?.forEach(child => visitTask(child, chapter));
  };

  for (const phase of project.phases) {
    const root = rootForPhase(phase.id);
    const chapter = {
      id: root?.id ?? phase.id,
      name: root?.name ?? phase.name,
      order: orderByRoot.get(root?.id ?? phase.id) ?? Number.MAX_SAFE_INTEGER,
    };
    phase.tasks.forEach(task => visitTask(task, chapter));
  }
  return taskChapter;
}

function StatCard({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'success' | 'warning' | 'danger' }) {
  const color =
    tone === 'success' ? 'text-success' :
    tone === 'warning' ? 'text-warning' :
    tone === 'danger' ? 'text-destructive' :
    'text-primary';
  return (
    <Card className="p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${color}`}>{value}</p>
    </Card>
  );
}

function statusClass(status: ManagementWeeklyTaskStatus) {
  if (status === 'cumprida') return 'border-success/30 bg-success/10 text-success';
  if (status === 'parcial') return 'border-warning/35 bg-warning/10 text-warning';
  if (status === 'nao_cumprida') return 'border-destructive/30 bg-destructive/10 text-destructive';
  if (status === 'reprogramar') return 'border-primary/30 bg-primary/10 text-primary';
  return 'border-border bg-muted text-muted-foreground';
}

export default function ManagementRoutine({ project, onProjectChange, undoButton }: Props) {
  const routine = useMemo(() => ensureRoutine(project), [project]);
  const tasks = useMemo(() => getAllTasks(project), [project]);
  const additiveTaskIds = useMemo(() => approvedAdditiveTaskIds(project), [project.additives]);
  const mainChapterByTask = useMemo(() => buildMainChapterIndex(project), [project.phases]);
  const teams = project.teams?.length ? project.teams : DEFAULT_TEAMS;
  const [selectedWeekStart, setSelectedWeekStart] = useState(() => weekStartISO(todayISO()));
  const selectedWeekEnd = addDaysISO(selectedWeekStart, 6);
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
    onProjectChange(prev => ({ ...prev, managementRoutine: { ...ensureRoutine(prev), ...patch } }));
  };

  const updateRole = (role: ManagementRoleAssignment['role'], patch: Partial<ManagementRoleAssignment>) => {
    updateRoutine({ roles: routine.roles.map(item => item.role === role ? { ...item, ...patch } : item) });
  };

  const updateChecklist = (id: string, patch: Partial<ManagementChecklistItem>) => {
    updateRoutine({
      weeklyChecklist: routine.weeklyChecklist.map(item => item.id === id ? { ...item, ...patch, updatedAt: nowISO() } : item),
    });
  };

  const updateWeeklyPlanItem = (task: Task, patch: Partial<ManagementWeeklyPlanItem>) => {
    const plannedQuantity = plannedQuantityForWeek(task, selectedWeekStart, selectedWeekEnd);
    const existing = routine.weeklyPlans?.find(item => item.taskId === task.id && item.weekStart === selectedWeekStart);
    const actualQuantity = patch.actualQuantity ?? existing?.actualQuantity ?? actualQuantityFromLogs(task, selectedWeekStart, selectedWeekEnd);
    const nextItem: ManagementWeeklyPlanItem = {
      id: existing?.id ?? uid('weekly-plan'),
      taskId: task.id,
      weekStart: selectedWeekStart,
      weekEnd: selectedWeekEnd,
      plannedQuantity,
      actualQuantity,
      teamCode: patch.teamCode ?? existing?.teamCode ?? task.team,
      responsible: patch.responsible ?? existing?.responsible ?? task.responsible,
      status: patch.status ?? existing?.status ?? deriveWeeklyStatus(plannedQuantity, actualQuantity),
      notes: patch.notes ?? existing?.notes,
      updatedAt: nowISO(),
    };
    const others = (routine.weeklyPlans ?? []).filter(item => !(item.taskId === task.id && item.weekStart === selectedWeekStart));
    updateRoutine({ weeklyPlans: [...others, nextItem] });
  };

  const updateTeam = (task: Task, value: string) => {
    const team = value ? value as TeamCode : undefined;
    onProjectChange(prev => {
      const nextProject = updateTaskTeam(prev, task.id, team);
      const nextRoutine = ensureRoutine(nextProject);
      const existing = nextRoutine.weeklyPlans?.find(item => item.taskId === task.id && item.weekStart === selectedWeekStart);
      const item: ManagementWeeklyPlanItem = {
        id: existing?.id ?? uid('weekly-plan'),
        taskId: task.id,
        weekStart: selectedWeekStart,
        weekEnd: selectedWeekEnd,
        plannedQuantity: plannedQuantityForWeek(task, selectedWeekStart, selectedWeekEnd),
        actualQuantity: existing?.actualQuantity ?? actualQuantityFromLogs(task, selectedWeekStart, selectedWeekEnd),
        teamCode: team,
        responsible: existing?.responsible ?? task.responsible,
        status: existing?.status ?? deriveWeeklyStatus(plannedQuantityForWeek(task, selectedWeekStart, selectedWeekEnd), existing?.actualQuantity ?? actualQuantityFromLogs(task, selectedWeekStart, selectedWeekEnd)),
        notes: existing?.notes,
        updatedAt: nowISO(),
      };
      const others = (nextRoutine.weeklyPlans ?? []).filter(plan => !(plan.taskId === task.id && plan.weekStart === selectedWeekStart));
      return { ...nextProject, managementRoutine: { ...nextRoutine, weeklyPlans: [...others, item] } };
    });
  };

  const weeklyRows = useMemo(() => {
    const hasApprovedAdditiveScope = additiveTaskIds.size > 0;
    return tasks
      .filter(task => !taskWasFullySuppressed(task))
      .filter(task => !hasApprovedAdditiveScope || additiveTaskIds.has(task.id))
      .map(task => {
        const start = task.current?.startDate ?? task.baseline?.startDate ?? task.startDate;
        const end = taskEndISO(task);
        const days = overlapDays(start, end, selectedWeekStart, selectedWeekEnd);
        if (days <= 0) return null;
        const saved = routine.weeklyPlans?.find(item => item.taskId === task.id && item.weekStart === selectedWeekStart);
        const plannedQuantity = saved?.plannedQuantity ?? plannedQuantityForWeek(task, selectedWeekStart, selectedWeekEnd);
        const actualQuantity = saved?.actualQuantity ?? actualQuantityFromLogs(task, selectedWeekStart, selectedWeekEnd);
        const status = saved?.status ?? deriveWeeklyStatus(plannedQuantity, actualQuantity);
        const chapter = mainChapterByTask.get(task.id) ?? { id: '__sem_capitulo__', name: 'Sem capitulo', order: Number.MAX_SAFE_INTEGER };
        return { task, start, end, days, saved, plannedQuantity, actualQuantity, status, chapter };
      })
      .filter(Boolean)
      .sort((a, b) => (
        a!.chapter.order - b!.chapter.order ||
        a!.chapter.name.localeCompare(b!.chapter.name) ||
        a!.start.localeCompare(b!.start) ||
        a!.task.name.localeCompare(b!.task.name)
      )) as Array<{
        task: Task;
        start: string;
        end: string;
        days: number;
        saved?: ManagementWeeklyPlanItem;
        plannedQuantity: number;
        actualQuantity: number;
        status: ManagementWeeklyTaskStatus;
        chapter: { id: string; name: string; order: number };
      }>;
  }, [additiveTaskIds, mainChapterByTask, routine.weeklyPlans, selectedWeekEnd, selectedWeekStart, tasks]);

  const groupedWeeklyRows = useMemo(() => {
    const groups: Array<{ chapter: { id: string; name: string; order: number }; rows: typeof weeklyRows }> = [];
    const byChapter = new Map<string, { chapter: { id: string; name: string; order: number }; rows: typeof weeklyRows }>();
    for (const row of weeklyRows) {
      const existing = byChapter.get(row.chapter.id);
      if (existing) {
        existing.rows.push(row);
      } else {
        const group = { chapter: row.chapter, rows: [row] };
        byChapter.set(row.chapter.id, group);
        groups.push(group);
      }
    }
    return groups;
  }, [weeklyRows]);

  const plannedTotal = weeklyRows.reduce((sum, row) => sum + row.plannedQuantity, 0);
  const actualTotal = weeklyRows.reduce((sum, row) => sum + row.actualQuantity, 0);
  const ppc = weeklyRows.length ? Math.round((weeklyRows.filter(row => row.status === 'cumprida').length / weeklyRows.length) * 100) : 0;
  const openActions = routine.meetings.flatMap(m => m.actions).filter(a => a.status === 'aberta' || a.status === 'em_andamento').length;
  const rolesFilled = routine.roles.filter(r => r.personName.trim()).length;

  const diagnostic = useMemo(() => {
    const checks = [
      { label: 'Cronograma / EAP', ok: tasks.length > 0 },
      { label: 'Contrato preenchido', ok: !!(project.contractInfo?.contractor || project.contractInfo?.contractNumber || project.contractInfo?.contractObject) },
      { label: 'Equipes cadastradas', ok: teams.length > 0 },
      { label: 'Orcamento importado', ok: (project.budgetItems?.length ?? 0) > 0 },
      { label: 'Diario iniciado', ok: (project.dailyReports?.length ?? 0) > 0 },
      { label: 'Plano semanal ativo', ok: weeklyRows.length > 0 },
    ];
    return Math.round((checks.filter(c => c.ok).length / checks.length) * 100);
  }, [project, tasks.length, teams.length, weeklyRows.length]);

  const addActionToDraft = () => {
    const title = actionDraft.title.trim();
    if (!title) return;
    setMeetingDraft(prev => ({ ...prev, actions: [...prev.actions, { ...actionDraft, id: uid('action'), title }] }));
    setActionDraft({ id: uid('action'), title: '', responsible: '', dueDate: '', status: 'aberta' });
  };

  const saveMeeting = () => {
    if (!meetingDraft.date) return;
    const saved: ManagementWeeklyMeeting = { ...meetingDraft, id: uid('meeting'), createdAt: nowISO(), updatedAt: nowISO() };
    updateRoutine({ meetings: [saved, ...routine.meetings].slice(0, 40) });
    setMeetingDraft({ id: uid('meeting'), date: todayISO(), participants: '', problems: '', decisions: '', nextPending: '', actions: [], createdAt: nowISO(), updatedAt: nowISO() });
  };

  const updateSavedAction = (meetingId: string, actionId: string, status: ManagementActionStatus) => {
    updateRoutine({
      meetings: routine.meetings.map(meeting => (
        meeting.id === meetingId
          ? { ...meeting, updatedAt: nowISO(), actions: meeting.actions.map(action => action.id === actionId ? { ...action, status } : action) }
          : meeting
      )),
    });
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-foreground">Rotina de Gestao</h2>
          <p className="mt-1 text-sm text-muted-foreground">{project.name}</p>
        </div>
        {undoButton}
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Plano semanal puxado do cronograma</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Semana de {formatDateBR(selectedWeekStart)} a {formatDateBR(selectedWeekEnd)}. As linhas abaixo mostram somente o recorte previsto para esta semana.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setSelectedWeekStart(addDaysISO(selectedWeekStart, -7))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Input className="h-9 w-[150px]" type="date" value={selectedWeekStart} onChange={e => setSelectedWeekStart(weekStartISO(e.target.value))} />
            <Button type="button" variant="outline" size="sm" onClick={() => setSelectedWeekStart(addDaysISO(selectedWeekStart, 7))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard label="Atividades da semana" value={weeklyRows.length} />
          <StatCard label="Previsto" value={plannedTotal.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} />
          <StatCard label="Executado" value={actualTotal.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} tone={actualTotal >= plannedTotal && plannedTotal > 0 ? 'success' : 'warning'} />
          <StatCard label="PPC" value={`${ppc}%`} tone={ppc >= 80 ? 'success' : ppc >= 50 ? 'warning' : 'danger'} />
          <StatCard label="Acoes abertas" value={openActions} tone={openActions > 0 ? 'warning' : 'success'} />
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1120px] text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="p-2">Atividade</th>
                <th className="p-2">Periodo</th>
                <th className="p-2">Equipe</th>
                <th className="p-2">Responsavel</th>
                <th className="p-2 text-right">Previsto</th>
                <th className="p-2 text-right">Executado</th>
                <th className="p-2 text-right">Saldo</th>
                <th className="p-2">Status</th>
                <th className="p-2">Observacao da reuniao</th>
              </tr>
            </thead>
            <tbody>
              {weeklyRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-sm text-muted-foreground">
                    Nao ha atividades do cronograma previstas para esta semana.
                  </td>
                </tr>
              )}
              {groupedWeeklyRows.map(group => (
                <Fragment key={group.chapter.id}>
                  <tr className="border-y border-border bg-muted/40">
                    <td colSpan={9} className="px-2 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-bold uppercase tracking-wide text-foreground">{group.chapter.name}</p>
                        <span className="text-[10px] font-semibold text-muted-foreground">{group.rows.length} composicao(oes)</span>
                      </div>
                    </td>
                  </tr>
                  {group.rows.map(row => {
                    const unit = row.task.unit || 'un';
                    const team = getTeamDefinition(row.saved?.teamCode ?? row.task.team, teams);
                    const balance = row.plannedQuantity - row.actualQuantity;
                    const weekTaskStart = row.start > selectedWeekStart ? row.start : selectedWeekStart;
                    const weekTaskEnd = row.end < selectedWeekEnd ? row.end : selectedWeekEnd;
                    return (
                      <tr key={row.task.id} className="border-b border-border/70 align-top">
                        <td className="p-2">
                          <p className="font-semibold text-foreground">{row.task.name}</p>
                          {row.task.frenteServico && <p className="text-[10px] text-muted-foreground">{row.task.frenteServico}</p>}
                        </td>
                        <td className="p-2 text-muted-foreground">
                          {formatDateBR(weekTaskStart)} a {formatDateBR(weekTaskEnd)}
                          <p className="text-[10px]">recorte semanal: {row.days} dia(s)</p>
                        </td>
                        <td className="p-2">
                          <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={row.saved?.teamCode ?? row.task.team ?? ''} onChange={e => updateTeam(row.task, e.target.value)}>
                            <option value="">Sem equipe</option>
                            {teams.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
                          </select>
                          {team?.composition && <p className="mt-1 text-[10px] text-muted-foreground">{team.composition}</p>}
                        </td>
                        <td className="p-2">
                          <Input className="h-8 text-xs" value={row.saved?.responsible ?? row.task.responsible ?? ''} onChange={e => updateWeeklyPlanItem(row.task, { responsible: e.target.value })} />
                        </td>
                        <td className="p-2 text-right font-semibold tabular-nums">
                          {row.plannedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {unit}
                        </td>
                        <td className="p-2">
                          <Input
                            className="h-8 text-right text-xs tabular-nums"
                            type="number"
                            min={0}
                            step={0.01}
                            value={row.actualQuantity}
                            onChange={e => updateWeeklyPlanItem(row.task, {
                              actualQuantity: Number(e.target.value),
                              status: deriveWeeklyStatus(row.plannedQuantity, Number(e.target.value)),
                            })}
                          />
                        </td>
                        <td className={`p-2 text-right font-semibold tabular-nums ${balance <= 0 ? 'text-success' : 'text-destructive'}`}>
                          {balance.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {unit}
                        </td>
                        <td className="p-2">
                          <select className={`h-8 w-full rounded-md border px-2 text-xs ${statusClass(row.status)}`} value={row.status} onChange={e => updateWeeklyPlanItem(row.task, { status: e.target.value as ManagementWeeklyTaskStatus })}>
                            {Object.entries(WEEKLY_TASK_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        </td>
                        <td className="p-2">
                          <Input className="h-8 text-xs" placeholder="Causa, decisao ou restricao" value={row.saved?.notes ?? ''} onChange={e => updateWeeklyPlanItem(row.task, { notes: e.target.value })} />
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="p-4 xl:col-span-2">
          <div className="flex items-center gap-2 mb-3">
            <CalendarCheck2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Configuracao da rotina</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input placeholder="Responsavel pela obra" value={routine.responsibleName ?? ''} onChange={e => updateRoutine({ responsibleName: e.target.value })} />
            <Input placeholder="Mestre / encarregado" value={routine.foremanName ?? ''} onChange={e => updateRoutine({ foremanName: e.target.value })} />
            <Input placeholder="Responsavel por compras" value={routine.buyerName ?? ''} onChange={e => updateRoutine({ buyerName: e.target.value })} />
            <Input placeholder="Responsavel por medicao" value={routine.measurementResponsibleName ?? ''} onChange={e => updateRoutine({ measurementResponsibleName: e.target.value })} />
            <Input placeholder="Responsavel pelo diario" value={routine.dailyReportResponsibleName ?? ''} onChange={e => updateRoutine({ dailyReportResponsibleName: e.target.value })} />
            <Input placeholder="Dia da reuniao semanal" value={routine.weeklyMeetingDay ?? ''} onChange={e => updateRoutine({ weeklyMeetingDay: e.target.value })} />
            <Input placeholder="Periodo padrao de medicao" value={routine.measurementPeriod ?? ''} onChange={e => updateRoutine({ measurementPeriod: e.target.value })} />
            <Input placeholder="Regra de aprovacao interna" value={routine.internalApprovalRule ?? ''} onChange={e => updateRoutine({ internalApprovalRule: e.target.value })} />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <ClipboardCheck className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Diagnostico</h3>
          </div>
          <StatCard label="Maturidade operacional" value={`${diagnostic}%`} tone={diagnostic >= 75 ? 'success' : diagnostic >= 45 ? 'warning' : 'danger'} />
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between rounded-md border border-border px-2.5 py-2 text-xs">
              <span>Plano semanal vinculado ao cronograma</span>
              {weeklyRows.length > 0 ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-warning" />}
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-2.5 py-2 text-xs">
              <span>Papeis preenchidos</span>
              <strong>{rolesFilled}/{routine.roles.length}</strong>
            </div>
          </div>
        </Card>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <ClipboardList className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Checklist de apoio</h3>
          </div>
          <div className="space-y-2">
            {routine.weeklyChecklist.map(item => (
              <div key={item.id} className="grid grid-cols-1 md:grid-cols-[1fr_150px_120px] gap-2 rounded-md border border-border p-2">
                <div>
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  <Input className="mt-1 h-8 text-xs" placeholder="Observacao" value={item.notes ?? ''} onChange={e => updateChecklist(item.id, { notes: e.target.value })} />
                </div>
                <select className="h-9 rounded-md border border-input bg-background px-2 text-xs" value={item.ownerRole ?? ''} onChange={e => updateChecklist(item.id, { ownerRole: e.target.value as ManagementRoleAssignment['role'] })}>
                  <option value="">Sem responsavel</option>
                  {routine.roles.map(role => <option key={role.role} value={role.role}>{ROLE_LABEL[role.role]}</option>)}
                </select>
                <select className="h-9 rounded-md border border-input bg-background px-2 text-xs" value={item.status} onChange={e => updateChecklist(item.id, { status: e.target.value as ManagementChecklistStatus })}>
                  {Object.entries(CHECK_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Papeis e responsabilidades</h3>
          </div>
          <div className="space-y-2">
            {routine.roles.map(role => (
              <div key={role.role} className="grid grid-cols-1 md:grid-cols-[150px_1fr_1fr] gap-2 rounded-md border border-border p-2">
                <div className="text-xs font-semibold text-foreground pt-2">{ROLE_LABEL[role.role]}</div>
                <Input className="h-8 text-xs" placeholder="Responsavel direto" value={role.personName} onChange={e => updateRole(role.role, { personName: e.target.value })} />
                <Input className="h-8 text-xs" placeholder="Quem aprova" value={role.approvalPersonName ?? ''} onChange={e => updateRole(role.role, { approvalPersonName: e.target.value })} />
              </div>
            ))}
          </div>
        </Card>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Plus className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Ata da reuniao semanal</h3>
          </div>
          <div className="space-y-3">
            <Input type="date" value={meetingDraft.date} onChange={e => setMeetingDraft(prev => ({ ...prev, date: e.target.value }))} />
            <Textarea placeholder="Participantes" value={meetingDraft.participants ?? ''} onChange={e => setMeetingDraft(prev => ({ ...prev, participants: e.target.value }))} />
            <Textarea placeholder="Principais problemas encontrados no plano semanal" value={meetingDraft.problems ?? ''} onChange={e => setMeetingDraft(prev => ({ ...prev, problems: e.target.value }))} />
            <Textarea placeholder="Decisoes tomadas" value={meetingDraft.decisions ?? ''} onChange={e => setMeetingDraft(prev => ({ ...prev, decisions: e.target.value }))} />
            <Textarea placeholder="Pendencias para a proxima reuniao" value={meetingDraft.nextPending ?? ''} onChange={e => setMeetingDraft(prev => ({ ...prev, nextPending: e.target.value }))} />

            <div className="rounded-md border border-border p-3 space-y-2">
              <p className="text-xs font-semibold text-foreground">Acoes da reuniao</p>
              <div className="grid grid-cols-1 md:grid-cols-[1fr_140px_140px_auto] gap-2">
                <Input className="h-8 text-xs" placeholder="Acao / decisao" value={actionDraft.title} onChange={e => setActionDraft(prev => ({ ...prev, title: e.target.value }))} />
                <Input className="h-8 text-xs" placeholder="Responsavel" value={actionDraft.responsible ?? ''} onChange={e => setActionDraft(prev => ({ ...prev, responsible: e.target.value }))} />
                <Input className="h-8 text-xs" type="date" value={actionDraft.dueDate ?? ''} onChange={e => setActionDraft(prev => ({ ...prev, dueDate: e.target.value }))} />
                <Button type="button" size="sm" variant="outline" onClick={addActionToDraft}><Plus className="h-3.5 w-3.5" /></Button>
              </div>
              {meetingDraft.actions.map(action => (
                <div key={action.id} className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-1 text-xs">
                  <span>{action.title}</span>
                  <span className="text-muted-foreground">{action.responsible || '-'} {action.dueDate ? `- ${formatDateBR(action.dueDate)}` : ''}</span>
                </div>
              ))}
            </div>

            <Button type="button" onClick={saveMeeting} className="w-full">
              <Save className="mr-2 h-4 w-4" />
              Salvar reuniao
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <CalendarCheck2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Historico e pendencias</h3>
          </div>
          <div className="space-y-3">
            {routine.meetings.length === 0 && (
              <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Nenhuma reuniao registrada ainda.
              </div>
            )}
            {routine.meetings.map(meeting => (
              <div key={meeting.id} className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">Reuniao de {formatDateBR(meeting.date)}</p>
                  <Badge variant="outline">{meeting.actions.length} acao(oes)</Badge>
                </div>
                {meeting.decisions && <p className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap">{meeting.decisions}</p>}
                <div className="mt-3 space-y-2">
                  {meeting.actions.map(action => (
                    <div key={action.id} className="grid grid-cols-1 md:grid-cols-[1fr_120px_140px] gap-2 rounded bg-muted/25 p-2 text-xs">
                      <div>
                        <p className="font-medium text-foreground">{action.title}</p>
                        <p className="text-muted-foreground">{action.responsible || 'Sem responsavel'} {action.dueDate ? `- ${formatDateBR(action.dueDate)}` : ''}</p>
                      </div>
                      <Badge variant="outline" className="w-fit">{ACTION_STATUS_LABEL[action.status]}</Badge>
                      <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={action.status} onChange={e => updateSavedAction(meeting.id, action.id, e.target.value as ManagementActionStatus)}>
                        {Object.entries(ACTION_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </section>
    </div>
  );
}
