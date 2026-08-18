import type {
  DailyReport,
  Project,
  Task,
  WeeklyRoutineActivity,
  WeeklyRoutineDay,
  WeeklyRoutineDiaryStatus,
} from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { isDailyReportEmpty, pickLatestDailyReport } from '@/lib/dailyReportSummary';
import { getChapterNumbering } from '@/lib/chapters';

const DAY_MS = 86_400_000;

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

export function taskSchedule(task: Task): { startDate: string; endDate: string } {
  const startDate = task.current?.startDate ?? task.baseline?.startDate ?? task.startDate;
  const explicitEnd = task.current?.endDate ?? task.baseline?.endDate;
  if (explicitEnd) return { startDate, endDate: explicitEnd };
  return { startDate, endDate: addDaysISO(startDate, Math.max(0, (task.duration || 1) - 1)) };
}

function activeTask(task: Task): boolean {
  if (task.suppressedByAdditive) return false;
  const fullySuppressed = (Number(task.quantity) || 0) <= 0
    && (task.additiveHistory ?? []).some(history => (history.suppressedQuantity || 0) > 0);
  return !fullySuppressed;
}

function buildChapterByTask(project: Project): Map<string, { name: string; number?: string }> {
  const numbering = getChapterNumbering(project);
  const result = new Map<string, { name: string; number?: string }>();

  const visit = (task: Task, chapter: { name: string; number?: string }) => {
    result.set(task.id, chapter);
    task.children?.forEach(child => visit(child, chapter));
  };

  project.phases.forEach(phase => {
    const chapter = { name: phase.name, number: numbering.get(phase.id) };
    phase.tasks.forEach(task => visit(task, chapter));
  });

  return result;
}

function quantityForDay(task: Task, date: string, kind: 'planned' | 'actual'): number {
  const logs = (task.dailyLogs ?? []).filter(log => log.date === date);
  const logged = logs.reduce((sum, log) => sum + Number(kind === 'planned' ? log.plannedQuantity : log.actualQuantity || 0), 0);
  if (logged > 0 || kind === 'actual') return Math.round(logged * 100) / 100;

  const quantity = Number(task.quantity) || 0;
  const duration = task.originalDuration ?? task.baseline?.duration ?? task.duration ?? 0;
  return duration > 0 ? Math.round((quantity / duration) * 100) / 100 : 0;
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

export function buildWeeklyRoutine(project: Project, weekStart: string): WeeklyRoutineDay[] {
  const normalizedStart = startOfWeekISO(weekStart);
  const dates = Array.from({ length: 7 }, (_, index) => addDaysISO(normalizedStart, index));
  const reports = latestReportByDate(project);
  const chapterByTask = buildChapterByTask(project);
  const tasks = getAllTasks(project).filter(activeTask);

  return dates.map(date => {
    const activities = tasks
      .map(task => {
        const schedule = taskSchedule(task);
        if (date < schedule.startDate || date > schedule.endDate) return null;
        const plannedQuantity = quantityForDay(task, date, 'planned');
        const actualQuantity = quantityForDay(task, date, 'actual');
        return {
          taskId: task.id,
          taskName: task.name,
          chapterName: chapterByTask.get(task.id)?.name ?? 'Sem capítulo',
          chapterNumber: chapterByTask.get(task.id)?.number,
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
      .sort((a, b) => a.chapterName.localeCompare(b.chapterName) || a.taskName.localeCompare(b.taskName));

    return {
      date,
      diaryStatus: diaryStatusForDate(reports.get(date)),
      activities,
    } satisfies WeeklyRoutineDay;
  });
}

export function findNextScheduledActivity(project: Project, afterDate: string): WeeklyRoutineActivity | null {
  const chapterByTask = buildChapterByTask(project);
  const candidates = getAllTasks(project)
    .filter(activeTask)
    .map(task => ({ task, schedule: taskSchedule(task) }))
    .filter(({ schedule }) => schedule.endDate >= afterDate)
    .sort((a, b) => a.schedule.startDate.localeCompare(b.schedule.startDate));
  const first = candidates[0];
  if (!first) return null;
  const date = first.schedule.startDate < afterDate ? afterDate : first.schedule.startDate;
  return {
    taskId: first.task.id,
    taskName: first.task.name,
    chapterName: chapterByTask.get(first.task.id)?.name ?? 'Sem capítulo',
    chapterNumber: chapterByTask.get(first.task.id)?.number,
    date,
    startDate: first.schedule.startDate,
    endDate: first.schedule.endDate,
    plannedQuantity: quantityForDay(first.task, date, 'planned'),
    actualQuantity: quantityForDay(first.task, date, 'actual'),
    unit: first.task.unit || 'un',
    teamCode: first.task.team,
    responsible: first.task.responsible,
    completed: false,
  };
}

export function inclusiveDays(startDate: string, endDate: string): number {
  return Math.floor((parseISODate(endDate).getTime() - parseISODate(startDate).getTime()) / DAY_MS) + 1;
}
