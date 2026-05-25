import type {
  LaborAvailability,
  LaborComposition,
  LaborDimensioningSettings,
  LaborNormalizationRule,
  LaborNormalizationType,
  OperationalRole,
  Project,
  Task,
} from '@/types/project';
import type { TeamDefinition } from '@/lib/teams';
import { DEFAULT_TEAMS } from '@/lib/teams';

const DEFAULT_DAILY_HOURS = 8;

export const DEFAULT_OPERATIONAL_ROLES: OperationalRole[] = [
  { id: 'encarregado', name: 'Encarregado', category: 'gestao', defaultDailyHours: 8, active: true },
  { id: 'engenheiro', name: 'Engenheiro', category: 'tecnica', defaultDailyHours: 8, active: true },
  { id: 'tecnico-seguranca', name: 'Técnico de Segurança', category: 'tecnica', defaultDailyHours: 8, active: true },
  { id: 'almoxarife', name: 'Almoxarife', category: 'apoio', defaultDailyHours: 8, active: true },
  { id: 'vigia', name: 'Vigia', category: 'apoio', defaultDailyHours: 8, active: true },
  { id: 'eletricista', name: 'Eletricista', category: 'operacional', defaultDailyHours: 8, active: true },
  { id: 'auxiliar-eletricista', name: 'Auxiliar de Eletricista', category: 'operacional', defaultDailyHours: 8, active: true },
  { id: 'encanador', name: 'Encanador', category: 'operacional', defaultDailyHours: 8, active: true },
  { id: 'pedreiro', name: 'Pedreiro', category: 'operacional', defaultDailyHours: 8, active: true },
  { id: 'pintor', name: 'Pintor', category: 'operacional', defaultDailyHours: 8, active: true },
  { id: 'soldador-serralheiro', name: 'Soldador/Serralheiro', category: 'operacional', defaultDailyHours: 8, active: true },
  { id: 'gesseiro-drywall', name: 'Gesseiro / Drywall', category: 'operacional', defaultDailyHours: 8, active: true },
  { id: 'vidraceiro', name: 'Vidraceiro', category: 'operacional', defaultDailyHours: 8, active: true },
  { id: 'ajudante-servente', name: 'Ajudante/Servente', category: 'operacional', defaultDailyHours: 8, active: true },
  { id: 'operador-equipamento', name: 'Operador de Equipamento', category: 'operacional', defaultDailyHours: 8, active: true },
];

export const DEFAULT_DIMENSIONING_SETTINGS: LaborDimensioningSettings = {
  defaultDailyHours: 8,
  workSaturday: false,
  workSunday: false,
  overloadTolerancePercent: 10,
  roundingMode: 'ceil',
  mode: 'duration_by_team',
};

export interface LaborDemandLine {
  id: string;
  taskId: string;
  taskName: string;
  phaseId: string;
  phaseName: string;
  startDate: string;
  endDate: string;
  taskQuantity: number;
  taskUnit?: string;
  originalRole: string;
  normalizedRoleId?: string;
  normalizedRoleName?: string;
  normalizationType: LaborNormalizationType;
  automaticRuleApplied?: string;
  rup: number;
  workerCount: number;
  hours: number;
  source: 'task_rup';
}

export interface RoleDemandSummary {
  roleId: string;
  roleName: string;
  hours: number;
  calculatedPeople: number;
  recommendedPeople: number;
  availablePeople: number;
  balancePeople: number;
  status: 'ok' | 'deficit' | 'surplus' | 'empty';
}

export interface PeriodRoleDemand {
  period: string;
  roleId: string;
  roleName: string;
  hours: number;
  neededPeople: number;
  recommendedPeople: number;
  availablePeople: number;
  balancePeople: number;
}

export interface TeamCompatibility {
  taskId: string;
  taskName: string;
  phaseId: string;
  phaseName: string;
  startDate: string;
  endDate: string;
  totalHours: number;
  teamName?: string;
  missingRoles: string[];
  requiredRoles: string[];
  compatible: boolean;
  reason: 'ok' | 'sem_equipe' | 'faltando_cargo';
}

export interface PhaseDemandSummary {
  phaseId: string;
  phaseName: string;
  hours: number;
  taskCount: number;
  recommendedPeople: number;
  mainRoles: string[];
}

export interface TaskDimensioningSummary {
  taskId: string;
  taskName: string;
  phaseId: string;
  phaseName: string;
  startDate: string;
  endDate: string;
  totalHours: number;
  requiredRoles: string[];
  teamName?: string;
  missingRoles: string[];
  status: 'ok' | 'sem_equipe' | 'incompativel';
}

export interface LaborProjection {
  lines: LaborDemandLine[];
  summaries: RoleDemandSummary[];
  periodRows: PeriodRoleDemand[];
  phaseSummaries: PhaseDemandSummary[];
  taskSummaries: TaskDimensioningSummary[];
  totalHours: number;
  peakPeriod: string;
  peakPeople: number;
  deficitRoles: number;
  accessoryCount: number;
  reviewCount: number;
  compatibility: TeamCompatibility[];
}

export type LaborPlanningGranularity = 'day' | 'week' | 'month';

export interface LaborPeriodActivity {
  taskId: string;
  taskName: string;
  phaseId: string;
  phaseName: string;
  startDate: string;
  endDate: string;
  teamCode?: string;
  teamName?: string;
  hours: number;
  neededPeople: number;
}

export type LaborPeriodStatus = 'ok' | 'deficit' | 'surplus' | 'missing_availability';

export interface LaborPeriodRolePlan {
  periodKey: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  roleId: string;
  roleName: string;
  hours: number;
  neededPeople: number;
  recommendedPeople: number;
  availablePeople: number;
  availabilityConfigured: boolean;
  balancePeople: number;
  status: LaborPeriodStatus;
  activities: LaborPeriodActivity[];
}

export interface LaborTeamConflict {
  periodKey: string;
  periodLabel: string;
  teamCode: string;
  teamName: string;
  tasks: Array<{
    taskId: string;
    taskName: string;
    phaseId: string;
    phaseName: string;
    startDate: string;
    endDate: string;
  }>;
}

export interface LaborTaskConflictInfo {
  roleDeficits: string[];
  teamConflicts: string[];
  missingAvailability: string[];
}

export interface LaborReprogrammingSuggestion {
  taskId: string;
  taskName: string;
  reason: string;
  suggestedStartDate: string;
  impactNote: string;
}

export interface LaborDataIssue {
  taskId: string;
  taskName: string;
  phaseId: string;
  phaseName: string;
  issue: 'sem_rup' | 'sem_quantidade' | 'revisar_normalizacao';
  message: string;
}

export interface LaborPlanningAnalysis {
  granularity: LaborPlanningGranularity;
  rows: LaborPeriodRolePlan[];
  deficitRows: LaborPeriodRolePlan[];
  surplusRows: LaborPeriodRolePlan[];
  missingAvailabilityRows: LaborPeriodRolePlan[];
  dataIssues: LaborDataIssue[];
  teamConflicts: LaborTeamConflict[];
  taskConflictMap: Record<string, LaborTaskConflictInfo>;
  peakPeople: number;
  peakPeriod: string;
  totalDeficitPeriods: number;
  totalSurplusPeriods: number;
  totalMissingAvailabilityPeriods: number;
  suggestions: LaborReprogrammingSuggestion[];
}

function norm(value: string | undefined) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function hasAny(text: string, words: string[]) {
  return words.some(word => text.includes(word));
}

function roleById(roles: OperationalRole[], id?: string) {
  return roles.find(role => role.id === id);
}

function roleByName(roles: OperationalRole[], name: string) {
  const target = norm(name);
  return roles.find(role => norm(role.name) === target);
}

export function getOperationalRoles(project: Project): OperationalRole[] {
  const custom = project.operationalRoles ?? [];
  const merged = new Map<string, OperationalRole>();
  DEFAULT_OPERATIONAL_ROLES.forEach(role => merged.set(role.id, role));
  custom.forEach(role => merged.set(role.id, role));
  return Array.from(merged.values()).filter(role => role.active !== false);
}

export function getDimensioningSettings(project: Project): LaborDimensioningSettings {
  return { ...DEFAULT_DIMENSIONING_SETTINGS, ...(project.laborDimensioningSettings ?? {}) };
}

export function getLaborAvailability(project: Project): LaborAvailability[] {
  const roles = getOperationalRoles(project);
  const existing = project.laborAvailability ?? [];
  return roles.map(role => {
    const found = existing.find(row => row.operationalRoleId === role.id);
    return found ?? {
      id: `avail-${role.id}`,
      operationalRoleId: role.id,
      quantity: 0,
      dailyHours: role.defaultDailyHours || DEFAULT_DAILY_HOURS,
    };
  });
}

function manualRuleFor(project: Project, originalRole: string): LaborNormalizationRule | undefined {
  const key = norm(originalRole);
  return (project.laborNormalizationRules ?? []).find(rule =>
    rule.active !== false &&
    norm(rule.originalName) === key &&
    (rule.manuallyReviewed || rule.applyToSimilar)
  );
}

export function normalizeLaborRole(
  project: Project,
  input: { originalRole: string; parentComposition?: string; unit?: string; code?: string; bank?: string },
): {
  type: LaborNormalizationType;
  roleId?: string;
  roleName?: string;
  automaticRuleApplied?: string;
} {
  const roles = getOperationalRoles(project);
  const manual = manualRuleFor(project, input.originalRole);
  if (manual) {
    const role = roleById(roles, manual.operationalRoleId);
    return {
      type: manual.normalizationType,
      roleId: manual.operationalRoleId,
      roleName: role?.name,
      automaticRuleApplied: 'Correção manual',
    };
  }

  const desc = norm(input.originalRole);
  const context = norm(`${input.parentComposition ?? ''} ${input.unit ?? ''}`);
  const accessoryWords = [
    'curso de capacitacao',
    'capacitacao',
    'epi',
    'ferramenta',
    'ferramentas',
    'exame',
    'exames',
    'seguro',
    'encargos complementares -',
    'familia eletricista',
    'familia encanador',
    'familia pedreiro',
    'familia servente',
    'familia pintor',
    'familia gesseiro',
    'familia almoxarife',
    'familia encarregado',
  ];
  if (hasAny(desc, accessoryWords) && !desc.includes(' com encargos complementares')) {
    return { type: 'custo_acessorio', automaticRuleApplied: 'Custo acessório' };
  }

  const drywallContext = ['drywall', 'gesso', 'gesso acartonado', 'chapa de gesso', 'parede rf', 'forro de gesso', 'montante', 'guia metalica', 'perfil de aco zincado'];
  if (desc.includes('montador de estruturas metalicas')) {
    if (hasAny(context, drywallContext)) {
      const role = roleByName(roles, 'Gesseiro / Drywall');
      return { type: 'cargo_operacional', roleId: role?.id, roleName: role?.name, automaticRuleApplied: 'Montador em contexto drywall/gesso' };
    }
    const metalContext = ['estrutura metalica', 'solda', 'serralheria', 'gradil', 'portao', 'guarda-corpo', 'escada metalica', 'cobertura metalica', 'suporte metalico'];
    if (hasAny(context, metalContext)) {
      const role = roleByName(roles, 'Soldador/Serralheiro');
      return { type: 'cargo_operacional', roleId: role?.id, roleName: role?.name, automaticRuleApplied: 'Montador em contexto metálico' };
    }
    return { type: 'revisar_manualmente', automaticRuleApplied: 'Montador sem contexto suficiente' };
  }

  const rules: Array<{ id: string; label: string; words: string[] }> = [
    { id: 'auxiliar-eletricista', label: 'Auxiliar de Eletricista', words: ['auxiliar de eletricista'] },
    { id: 'eletricista', label: 'Eletricista', words: ['eletricista', 'eletricista horista'] },
    { id: 'encanador', label: 'Encanador', words: ['encanador', 'bombeiro hidraulico', 'mecanico de refrigeracao'] },
    { id: 'pedreiro', label: 'Pedreiro', words: ['pedreiro'] },
    { id: 'pintor', label: 'Pintor', words: ['pintor'] },
    { id: 'soldador-serralheiro', label: 'Soldador/Serralheiro', words: ['soldador', 'serralheiro'] },
    { id: 'gesseiro-drywall', label: 'Gesseiro / Drywall', words: ['gesseiro', 'drywall'] },
    { id: 'vidraceiro', label: 'Vidraceiro', words: ['vidraceiro'] },
    { id: 'encarregado', label: 'Encarregado', words: ['encarregado', 'mestre de obras'] },
    { id: 'engenheiro', label: 'Engenheiro', words: ['engenheiro civil', 'engenheiro eletricista'] },
    { id: 'tecnico-seguranca', label: 'Técnico de Segurança', words: ['tecnico em seguranca do trabalho'] },
    { id: 'almoxarife', label: 'Almoxarife', words: ['almoxarife'] },
    { id: 'vigia', label: 'Vigia', words: ['vigia'] },
    { id: 'operador-equipamento', label: 'Operador de Equipamento', words: ['operador de equipamento', 'operador de guindaste', 'operador de munck', 'operador de plataforma'] },
    { id: 'ajudante-servente', label: 'Ajudante/Servente', words: ['servente', 'ajudante', 'auxiliar de encanador', 'auxiliar de bombeiro hidraulico', 'ajudante de operacao', 'ajudante de carpinteiro'] },
  ];

  for (const rule of rules) {
    if (hasAny(desc, rule.words)) {
      const role = roleById(roles, rule.id);
      return { type: 'cargo_operacional', roleId: role?.id, roleName: role?.name ?? rule.label, automaticRuleApplied: rule.label };
    }
  }

  return { type: 'revisar_manualmente', automaticRuleApplied: 'Sem regra confiável' };
}

function addDaysISO(dateISO: string, days: number) {
  const date = new Date(`${dateISO}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateISO;
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseLocalDate(dateISO: string) {
  const [year, month, day] = dateISO.split('-').map(Number);
  if (!year || !month || !day) return new Date(`${dateISO}T00:00:00`);
  return new Date(year, month - 1, day);
}

function formatISODate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addCalendarDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isWorkingDate(date: Date, settings: LaborDimensioningSettings) {
  const dow = date.getDay();
  if (dow >= 1 && dow <= 5) return true;
  if (dow === 6) return settings.workSaturday;
  if (dow === 0) return settings.workSunday;
  return false;
}

function workingDatesBetween(startISO: string, endISO: string, settings: LaborDimensioningSettings) {
  const start = parseLocalDate(startISO);
  const end = parseLocalDate(endISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const first = start <= end ? start : end;
  const last = start <= end ? end : start;
  const dates: string[] = [];
  for (let cursor = new Date(first); cursor <= last; cursor = addCalendarDays(cursor, 1)) {
    if (isWorkingDate(cursor, settings)) dates.push(formatISODate(cursor));
  }
  if (dates.length === 0) dates.push(formatISODate(first));
  return dates;
}

function periodFor(dateISO: string, granularity: LaborPlanningGranularity) {
  const date = parseLocalDate(dateISO);
  if (Number.isNaN(date.getTime())) {
    return { key: dateISO, label: dateISO, start: dateISO, end: dateISO };
  }

  if (granularity === 'day') {
    return {
      key: dateISO,
      label: date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }),
      start: dateISO,
      end: dateISO,
    };
  }

  if (granularity === 'month') {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      label: date.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', ''),
      start: formatISODate(start),
      end: formatISODate(end),
    };
  }

  const monday = addCalendarDays(date, -((date.getDay() + 6) % 7));
  const sunday = addCalendarDays(monday, 6);
  return {
    key: formatISODate(monday),
    label: `${monday.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} a ${sunday.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`,
    start: formatISODate(monday),
    end: formatISODate(sunday),
  };
}

function taskEndDate(task: Task) {
  if (task.current?.forecastEndDate) return task.current.forecastEndDate;
  if (task.forecastEndDate) return task.forecastEndDate;
  if (task.current?.endDate) return task.current.endDate;
  if (task.baseline?.endDate) return task.baseline.endDate;
  return addDaysISO(task.startDate, Math.max(0, (task.duration || 1) - 1));
}

function monthKey(dateISO: string) {
  const date = new Date(`${dateISO}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 'Sem data';
  return date.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');
}

function monthsBetween(startISO: string, endISO: string) {
  const start = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [monthKey(startISO)];
  const out: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor <= last) {
    out.push(cursor.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', ''));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}

function workingDaysInMonth(period: string, settings: LaborDimensioningSettings) {
  const [monthText, yearText] = period.split(' de ');
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const month = months.findIndex(m => monthText.startsWith(m));
  const year = 2000 + Number(yearText || 0);
  if (month < 0 || !Number.isFinite(year)) return 22;
  const last = new Date(year, month + 1, 0).getDate();
  let days = 0;
  for (let day = 1; day <= last; day++) {
    const dow = new Date(year, month, day).getDay();
    if (dow >= 1 && dow <= 5) days += 1;
    else if (dow === 6 && settings.workSaturday) days += 0.5;
    else if (dow === 0 && settings.workSunday) days += 1;
  }
  return Math.max(1, days);
}

export function buildLaborDemand(project: Project): LaborDemandLine[] {
  const lines: LaborDemandLine[] = [];
  project.phases.forEach(phase => {
    phase.tasks.forEach(task => {
      (task.laborCompositions ?? []).forEach((comp: LaborComposition) => {
        const rup = Number(comp.rup || 0);
        const qty = Number(task.quantity || 0);
        if (!Number.isFinite(rup) || rup <= 0 || !Number.isFinite(qty) || qty <= 0) return;
        const normalized = normalizeLaborRole(project, {
          originalRole: comp.originalRole || comp.role,
          parentComposition: task.name,
          unit: task.unit,
        });
        const hours = qty * rup;
        lines.push({
          id: `${task.id}-${comp.id}`,
          taskId: task.id,
          taskName: task.name,
          phaseId: phase.id,
          phaseName: phase.name,
          startDate: task.startDate,
          endDate: taskEndDate(task),
          taskQuantity: qty,
          taskUnit: task.unit,
          originalRole: comp.originalRole || comp.role,
          normalizedRoleId: normalized.roleId,
          normalizedRoleName: normalized.roleName,
          normalizationType: normalized.type,
          automaticRuleApplied: normalized.automaticRuleApplied,
          rup,
          workerCount: comp.workerCount || 1,
          hours,
          source: 'task_rup',
        });
      });
    });
  });
  return lines;
}

function inferTeamMembers(team: TeamDefinition, project: Project): Array<{ operationalRoleId: string; quantity: number; dailyHours?: number }> {
  if (team.members?.length) return team.members;
  const text = norm(`${team.label} ${team.composition}`);
  const roles = getOperationalRoles(project);
  const names = roles
    .map(role => ({ role, text: norm(role.name) }))
    .filter(({ text: roleText }) => text.includes(roleText) || roleText.split('/').some(piece => piece && text.includes(piece)));
  if (!names.length && text.includes('ajudante')) {
    return [{ operationalRoleId: 'ajudante-servente', quantity: 1, dailyHours: team.dailyHours }];
  }
  return names.map(({ role }) => ({ operationalRoleId: role.id, quantity: 1, dailyHours: team.dailyHours }));
}

function taskMap(project: Project) {
  const map = new Map<string, { phaseId: string; phaseName: string; task: Task }>();
  project.phases.forEach(phase => {
    phase.tasks.forEach(task => map.set(task.id, { phaseId: phase.id, phaseName: phase.name, task }));
  });
  return map;
}

function bumpTaskConflict(
  target: Record<string, LaborTaskConflictInfo>,
  taskId: string,
  patch: Partial<LaborTaskConflictInfo>,
) {
  const current = target[taskId] ?? { roleDeficits: [], teamConflicts: [], missingAvailability: [] };
  target[taskId] = {
    roleDeficits: Array.from(new Set([...(current.roleDeficits ?? []), ...(patch.roleDeficits ?? [])])),
    teamConflicts: Array.from(new Set([...(current.teamConflicts ?? []), ...(patch.teamConflicts ?? [])])),
    missingAvailability: Array.from(new Set([...(current.missingAvailability ?? []), ...(patch.missingAvailability ?? [])])),
  };
}

export function buildLaborPlanningAnalysis(
  project: Project,
  granularity: LaborPlanningGranularity = 'week',
): LaborPlanningAnalysis {
  const roles = getOperationalRoles(project);
  const settings = getDimensioningSettings(project);
  const availability = getLaborAvailability(project);
  const availabilityConfigured = new Set((project.laborAvailability ?? []).map(item => item.operationalRoleId));
  const teams = project.teams ?? DEFAULT_TEAMS;
  const taskLookup = taskMap(project);
  const allDemandLines = buildLaborDemand(project);
  const demandLines = allDemandLines
    .filter(line => line.normalizationType === 'cargo_operacional' && line.normalizedRoleId);

  const dataIssues: LaborDataIssue[] = [];
  project.phases.forEach(phase => {
    phase.tasks.forEach(task => {
      const qty = Number(task.quantity || 0);
      const labor = task.laborCompositions ?? [];
      if (qty <= 0) return;
      if (!labor.length) {
        dataIssues.push({
          taskId: task.id,
          taskName: task.name,
          phaseId: phase.id,
          phaseName: phase.name,
          issue: 'sem_rup',
          message: 'Sem composicao/RUP de mao de obra vinculada.',
        });
        return;
      }
      const taskLines = allDemandLines.filter(line => line.taskId === task.id);
      if (taskLines.length === 0) {
        dataIssues.push({
          taskId: task.id,
          taskName: task.name,
          phaseId: phase.id,
          phaseName: phase.name,
          issue: 'sem_quantidade',
          message: 'Composicao existe, mas quantidade ou RUP esta zerado.',
        });
        return;
      }
      if (!taskLines.some(line => line.normalizationType === 'cargo_operacional' && line.normalizedRoleId)) {
        dataIssues.push({
          taskId: task.id,
          taskName: task.name,
          phaseId: phase.id,
          phaseName: phase.name,
          issue: 'revisar_normalizacao',
          message: 'Mao de obra ainda nao virou cargo operacional confiavel.',
        });
      }
    });
  });

  const periodRows = new Map<string, LaborPeriodRolePlan & { dayKeys: Set<string> }>();
  const taskDays = new Map<string, Set<string>>();
  const teamByDay = new Map<string, Map<string, Array<{ phaseId: string; phaseName: string; task: Task }>>>();

  for (const line of demandLines) {
    const taskInfo = taskLookup.get(line.taskId);
    const task = taskInfo?.task;
    const team = task?.team ? teams.find(t => t.code === task.team) : undefined;
    const roleId = line.normalizedRoleId!;
    const role = roleById(roles, roleId);
    const workDays = workingDatesBetween(line.startDate, line.endDate, settings);
    const dailyHours = line.hours / Math.max(1, workDays.length);

    for (const dayISO of workDays) {
      const period = periodFor(dayISO, granularity);
      const rowKey = `${period.key}|${roleId}`;
      const row = periodRows.get(rowKey) ?? {
        periodKey: period.key,
        periodLabel: period.label,
        periodStart: period.start,
        periodEnd: period.end,
        roleId,
        roleName: role?.name ?? line.normalizedRoleName ?? roleId,
        hours: 0,
        neededPeople: 0,
        recommendedPeople: 0,
        availablePeople: 0,
        availabilityConfigured: false,
        balancePeople: 0,
        status: 'ok' as const,
        activities: [],
        dayKeys: new Set<string>(),
      };
      row.hours += dailyHours;
      row.dayKeys.add(dayISO);
      const existing = row.activities.find(activity => activity.taskId === line.taskId);
      const activityHours = dailyHours;
      const availabilityRow = availability.find(item => item.operationalRoleId === roleId);
      const roleDailyHours = availabilityRow?.dailyHours || role?.defaultDailyHours || settings.defaultDailyHours || DEFAULT_DAILY_HOURS;
      if (existing) {
        existing.hours += activityHours;
        existing.neededPeople += activityHours / roleDailyHours;
      } else {
        row.activities.push({
          taskId: line.taskId,
          taskName: line.taskName,
          phaseId: line.phaseId,
          phaseName: line.phaseName,
          startDate: line.startDate,
          endDate: line.endDate,
          teamCode: task?.team,
          teamName: team?.label,
          hours: activityHours,
          neededPeople: activityHours / roleDailyHours,
        });
      }
      periodRows.set(rowKey, row);
    }

    if (task) {
      const days = taskDays.get(task.id) ?? new Set<string>();
      workDays.forEach(day => days.add(day));
      taskDays.set(task.id, days);
    }
  }

  project.phases.forEach(phase => {
    phase.tasks.forEach(task => {
      if (!task.team) return;
      const days = taskDays.get(task.id) ?? new Set(workingDatesBetween(task.startDate, taskEndDate(task), settings));
      for (const dayISO of days) {
        const dayMap = teamByDay.get(dayISO) ?? new Map<string, Array<{ phaseId: string; phaseName: string; task: Task }>>();
        const list = dayMap.get(task.team) ?? [];
        list.push({ phaseId: phase.id, phaseName: phase.name, task });
        dayMap.set(task.team, list);
        teamByDay.set(dayISO, dayMap);
      }
    });
  });

  const rows: LaborPeriodRolePlan[] = Array.from(periodRows.values()).map(row => {
    const role = roleById(roles, row.roleId);
    const avail = availability.find(item => item.operationalRoleId === row.roleId);
    const dailyHours = avail?.dailyHours || role?.defaultDailyHours || settings.defaultDailyHours || DEFAULT_DAILY_HOURS;
    const availablePeople = avail?.quantity ?? 0;
    const configured = availabilityConfigured.has(row.roleId);
    const neededPeople = row.hours / (Math.max(1, row.dayKeys.size) * dailyHours);
    const recommendedPeople = row.hours > 0 ? Math.ceil(neededPeople) : 0;
    const balancePeople = availablePeople - recommendedPeople;
    const status: LaborPeriodStatus =
      row.hours > 0 && !configured
        ? 'missing_availability'
        : balancePeople < 0
          ? 'deficit'
          : balancePeople > 0 && recommendedPeople > 0
            ? 'surplus'
            : 'ok';
    return {
      periodKey: row.periodKey,
      periodLabel: row.periodLabel,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      roleId: row.roleId,
      roleName: row.roleName,
      hours: row.hours,
      neededPeople,
      recommendedPeople,
      availablePeople,
      availabilityConfigured: configured,
      balancePeople,
      status,
      activities: row.activities
        .sort((a, b) => b.hours - a.hours)
        .map(activity => ({ ...activity, neededPeople: Number(activity.neededPeople.toFixed(2)) })),
    };
  }).sort((a, b) => a.periodStart.localeCompare(b.periodStart) || b.hours - a.hours);

  const teamConflictsByPeriod = new Map<string, LaborTeamConflict>();
  for (const [dayISO, dayMap] of teamByDay) {
    for (const [teamCode, allocations] of dayMap) {
      const uniqueTasks = Array.from(new Map(allocations.map(item => [item.task.id, item])).values());
      if (uniqueTasks.length <= 1) continue;
      const period = periodFor(dayISO, granularity);
      const team = teams.find(t => t.code === teamCode);
      const key = `${period.key}|${teamCode}`;
      const current = teamConflictsByPeriod.get(key) ?? {
        periodKey: period.key,
        periodLabel: period.label,
        teamCode,
        teamName: team?.label ?? teamCode,
        tasks: [],
      };
      const taskById = new Map(current.tasks.map(task => [task.taskId, task]));
      uniqueTasks.forEach(({ phaseId, phaseName, task }) => {
        taskById.set(task.id, {
          taskId: task.id,
          taskName: task.name,
          phaseId,
          phaseName,
          startDate: task.startDate,
          endDate: taskEndDate(task),
        });
      });
      current.tasks = Array.from(taskById.values());
      teamConflictsByPeriod.set(key, current);
    }
  }

  const deficitRows = rows.filter(row => row.status === 'deficit');
  const surplusRows = rows.filter(row => row.status === 'surplus');
  const missingAvailabilityRows = rows.filter(row => row.status === 'missing_availability');
  const taskConflictMap: Record<string, LaborTaskConflictInfo> = {};
  deficitRows.forEach(row => {
    const label = `${row.roleName}: faltam ${Math.abs(row.balancePeople)} em ${row.periodLabel}`;
    row.activities.forEach(activity => bumpTaskConflict(taskConflictMap, activity.taskId, { roleDeficits: [label] }));
  });
  missingAvailabilityRows.forEach(row => {
    const label = `${row.roleName}: cadastre disponibilidade para ${row.periodLabel}`;
    row.activities.forEach(activity => bumpTaskConflict(taskConflictMap, activity.taskId, { missingAvailability: [label] }));
  });

  const teamConflicts = Array.from(teamConflictsByPeriod.values())
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey) || a.teamName.localeCompare(b.teamName));
  teamConflicts.forEach(conflict => {
    const label = `${conflict.teamName} em ${conflict.periodLabel}`;
    conflict.tasks.forEach(task => bumpTaskConflict(taskConflictMap, task.taskId, { teamConflicts: [label] }));
  });
  dataIssues.forEach(issue => {
    bumpTaskConflict(taskConflictMap, issue.taskId, { missingAvailability: [issue.message] });
  });

  const peopleByPeriod = new Map<string, { label: string; people: number }>();
  rows.forEach(row => {
    const current = peopleByPeriod.get(row.periodKey) ?? { label: row.periodLabel, people: 0 };
    current.people += row.recommendedPeople;
    peopleByPeriod.set(row.periodKey, current);
  });
  let peakPeople = 0;
  let peakPeriod = 'Sem demanda';
  peopleByPeriod.forEach(row => {
    if (row.people > peakPeople) {
      peakPeople = row.people;
      peakPeriod = row.label;
    }
  });

  const suggestions: LaborReprogrammingSuggestion[] = deficitRows.slice(0, 6).flatMap(row => {
    const movable = row.activities
      .map(activity => ({ activity, task: taskLookup.get(activity.taskId)?.task }))
      .filter(item => item.task && !item.task.isCritical)
      .sort((a, b) => b.activity.hours - a.activity.hours)[0];
    if (!movable?.task) return [];
    const newStart = addDaysISO(row.periodEnd, 1);
    return [{
      taskId: movable.task.id,
      taskName: movable.task.name,
      reason: `Reduzir sobreposicao de ${row.roleName} em ${row.periodLabel}`,
      suggestedStartDate: newStart,
      impactNote: 'Sugestao inicial: validar dependencias e caminho critico antes de aplicar.',
    }];
  });

  return {
    granularity,
    rows,
    deficitRows,
    surplusRows,
    missingAvailabilityRows,
    dataIssues,
    teamConflicts,
    taskConflictMap,
    peakPeople,
    peakPeriod,
    totalDeficitPeriods: deficitRows.length,
    totalSurplusPeriods: surplusRows.length,
    totalMissingAvailabilityPeriods: missingAvailabilityRows.length,
    suggestions,
  };
}

export function buildLaborProjection(project: Project): LaborProjection {
  const roles = getOperationalRoles(project);
  const settings = getDimensioningSettings(project);
  const availability = getLaborAvailability(project);
  const lines = buildLaborDemand(project);
  const demandLines = lines.filter(line => line.normalizationType === 'cargo_operacional' && line.normalizedRoleId);
  const byRole = new Map<string, number>();
  const periodRole = new Map<string, PeriodRoleDemand>();

  for (const line of demandLines) {
    const roleId = line.normalizedRoleId!;
    byRole.set(roleId, (byRole.get(roleId) ?? 0) + line.hours);
    // A necessidade executiva precisa respeitar o Cronograma: uma atividade
    // longa de vigia/encarregado/almoxarife distribui horas pelos dias em que
    // ela realmente acontece, em vez de virar "pessoas totais" concentradas.
    const workDays = workingDatesBetween(line.startDate, line.endDate, settings);
    const dailyHours = line.hours / Math.max(1, workDays.length);
    for (const dayISO of workDays) {
      const period = periodFor(dayISO, 'month').label;
      const role = roleById(roles, roleId);
      const key = `${period}|${roleId}`;
      const current = periodRole.get(key) ?? {
        period,
        roleId,
        roleName: role?.name ?? line.normalizedRoleName ?? roleId,
        hours: 0,
        neededPeople: 0,
        recommendedPeople: 0,
        availablePeople: 0,
        balancePeople: 0,
      };
      current.hours += dailyHours;
      periodRole.set(key, current);
    }
  }

  const rolePeakPeople = new Map<string, { neededPeople: number; recommendedPeople: number }>();
  Array.from(periodRole.values()).forEach(row => {
    const role = roleById(roles, row.roleId);
    const avail = availability.find(item => item.operationalRoleId === row.roleId);
    const dailyHours = avail?.dailyHours || role?.defaultDailyHours || settings.defaultDailyHours;
    const neededPeople = row.hours / (dailyHours * workingDaysInMonth(row.period, settings));
    const recommendedPeople = row.hours > 0 ? Math.ceil(neededPeople) : 0;
    const current = rolePeakPeople.get(row.roleId);
    if (!current || neededPeople > current.neededPeople) {
      rolePeakPeople.set(row.roleId, { neededPeople, recommendedPeople });
    }
  });

  const summaries: RoleDemandSummary[] = roles.map(role => {
    const hours = byRole.get(role.id) ?? 0;
    const avail = availability.find(row => row.operationalRoleId === role.id);
    const peak = rolePeakPeople.get(role.id);
    const calculatedPeople = peak?.neededPeople ?? 0;
    const recommendedPeople = peak?.recommendedPeople ?? 0;
    const availablePeople = avail?.quantity ?? 0;
    const balancePeople = availablePeople - recommendedPeople;
    return {
      roleId: role.id,
      roleName: role.name,
      hours,
      calculatedPeople,
      recommendedPeople,
      availablePeople,
      balancePeople,
      status: hours <= 0 ? 'empty' : balancePeople < 0 ? 'deficit' : balancePeople > 0 ? 'surplus' : 'ok',
    };
  }).filter(row => row.hours > 0 || row.availablePeople > 0);

  const periodRows = Array.from(periodRole.values()).map(row => {
    const role = roleById(roles, row.roleId);
    const avail = availability.find(item => item.operationalRoleId === row.roleId);
    const dailyHours = avail?.dailyHours || role?.defaultDailyHours || settings.defaultDailyHours;
    const neededPeople = row.hours / (dailyHours * workingDaysInMonth(row.period, settings));
    const recommendedPeople = row.hours > 0 ? Math.ceil(neededPeople) : 0;
    const availablePeople = avail?.quantity ?? 0;
    return {
      ...row,
      neededPeople,
      recommendedPeople,
      availablePeople,
      balancePeople: availablePeople - recommendedPeople,
    };
  });

  const peopleByPeriod = new Map<string, number>();
  periodRows.forEach(row => peopleByPeriod.set(row.period, (peopleByPeriod.get(row.period) ?? 0) + row.recommendedPeople));
  let peakPeriod = 'Sem demanda';
  let peakPeople = 0;
  peopleByPeriod.forEach((people, period) => {
    if (people > peakPeople) {
      peakPeople = people;
      peakPeriod = period;
    }
  });

  const demandByPhase = new Map<string, { phaseName: string; taskIds: Set<string>; roleHours: Map<string, number>; hours: number }>();
  for (const line of demandLines) {
    const current = demandByPhase.get(line.phaseId) ?? {
      phaseName: line.phaseName,
      taskIds: new Set<string>(),
      roleHours: new Map<string, number>(),
      hours: 0,
    };
    current.taskIds.add(line.taskId);
    current.hours += line.hours;
    current.roleHours.set(line.normalizedRoleId!, (current.roleHours.get(line.normalizedRoleId!) ?? 0) + line.hours);
    demandByPhase.set(line.phaseId, current);
  }

  const phaseSummaries: PhaseDemandSummary[] = Array.from(demandByPhase.entries())
    .map(([phaseId, row]) => ({
      phaseId,
      phaseName: row.phaseName,
      hours: row.hours,
      taskCount: row.taskIds.size,
      recommendedPeople: Math.ceil(row.hours / (settings.defaultDailyHours * 22)),
      mainRoles: Array.from(row.roleHours.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([roleId]) => roleById(roles, roleId)?.name ?? roleId),
    }))
    .sort((a, b) => b.hours - a.hours);

  const linesByTask = new Map<string, LaborDemandLine[]>();
  for (const line of demandLines) {
    linesByTask.set(line.taskId, [...(linesByTask.get(line.taskId) ?? []), line]);
  }

  const teams = project.teams ?? DEFAULT_TEAMS;
  const compatibility: TeamCompatibility[] = project.phases.flatMap(phase => phase.tasks.map(task => ({ phase, task }))).map(({ phase, task }) => {
    const taskLines = linesByTask.get(task.id) ?? [];
    const requiredRoles = Array.from(new Set(taskLines.map(line => line.normalizedRoleId!)));
    const team = teams.find(t => t.code === task.team);
    const teamRoleIds = team ? new Set(inferTeamMembers(team, project).map(member => member.operationalRoleId)) : new Set<string>();
    const missingIds = requiredRoles.filter(roleId => !teamRoleIds.has(roleId));
    const reason = requiredRoles.length === 0
      ? 'ok'
      : !team
        ? 'sem_equipe'
        : missingIds.length > 0
          ? 'faltando_cargo'
          : 'ok';
    return {
      taskId: task.id,
      taskName: task.name,
      phaseId: phase.id,
      phaseName: phase.name,
      startDate: task.startDate,
      endDate: taskEndDate(task),
      totalHours: taskLines.reduce((sum, line) => sum + line.hours, 0),
      teamName: team?.label,
      missingRoles: missingIds.map(roleId => roleById(roles, roleId)?.name ?? roleId),
      requiredRoles: requiredRoles.map(roleId => roleById(roles, roleId)?.name ?? roleId),
      compatible: reason === 'ok',
      reason,
    };
  }).filter(row => row.requiredRoles.length > 0);

  const taskSummaries: TaskDimensioningSummary[] = compatibility
    .map(row => ({
      taskId: row.taskId,
      taskName: row.taskName,
      phaseId: row.phaseId,
      phaseName: row.phaseName,
      startDate: row.startDate,
      endDate: row.endDate,
      totalHours: row.totalHours,
      requiredRoles: row.requiredRoles,
      teamName: row.teamName,
      missingRoles: row.missingRoles,
      status: row.reason === 'sem_equipe' ? 'sem_equipe' : row.reason === 'faltando_cargo' ? 'incompativel' : 'ok',
    }))
    .sort((a, b) => {
      const order = { incompativel: 0, sem_equipe: 1, ok: 2 };
      return order[a.status] - order[b.status] || b.totalHours - a.totalHours;
    });

  return {
    lines,
    summaries,
    periodRows,
    phaseSummaries,
    taskSummaries,
    totalHours: demandLines.reduce((sum, line) => sum + line.hours, 0),
    peakPeriod,
    peakPeople,
    deficitRoles: summaries.filter(row => row.status === 'deficit').length,
    accessoryCount: lines.filter(line => line.normalizationType === 'custo_acessorio' || line.normalizationType === 'ignorar_no_dimensionamento').length,
    reviewCount: lines.filter(line => line.normalizationType === 'revisar_manualmente').length,
    compatibility,
  };
}

export function updateAvailability(project: Project, roleId: string, patch: Partial<LaborAvailability>): Project {
  const rows = getLaborAvailability(project);
  const next = rows.map(row => row.operationalRoleId === roleId ? { ...row, ...patch } : row);
  return { ...project, laborAvailability: next };
}

export function saveManualNormalization(
  project: Project,
  originalName: string,
  normalizationType: LaborNormalizationType,
  operationalRoleId?: string,
): Project {
  const id = `ln-${norm(originalName).replace(/[^a-z0-9]+/g, '-').slice(0, 40) || Date.now().toString(36)}`;
  const previous = (project.laborNormalizationRules ?? []).filter(rule => norm(rule.originalName) !== norm(originalName));
  const next: LaborNormalizationRule = {
    id,
    originalName,
    operationalRoleId,
    normalizationType,
    active: true,
    manuallyReviewed: true,
    applyToSimilar: true,
    changedAt: new Date().toISOString(),
    previousRule: project.laborNormalizationRules?.find(rule => norm(rule.originalName) === norm(originalName))?.operationalRoleId,
  };
  return { ...project, laborNormalizationRules: [...previous, next] };
}
