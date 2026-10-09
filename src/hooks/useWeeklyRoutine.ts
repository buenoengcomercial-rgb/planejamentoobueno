import { useEffect, useMemo, useState } from 'react';
import { buildWeeklyRoutine, type WeeklyRoutineCalendar } from '@/lib/weeklyRoutine';
import type { Project, WeeklyRoutineDay } from '@/types/project';

const EMPTY_WEEK: WeeklyRoutineDay[] = [];

/** Keep the complete calculation off the UI thread; no results survive an input change. */
export function useWeeklyRoutine(project: Project, weekStart: string, excludedTaskIds: Set<string>, calendar: WeeklyRoutineCalendar) {
  const [retry, setRetry] = useState(0);
  const input = useMemo(() => ({ project, weekStart, excludedTaskIds, calendar, retry }), [project, weekStart, excludedTaskIds, calendar, retry]);
  const useWorker = typeof Worker !== 'undefined';
  const fallback = useMemo(() => useWorker ? EMPTY_WEEK : buildWeeklyRoutine(project, weekStart, excludedTaskIds, calendar), [useWorker, project, weekStart, excludedTaskIds, calendar]);
  const [result, setResult] = useState<{ input: typeof input; week: WeeklyRoutineDay[]; error?: string }>();
  useEffect(() => {
    if (!useWorker) return;
    let active = true;
    let finished = false;
    let worker: Worker | undefined;
    const fail = () => {
      if (!active || finished) return;
      finished = true;
      setResult({ input, week: EMPTY_WEEK, error: 'Não foi possível calcular a Rotina. Tente novamente.' });
      worker?.terminate();
    };
    const timeout = setTimeout(fail, 30_000);
    const fallbackLocally = () => {
      clearTimeout(timeout);
      worker?.terminate();
      // Older browsers or an unavailable worker asset still get the full calculation.
      queueMicrotask(() => {
        if (!active || finished) return;
        try {
          const week = buildWeeklyRoutine(project, weekStart, excludedTaskIds, calendar);
          setResult({ input, week }); finished = true;
        } catch { fail(); }
      });
    };
    try {
      worker = new Worker(new URL('../workers/weeklyRoutine.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        clearTimeout(timeout);
        if (!active || finished) return;
        if (event.data.error || !Array.isArray(event.data.week)) { fail(); return; }
        setResult({ input, week: event.data.week });
        finished = true;
        worker?.terminate();
      };
      worker.onerror = fallbackLocally;
      worker.postMessage(input);
    } catch { fallbackLocally(); }
    return () => { active = false; clearTimeout(timeout); worker?.terminate(); };
  }, [input, useWorker, project, weekStart, excludedTaskIds, calendar]);
  return {
    week: useWorker ? result?.input === input ? result.week : EMPTY_WEEK : fallback,
    loading: useWorker && result?.input !== input,
    error: result?.input === input ? result.error : undefined,
    reload: () => setRetry(value => value + 1),
  };
}
