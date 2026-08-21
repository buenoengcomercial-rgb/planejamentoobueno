import type {
  DailyReport,
  Project,
  Task,
  WeeklyRoutineChapterPathItem,
  WeeklyRoutineActivity,
  WeeklyRoutineDay,
  WeeklyRoutineDiaryStatus,
} from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { isDailyReportEmpty, pickLatestDailyReport } from '@/lib/dailyReportSummary';
import { getChapterNumbering } from '@/lib/chapters';
import { isDiaUtil } from '@/lib/feriados';

const DAY_MS = 86_400_000;

export interface WeeklyRoutineCalendar {
  uf: string;
  municipio: string;
  trabalhaSabado: boolean;
}

const DEFAULT_CALENDAR: WeeklyRoutineCalendar = {
  uf: 'SP',
  municipio: 'São Paulo',
  trabalhaSabado: false,
};

export function parseISODate(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function startOfWeekISO(value: string): string {
  const date = parseISODate(value);
  const weekDay = date.getDay();
  date.setDate(date.getDate() + (weekDay === 0 ? -6 : 1 - weekDay));
  return toISODate(date);
}

export function addDaysISO(value: string, days: number): string {
  const date = parseISODate(value);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

function isWorkingDate(date: string, calendar: WeeklyRoutineCalendar): boolean {
  return isDiaUtil(parseISODate(date), calendar.uf, calendar.municipio, calendar.trabalhaSabado);
}

function workDayWeight(date: string, calendar: WeeklyRoutineCalendar): number {
  if (!isWorkingDate(date, calendar)) return 0;
  return parseISODate(date).getDay() === 6 ? 0.5 : 1;
}

function workingSchedule(task: Task, calendar: WeeklyRoutineCalendar): Map<string, number> {
  const schedule = new Map<string, number>();
  let remaining = Math.max(0, Number(task.duration) || 0);
  let date = task.startDate;
  let safety = 0;

  while (remaining > 0 && safety < 10_000) {
    safety += 1;
    const capacity = workDayWeight(date, calendar);
    if (capacity > 0) {
      const plannedWeight = Math.min(capacity, remaining);
      schedule.set(date, plannedWeight);
      remaining = Math.max(0, remaining - plannedWeight);
    }
    date = addDaysISO(date, 1);
  }

  return schedule;
}

export function taskSchedule(
  task: Task,
  calendar: WeeklyRoutineCalendar = DEFAULT_CALENDAR,
): { startDate: string; endDate: string; workDays: Map<string, number> } {
  // A agenda reflete o planejamento operacional atual do Gantt. Baseline e
  // current são referências histórica/real e não devem reposicionar cartões.
  const workDays = workingSchedule(task, calendar);
  const dates = [...workDays.keys()];
  return {
    startDate: dates[0] ?? task.startDate,
    endDate: dates.at(-1) ?? task.startDate,
    workDays,
  };
}

function activeTask(task: Task, excludedTaskIds: ReadonlySet<string>): boolean {
  if (excludedTaskIds.has(task.id)) return false;
  if (task.suppressedByAdditive) return false;
  const fullySuppressed = (Number(task.quantity) || 0) <= 0
    && (task.additiveHistory ?? []).some(history => (history.suppressedQuantity || 0) > 0);
  return !fullySuppressed;
}

function buildChapterByTask(project: Project): Map<string, { name: string; number?: string; path: WeeklyRoutineChapterPathItem[] }> {
  const numbering = getChapterNumbering(project);
  const phaseById = new Map(project.phases.map(phase => [phase.id, phase]));
  const result = new Map<string, { name: string; number?: string; path: WeeklyRoutineChapterPathItem[] }>();

  const pathForPhase = (phaseId: string): WeeklyRoutineChapterPathItem[] => {
    const path: WeeklyRoutineChapterPathItem[] = [];
    const visited = new Set<string>();
    let current = phaseById.get(phaseId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift({ id: current.id, name: current.name, number: numbering.get(current.id) });
      current = current.parentId ? phaseById.get(current.parentId) : undefined;
    }
    return path;
  };

  const visit = (task: Task, chapter: { name: string; number?: string; path: WeeklyRoutineChapterPathItem[] }) => {
    result.set(task.id, chapter);
    task.children?.forEach(child => visit(child, chapter));
  };

  project.phases.forEach(phase => {
    const chapter = { name: phase.name, number: numbering.get(phase.id), path: pathForPhase(phase.id) };
    phase.tasks.forEach(task => visit(task, chapter));
  });

  return result;
}

function quantityForDay(task: Task, date: string, kind: 'planned' | 'actual', workDayWeight = 0): number {
  const logs = (task.dailyLogs ?? []).filter(log => log.date === date);
  const logged = logs.reduce((sum, log) => sum + Number(kind === 'planned' ? log.plannedQuantity : log.actualQuantity || 0), 0);
  if (logged > 0 || kind === 'actual') return Math.round(logged * 100) / 100;

  const quantity = Number(task.quantity) || 0;
  const duration = Number(task.duration) || 0;
  return duration > 0 ? Math.round(((quantity / duration) * workDayWeight) * 100) / 100 : 0;
}

function compareChapterNumbers(left?: string, right?: string): number {
  const leftParts = (left || '').split('.');
  const rightParts = (right || '').split('.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
    const comparison = bothNumeric
      ? leftNumber - rightNumber
      : leftPart.localeCompare(rightPart, 'pt-BR', { numeric: true, sensitivity: 'base' });
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareChapterPaths(left: WeeklyRoutineActivity, right: WeeklyRoutineActivity): number {
  const length = Math.max(left.chapterPath.length, right.chapterPath.length);
  for (let index = 0; index < length; index += 1) {
    const leftChapter = left.chapterPath[index];
    const rightChapter = right.chapterPath[index];
    if (!leftChapter) return -1;
    if (!rightChapter) return 1;
    const numberComparison = compareChapterNumbers(leftChapter.number, rightChapter.number);
    if (numberComparison !== 0) return numberComparison;
    const nameComparison = leftChapter.name.localeCompare(rightChapter.name, 'pt-BR', { sensitivity: 'base' });
    if (nameComparison !== 0) return nameComparison;
  }
  return 0;
}

function latestReportByDate(project: Project): Map<string, DailyReport> {
  const reports = new Map<string, DailyReport>();
  (project.dailyReports ?? []).forEach(report => {
    if (!report.date) return;
    reports.set(report.date, pickLatestDailyReport(reports.get(report.date), report));
  });
  return reports;
}

export function diaryStatusForDate(report?: DailyReport): WeeklyRoutineDiaryStatus {
  if (report?.noProductionDeclared) return 'noProduction';
  if (String(report?.impediments ?? '').trim()) return 'impediment';
  if (report && !isDailyReportEmpty(report)) return 'filled';
  return 'notFilled';
}

export function buildWeeklyRoutine(
  project: Project,
  weekStart: string,
  excludedTaskIds: ReadonlySet<string> = new Set(),
  calendar: WeeklyRoutineCalendar = DEFAULT_CALENDAR,
): WeeklyRoutineDay[] {
  const normalizedStart = startOfWeekISO(weekStart);
  const dates = Array.from({ length: 7 }, (_, index) => addDaysISO(normalizedStart, index))
    .filter(date => isWorkingDate(date, calendar));
  const reports = latestReportByDate(project);
  const chapterByTask = buildChapterByTask(project);
  const tasks = getAllTasks(project).filter(task => activeTask(task, excludedTaskIds));

  return dates.map(date => {
    const activities = tasks
      .map(task => {
        const schedule = taskSchedule(task, calendar);
        const scheduledWeight = schedule.workDays.get(date) ?? 0;
        if (scheduledWeight <= 0) return null;
        const plannedQuantity = quantityForDay(task, date, 'planned', scheduledWeight);
        const actualQuantity = quantityForDay(task, date, 'actual');
        return {
          taskId: task.id,
          taskName: task.name,
          chapterName: chapterByTask.get(task.id)?.name ?? 'Sem capítulo',
          chapterNumber: chapterByTask.get(task.id)?.number,
          chapterPath: chapterByTask.get(task.id)?.path ?? [],
          date,
          startDate: schedule.startDate,
          endDate: schedule.endDate,
          plannedQuantity,
          actualQuantity,
          unit: task.unit || 'un',
          teamCode: task.team,
          responsible: task.responsible,
          completed: plannedQuantity > 0 ? actualQuantity >= plannedQuantity : task.percentComplete >= 100,
        } satisfies WeeklyRoutineActivity;
      })
      .filter((activity): activity is NonNullable<typeof activity> => activity !== null)
      .sort((a, b) => compareChapterPaths(a, b) || a.taskName.localeCompare(b.taskName, 'pt-BR', { sensitivity: 'base' }));

    return {
      date,
      diaryStatus: diaryStatusForDate(reports.get(date)),
      activities,
    } satisfies WeeklyRoutineDay;
  });
}

export function findNextScheduledActivity(
  project: Project,
  afterDate: string,
  excludedTaskIds: ReadonlySet<string> = new Set(),
  calendar: WeeklyRoutineCalendar = DEFAULT_CALENDAR,
): WeeklyRoutineActivity | null {
  const chapterByTask = buildChapterByTask(project);
  const candidates = getAllTasks(project)
    .filter(task => activeTask(task, excludedTaskIds))
    .map(task => {
      const schedule = taskSchedule(task, calendar);
      const date = [...schedule.workDays.keys()].find(workDate => workDate >= afterDate);
      return { task, schedule, date };
    })
    .filter((candidate): candidate is typeof candidate & { date: string } => !!candidate.date)
    .sort((a, b) => a.date.localeCompare(b.date) || a.task.name.localeCompare(b.task.name));
  const first = candidates[0];
  if (!first) return null;
  const date = first.date;
  return {
    taskId: first.task.id,
    taskName: first.task.name,
    chapterName: chapterByTask.get(first.task.id)?.name ?? 'Sem capítulo',
    chapterNumber: chapterByTask.get(first.task.id)?.number,
    chapterPath: chapterByTask.get(first.task.id)?.path ?? [],
    date,
    startDate: first.schedule.startDate,
    endDate: first.schedule.endDate,
    plannedQuantity: quantityForDay(first.task, date, 'planned', first.schedule.workDays.get(date) ?? 0),
    actualQuantity: quantityForDay(first.task, date, 'actual'),
    unit: first.task.unit || 'un',
    teamCode: first.task.team,
    responsible: first.task.responsible,
    completed: false,
  };
}

export interface WeeklyRoutineActivityGroup {
  chapter: WeeklyRoutineChapterPathItem;
  activities: WeeklyRoutineActivity[];
  children: WeeklyRoutineActivityGroup[];
  totalActivities: number;
}

/** Agrupa a agenda pelo caminho EAP, preservando a ordem recebida do Cronograma. */
export function groupWeeklyRoutineActivities(activities: WeeklyRoutineActivity[]): WeeklyRoutineActivityGroup[] {
  const roots: WeeklyRoutineActivityGroup[] = [];

  activities.forEach(activity => {
    let siblings = roots;
    let group: WeeklyRoutineActivityGroup | undefined;
    activity.chapterPath.forEach(chapter => {
      group = siblings.find(item => item.chapter.id === chapter.id);
      if (!group) {
        group = { chapter, activities: [], children: [], totalActivities: 0 };
        siblings.push(group);
      }
      siblings = group.children;
    });
    if (group) group.activities.push(activity);
  });

  const totalize = (group: WeeklyRoutineActivityGroup): WeeklyRoutineActivityGroup => {
    const children = group.children.map(totalize);
    return {
      ...group,
      children,
      totalActivities: group.activities.length + children.reduce((sum, child) => sum + child.totalActivities, 0),
    };
  };
  return roots.map(totalize);
}

export function inclusiveDays(startDate: string, endDate: string): number {
  return Math.floor((parseISODate(endDate).getTime() - parseISODate(startDate).getTime()) / DAY_MS) + 1;
}
