import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { toast } from 'sonner';
import type { SaveStatus } from '@/components/SaveStatusIndicator';
import type { Project } from '@/types/project';
import { CloudProjectConflictError } from '@/lib/cloudProjects';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { cloudRetryDelay, isTransientCloudError } from '@/lib/cloudRetry';

const SAVE_DEBOUNCE_MS = 4000;

interface ProjectAutoSaveOptions {
  project: Project | null;
  userId: string | null;
  organizationId: string | undefined;
  canPersist: boolean;
  recoveredDraftRevision: number;
  retryTick: number;
  initialLoadRef: MutableRefObject<boolean>;
  pendingDailyReportSavesRef: MutableRefObject<number>;
  conflictDetectedRef: MutableRefObject<boolean>;
  skipNextAutoSaveRef: MutableRefObject<boolean>;
  partialSyncPendingRef: MutableRefObject<{ projectId: string } | null>;
  saveTimerRef: MutableRefObject<number | null>;
  saveRetryTimerRef: MutableRefObject<number | null>;
  saveRetryAttemptRef: MutableRefObject<number>;
  saveRetryProjectJsonRef: MutableRefObject<string | null>;
  rawProjectRef: MutableRefObject<Project | null>;
  setSaveStatus: Dispatch<SetStateAction<SaveStatus>>;
  setRetryTick: Dispatch<SetStateAction<number>>;
  persistProject: (project: Project, organizationId: string) => Promise<void>;
  handleCloudConflict: (project: Project) => Promise<void>;
}

/** Coordinates the legacy project save independently of the selected tab. */
export function useProjectAutoSave({
  project, userId, organizationId, canPersist, recoveredDraftRevision, retryTick,
  initialLoadRef, pendingDailyReportSavesRef, conflictDetectedRef, skipNextAutoSaveRef,
  partialSyncPendingRef, saveTimerRef, saveRetryTimerRef, saveRetryAttemptRef,
  saveRetryProjectJsonRef, rawProjectRef, setSaveStatus, setRetryTick,
  persistProject, handleCloudConflict,
}: ProjectAutoSaveOptions): void {
  useEffect(() => {
    void recoveredDraftRevision;
    void retryTick;
    if (!userId || !organizationId || !project || !initialLoadRef.current || !canPersist) return;
    // A fila do Diário confirma o registro da data antes de qualquer gravação geral.
    if (pendingDailyReportSavesRef.current > 0 || conflictDetectedRef.current) return;
    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      setSaveStatus(partialSyncPendingRef.current?.projectId === project.id ? 'error' : 'saved');
      return;
    }
    const currentJson = serializeProject(project);
    if (saveRetryProjectJsonRef.current !== currentJson) {
      saveRetryProjectJsonRef.current = currentJson;
      saveRetryAttemptRef.current = 0;
    }
    if (saveRetryTimerRef.current !== null) {
      window.clearTimeout(saveRetryTimerRef.current);
      saveRetryTimerRef.current = null;
    }
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    setSaveStatus(navigator.onLine ? 'pending' : 'offline');
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        saveTimerRef.current = null;
        setSaveStatus('saving');
        await persistProject(project, organizationId);
        if (partialSyncPendingRef.current?.projectId !== project.id) saveRetryAttemptRef.current = 0;
      } catch (error) {
        console.warn(error);
        if (error instanceof CloudProjectConflictError) {
          await handleCloudConflict(project);
        } else {
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
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (saveRetryTimerRef.current !== null) window.clearTimeout(saveRetryTimerRef.current);
    };
  }, [project, userId, organizationId, canPersist, persistProject, handleCloudConflict, recoveredDraftRevision, retryTick,
    initialLoadRef, pendingDailyReportSavesRef, conflictDetectedRef, skipNextAutoSaveRef, partialSyncPendingRef,
    saveTimerRef, saveRetryTimerRef, saveRetryAttemptRef, saveRetryProjectJsonRef, rawProjectRef, setSaveStatus, setRetryTick]);
}
