import { useMemo, useState } from 'react';
import type {
  ManagementActionStatus,
  ManagementChecklistItem,
  ManagementChecklistStatus,
  ManagementMeetingAction,
  ManagementRoleAssignment,
  ManagementRoutine as ManagementRoutineData,
  ManagementWeeklyMeeting,
  Project,
} from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
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
    roles: DEFAULT_ROLES.map(role => ({
      ...role,
      ...(existing?.roles ?? []).find(saved => saved.role === role.role),
    })),
    weeklyChecklist: DEFAULT_CHECKLIST.map(item => ({
      ...item,
      ...(existing?.weeklyChecklist ?? []).find(saved => saved.id === item.id),
    })),
    meetings: existing?.meetings ?? [],
  };
}

function formatDateBR(value?: string) {
  if (!value) return '-';
  const [year, month, day] = value.slice(0, 10).split('-');
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}

function StatusPill({ status }: { status: ManagementChecklistStatus }) {
  const cls =
    status === 'feito' ? 'bg-success/10 text-success border-success/30' :
    status === 'nao_aplicavel' ? 'bg-muted text-muted-foreground border-border' :
    'bg-warning/10 text-warning border-warning/30';
  return <Badge variant="outline" className={cls}>{CHECK_STATUS_LABEL[status]}</Badge>;
}

function MiniStat({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'success' | 'warning' | 'danger' }) {
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

export default function ManagementRoutine({ project, onProjectChange, undoButton }: Props) {
  const routine = useMemo(() => ensureRoutine(project), [project]);
  const tasks = useMemo(() => getAllTasks(project), [project]);
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

  const checklistDone = routine.weeklyChecklist.filter(item => item.status === 'feito' || item.status === 'nao_aplicavel').length;
  const checklistTotal = routine.weeklyChecklist.length || 1;
  const checklistPct = Math.round((checklistDone / checklistTotal) * 100);
  const openActions = routine.meetings.flatMap(m => m.actions).filter(a => a.status === 'aberta' || a.status === 'em_andamento').length;
  const rolesFilled = routine.roles.filter(r => r.personName.trim()).length;

  const diagnostic = useMemo(() => {
    const checks = [
      { label: 'Cronograma / EAP', ok: tasks.length > 0 },
      { label: 'Contrato preenchido', ok: !!(project.contractInfo?.contractor || project.contractInfo?.contractNumber || project.contractInfo?.contractObject) },
      { label: 'Equipes cadastradas', ok: (project.teams?.length ?? 0) > 0 },
      { label: 'Orcamento importado', ok: (project.budgetItems?.length ?? 0) > 0 },
      { label: 'Materiais / compras', ok: (project.materialComparisons?.length ?? 0) > 0 || (project.analyticCompositions?.length ?? 0) > 0 },
      { label: 'Diario iniciado', ok: (project.dailyReports?.length ?? 0) > 0 },
      { label: 'Medicao configurada', ok: (project.measurements?.length ?? 0) > 0 || !!project.measurementDraft },
      { label: 'Almoxarifado ativo', ok: !!project.warehouse },
    ];
    const score = Math.round((checks.filter(c => c.ok).length / checks.length) * 100);
    const level = score >= 75 ? 'bom' : score >= 45 ? 'medio' : 'baixo';
    return { checks, score, level };
  }, [project, tasks.length]);

  const updateRoutine = (patch: Partial<ManagementRoutineData>) => {
    onProjectChange(prev => ({
      ...prev,
      managementRoutine: {
        ...ensureRoutine(prev),
        ...patch,
      },
    }));
  };

  const updateRole = (role: ManagementRoleAssignment['role'], patch: Partial<ManagementRoleAssignment>) => {
    updateRoutine({
      roles: routine.roles.map(item => item.role === role ? { ...item, ...patch } : item),
    });
  };

  const updateChecklist = (id: string, patch: Partial<ManagementChecklistItem>) => {
    updateRoutine({
      weeklyChecklist: routine.weeklyChecklist.map(item => (
        item.id === id ? { ...item, ...patch, updatedAt: nowISO() } : item
      )),
    });
  };

  const addActionToDraft = () => {
    const title = actionDraft.title.trim();
    if (!title) return;
    setMeetingDraft(prev => ({
      ...prev,
      actions: [...prev.actions, { ...actionDraft, id: uid('action'), title }],
    }));
    setActionDraft({ id: uid('action'), title: '', responsible: '', dueDate: '', status: 'aberta' });
  };

  const saveMeeting = () => {
    if (!meetingDraft.date) return;
    const saved: ManagementWeeklyMeeting = {
      ...meetingDraft,
      id: uid('meeting'),
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    updateRoutine({ meetings: [saved, ...routine.meetings].slice(0, 40) });
    setMeetingDraft({
      id: uid('meeting'),
      date: todayISO(),
      participants: '',
      problems: '',
      decisions: '',
      nextPending: '',
      actions: [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
  };

  const updateSavedAction = (meetingId: string, actionId: string, status: ManagementActionStatus) => {
    updateRoutine({
      meetings: routine.meetings.map(meeting => (
        meeting.id === meetingId
          ? {
              ...meeting,
              updatedAt: nowISO(),
              actions: meeting.actions.map(action => action.id === actionId ? { ...action, status } : action),
            }
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

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <MiniStat label="Checklist semanal" value={`${checklistPct}%`} tone={checklistPct >= 80 ? 'success' : checklistPct >= 50 ? 'warning' : 'danger'} />
        <MiniStat label="Papeis preenchidos" value={`${rolesFilled}/${routine.roles.length}`} tone={rolesFilled === routine.roles.length ? 'success' : 'warning'} />
        <MiniStat label="Acoes abertas" value={openActions} tone={openActions > 0 ? 'warning' : 'success'} />
        <MiniStat label="Diagnostico" value={`${diagnostic.score}%`} tone={diagnostic.level === 'bom' ? 'success' : diagnostic.level === 'medio' ? 'warning' : 'danger'} />
        <MiniStat label="Reunioes" value={routine.meetings.length} />
      </div>

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
            <h3 className="text-sm font-semibold">Diagnostico inicial</h3>
          </div>
          <div className="space-y-2">
            {diagnostic.checks.map(check => (
              <div key={check.label} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2">
                <span className="text-xs text-foreground">{check.label}</span>
                {check.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-warning" />}
              </div>
            ))}
          </div>
        </Card>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <ClipboardList className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Checklist semanal</h3>
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
                <div className="md:col-start-3"><StatusPill status={item.status} /></div>
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
            <h3 className="text-sm font-semibold">Registrar reuniao semanal</h3>
          </div>
          <div className="space-y-3">
            <Input type="date" value={meetingDraft.date} onChange={e => setMeetingDraft(prev => ({ ...prev, date: e.target.value }))} />
            <Textarea placeholder="Participantes" value={meetingDraft.participants ?? ''} onChange={e => setMeetingDraft(prev => ({ ...prev, participants: e.target.value }))} />
            <Textarea placeholder="Principais problemas" value={meetingDraft.problems ?? ''} onChange={e => setMeetingDraft(prev => ({ ...prev, problems: e.target.value }))} />
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
