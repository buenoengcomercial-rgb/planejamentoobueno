import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { AppView, DailyReport, Project } from '@/types/project';
import { confirmProjectCollectionsSnapshot, getMissingProjectCollections } from '@/lib/projectSync';
import { reportForDate, replaceReportForDate, replaceSavedDailyReport } from './dailyReportProject';

interface Options {
  projectId?: string;
  activeView: AppView;
  project: MutableRefObject<Project | null>;
  conflictDetected: MutableRefObject<boolean>;
  pendingSaves: MutableRefObject<number>;
  saveTimer: MutableRefObject<number | null>;
  inFlightSave: MutableRefObject<Promise<void> | null>;
  skipNextAutoSave: MutableRefObject<boolean>;
  savedProjectJson: MutableRefObject<string | null>;
  markRemoteCollections: (projectId: string, collections: readonly ['dailyReports']) => void;
  mergeIntoPartialSync: (projectId: string, date: string, report: DailyReport) => void;
  setProject: (project: Project) => void;
  setRemoteUpdateAt: (at: string) => void;
}

/** Applies a single confirmed Diary row only while its own area is safe to refresh. */
export function useDailyReportRealtime(options: Options): (report: DailyReport) => void {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef(new Map<string, { projectId: string; report: DailyReport }>());
  const timer = useRef<number | null>(null);
  const receive = useCallback((incoming: DailyReport) => {
    const state = latest.current;
    const current = state.project.current;
    if (!current || !incoming.date || state.conflictDetected.current) return;
    if (state.activeView !== 'dailyReport') {
      state.markRemoteCollections(current.id, ['dailyReports']);
      return;
    }
    if (state.pendingSaves.current > 0 || state.saveTimer.current || state.inFlightSave.current) {
      pending.current.set(`${current.id}:${incoming.date}`, { projectId: current.id, report: incoming });
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const queued = [...pending.current.values()];
        pending.current.clear();
        queued.forEach(({ projectId, report }) => {
          if (latest.current.project.current?.id === projectId) receive(report);
        });
      }, 1200);
      return;
    }
    if (getMissingProjectCollections(current.id, ['dailyReports']).length > 0) {
      state.markRemoteCollections(current.id, ['dailyReports']);
      return;
    }
    state.mergeIntoPartialSync(current.id, incoming.date, incoming);
    const currentReport = reportForDate(current, incoming.date);
    if (currentReport && JSON.stringify(currentReport) === JSON.stringify(incoming)) return;
    const next = replaceReportForDate(current, incoming.date, incoming);
    confirmProjectCollectionsSnapshot(next, ['dailyReports']);
    state.skipNextAutoSave.current = true;
    state.project.current = next;
    state.setProject(next);
    state.savedProjectJson.current = replaceSavedDailyReport(state.savedProjectJson.current, incoming.date, incoming);
    state.setRemoteUpdateAt(new Date().toISOString());
  }, []);

  useEffect(() => {
    const pendingReports = pending.current;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    pendingReports.clear();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      pendingReports.clear();
    };
  }, [options.projectId]);

  return receive;
}
