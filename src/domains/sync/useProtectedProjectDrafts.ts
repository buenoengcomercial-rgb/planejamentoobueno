import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { SaveStatus } from '@/components/SaveStatusIndicator';
import type { Project } from '@/types/project';
import type { ProjectCollectionKey } from '@/lib/projectDataScope';
import { clearProjectDraft, createProjectDraft, writeProjectDraft } from '@/lib/cloudProjectDraftCore';
import { supportsIndexedDbDrafts, writeIndexedDbProjectDraft } from '@/lib/cloudDraftIndexedDb';
import { getLoadedProjectCollections } from '@/lib/projectSync';

const LOCAL_DRAFT_DEBOUNCE_MS = 900;

interface PartialSyncPending {
  projectId: string;
  loadedCollections: ProjectCollectionKey[];
  project: Project;
  draftProtected: boolean;
}

interface PartialSyncIssue {
  projectId: string;
  draftProtected: boolean;
}

interface ProtectedProjectDraftOptions {
  partialSyncPendingRef: MutableRefObject<PartialSyncPending | null>;
  conflictDetectedRef: RefObject<boolean>;
  rawProjectRef: RefObject<Project | null>;
  setPartialSyncIssue: Dispatch<SetStateAction<PartialSyncIssue | null>>;
  setSaveStatus: Dispatch<SetStateAction<SaveStatus>>;
}

/** Protege rascunhos do projeto sem confirmar qualquer gravação na nuvem. */
export function useProtectedProjectDrafts({
  partialSyncPendingRef, conflictDetectedRef, rawProjectRef,
  setPartialSyncIssue, setSaveStatus,
}: ProtectedProjectDraftOptions) {
  const draftWriteTimerRef = useRef<number | null>(null);
  const pendingDraftRef = useRef<{ project: Project; baseUpdatedAt: string | null } | null>(null);

  const cancelScheduledDraft = useCallback((projectId?: string) => {
    const pending = pendingDraftRef.current;
    if (!pending || (projectId && pending.project.id !== projectId)) return;
    if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
    draftWriteTimerRef.current = null;
    pendingDraftRef.current = null;
  }, []);

  const writeProtectedProjectDraft = useCallback((project: Project, baseUpdatedAt: string | null) => {
    const partial = partialSyncPendingRef.current?.projectId === project.id
      ? partialSyncPendingRef.current
      : null;
    const loadedCollections = partial?.loadedCollections ?? getLoadedProjectCollections(project.id);
    const stored = writeProjectDraft(project, baseUpdatedAt, undefined, partial ? {
      pendingNormalizedSync: true,
      loadedCollections,
    } : { loadedCollections });
    if (!stored && supportsIndexedDbDrafts()) {
      const candidate = createProjectDraft(project, baseUpdatedAt, partial ? {
        pendingNormalizedSync: true, loadedCollections,
      } : { loadedCollections });
      void writeIndexedDbProjectDraft(candidate).then(confirmed => {
        if (!confirmed) return;
        const current = partialSyncPendingRef.current;
        if (current?.projectId === project.id && !current.draftProtected) {
          partialSyncPendingRef.current = { ...current, draftProtected: true };
          setPartialSyncIssue({ projectId: project.id, draftProtected: true });
        }
        if (conflictDetectedRef.current && rawProjectRef.current?.id === project.id) setSaveStatus('conflict');
      });
    }
    if (partial && stored && !partial.draftProtected) {
      partialSyncPendingRef.current = { ...partial, draftProtected: true };
      setPartialSyncIssue({ projectId: project.id, draftProtected: true });
    }
    return stored;
  }, [partialSyncPendingRef, conflictDetectedRef, rawProjectRef, setPartialSyncIssue, setSaveStatus]);

  const scheduleProjectDraft = useCallback((nextProject: Project, baseUpdatedAt: string | null) => {
    const pending = pendingDraftRef.current;
    if (pending && pending.project.id !== nextProject.id) {
      if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
      writeProtectedProjectDraft(pending.project, pending.baseUpdatedAt);
    }
    if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
    pendingDraftRef.current = { project: nextProject, baseUpdatedAt };
    draftWriteTimerRef.current = window.setTimeout(() => {
      const draft = pendingDraftRef.current;
      draftWriteTimerRef.current = null;
      pendingDraftRef.current = null;
      if (draft) {
        if (!supportsIndexedDbDrafts()) {
          writeProtectedProjectDraft(draft.project, draft.baseUpdatedAt);
          return;
        }
        const partial = partialSyncPendingRef.current?.projectId === draft.project.id
          ? partialSyncPendingRef.current : null;
        const candidate = createProjectDraft(draft.project, draft.baseUpdatedAt, {
          pendingNormalizedSync: !!partial,
          loadedCollections: partial?.loadedCollections ?? getLoadedProjectCollections(draft.project.id),
        });
        void writeIndexedDbProjectDraft(candidate).then(confirmed => {
          if (!confirmed) writeProtectedProjectDraft(draft.project, draft.baseUpdatedAt);
        });
      }
    }, LOCAL_DRAFT_DEBOUNCE_MS);
  }, [partialSyncPendingRef, writeProtectedProjectDraft]);

  const discardProjectDraft = useCallback((projectId: string) => {
    cancelScheduledDraft(projectId);
    clearProjectDraft(projectId);
  }, [cancelScheduledDraft]);

  useEffect(() => () => cancelScheduledDraft(), [cancelScheduledDraft]);

  return { pendingDraftRef, cancelScheduledDraft, writeProtectedProjectDraft,
    scheduleProjectDraft, discardProjectDraft };
}
