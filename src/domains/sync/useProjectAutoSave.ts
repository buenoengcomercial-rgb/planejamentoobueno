import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { toast } from 'sonner';
import type { SaveStatus } from '@/components/SaveStatusIndicator';
import type { Project } from '@/types/project';
import { CloudProjectConflictError } from '@/lib/cloudProjects';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { cloudRetryDelay, isTransientCloudError } from '@/lib/cloudRetry';
import { projectWriteOrigin } from '@/lib/projectOperations';

const SAVE_DEBOUNCE_MS = 1200;
const ADDITIVE_SCHEDULE_DEBOUNCE_MS = 700;

export function projectAutoSaveDelay(project: Project): number {
  return projectWriteOrigin(project) === 'additiveSchedule' ? ADDITIVE_SCHEDULE_DEBOUNCE_MS : SAVE_DEBOUNCE_MS;
}

interface ProjectAutoSaveOptions {
  project: Project | null;
  userId: string | null;
  organizationId: string | undefined;
  canPersist: boolean;
  recoveredDraftRevision: number;
  retryTick: number;
  initialLoadRef: MutableRefObject<boolean>;
  pendingDailyReportSavesRef: MutableRefObject<number>;
  dailyReportSaveQueueRef: MutableRefObject<Promise<unknown>>;
  inFlightSaveRef: MutableRefObject<Promise<void> | null>;
  conflictDetectedRef: MutableRefObject<boolean>;
  skipNextAutoSaveRef: MutableRefObject<boolean>;
  partialSyncPendingRef: MutableRefObject<{ projectId: string } | null>;
  saveTimerRef: MutableRefObject<number | null>;
  saveRetryTimerRef: MutableRefObject<number | null>;
  saveRetryAttemptRef: MutableRefObject<number>;
  saveRetryProjectJsonRef: MutableRefObject<string | null>;
  lastSavedProjectJsonRef: MutableRefObject<string | null>;
  rawProjectRef: MutableRefObject<Project | null>;
  setSaveStatus: Dispatch<SetStateAction<SaveStatus>>;
  setRetryTick: Dispatch<SetStateAction<number>>;
  persistProject: (project: Project, organizationId: string) => Promise<void>;
  handleCloudConflict: (project: Project) => Promise<void>;
}

/** Coordinates the legacy project save independently of the selected tab. */
export function useProjectAutoSave({
  project, userId, organizationId, canPersist, recoveredDraftRevision, retryTick,
  initialLoadRef, pendingDailyReportSavesRef, dailyReportSaveQueueRef, inFlightSaveRef, conflictDetectedRef, skipNextAutoSaveRef,
  partialSyncPendingRef, saveTimerRef, saveRetryTimerRef, saveRetryAttemptRef,
  saveRetryProjectJsonRef, lastSavedProjectJsonRef, rawProjectRef, setSaveStatus, setRetryTick,
  persistProject, handleCloudConflict,
}: ProjectAutoSaveOptions): void {
  useEffect(() => {
    void recoveredDraftRevision;
    void retryTick;
    if (!userId || !organizationId || !project || !initialLoadRef.current || !canPersist) return;
    if (conflictDetectedRef.current) return;
    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      setSaveStatus(partialSyncPendingRef.current?.projectId === project.id ? 'error' : 'saved');
      return;
    }
    let waitedForDiary = pendingDailyReportSavesRef.current > 0;
    let cancelled = false;
    if (saveRetryTimerRef.current !== null) {
      window.clearTimeout(saveRetryTimerRef.current);
      saveRetryTimerRef.current = null;
    }
    if (pendingDailyReportSavesRef.current === 0 && !inFlightSaveRef.current) {
      setSaveStatus(navigator.onLine ? 'pending' : 'offline');
    }
    saveTimerRef.current = window.setTimeout(async () => {
      const timer = saveTimerRef.current;
      // Wait for the responsible write, then read the latest merged project.
      while (!cancelled && saveTimerRef.current === timer) {
        if (pendingDailyReportSavesRef.current > 0) {
          waitedForDiary = true;
          await dailyReportSaveQueueRef.current.catch(() => undefined);
        } else if (inFlightSaveRef.current) {
          await inFlightSaveRef.current.catch(() => undefined);
        } else break;
      }
      if (cancelled || saveTimerRef.current !== timer) return;
      saveTimerRef.current = null;
      const latest = rawProjectRef.current;
      if (latest?.id !== project.id || conflictDetectedRef.current) return;
      const currentJson = serializeProject(latest);
      if (waitedForDiary && currentJson === lastSavedProjectJsonRef.current
        && partialSyncPendingRef.current?.projectId !== project.id) return;
      if (saveRetryProjectJsonRef.current !== currentJson) {
        saveRetryProjectJsonRef.current = currentJson;
        saveRetryAttemptRef.current = 0;
      }
      try {
        setSaveStatus('saving');
        await persistProject(latest, organizationId);
        if (partialSyncPendingRef.current?.projectId !== project.id) saveRetryAttemptRef.current = 0;
      } catch (error) {
        if (rawProjectRef.current?.id !== project.id) return;
        console.warn(error);
        if (error instanceof CloudProjectConflictError) {
          await handleCloudConflict(rawProjectRef.current);
        } else if (!cancelled) {
          setSaveStatus(navigator.onLine ? 'error' : 'offline');
          const retryDelay = isTransientCloudError(error) ? cloudRetryDelay(saveRetryAttemptRef.current++) : null;
          if (retryDelay !== null) {
            saveRetryTimerRef.current = window.setTimeout(() => {
              saveRetryTimerRef.current = null;
              if (rawProjectRef.current?.id === project.id && !conflictDetectedRef.current) {
                setRetryTick(value => value + 1);
              }
            }, retryDelay);
          } else {
            toast.error('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
          }
        }
      }
    }, projectAutoSaveDelay(project));
    return () => {
      cancelled = true;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      if (saveRetryTimerRef.current !== null) window.clearTimeout(saveRetryTimerRef.current);
      saveRetryTimerRef.current = null;
    };
  }, [project, userId, organizationId, canPersist, persistProject, handleCloudConflict, recoveredDraftRevision, retryTick,
    initialLoadRef, pendingDailyReportSavesRef, dailyReportSaveQueueRef, inFlightSaveRef, conflictDetectedRef, skipNextAutoSaveRef, partialSyncPendingRef,
    saveTimerRef, saveRetryTimerRef, saveRetryAttemptRef, saveRetryProjectJsonRef, lastSavedProjectJsonRef, rawProjectRef, setSaveStatus, setRetryTick]);
}
