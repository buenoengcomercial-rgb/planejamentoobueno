import { buildWeeklyRoutine, type WeeklyRoutineCalendar } from '@/lib/weeklyRoutine';
import type { Project } from '@/types/project';

self.onmessage = (event: MessageEvent<{ project: Project; weekStart: string; excludedTaskIds: Set<string>; calendar: WeeklyRoutineCalendar }>) => {
  try {
    const { project, weekStart, excludedTaskIds, calendar } = event.data;
    self.postMessage({ week: buildWeeklyRoutine(project, weekStart, excludedTaskIds, calendar) });
  } catch {
    self.postMessage({ error: 'Não foi possível calcular a Rotina. Tente novamente.' });
  }
};
