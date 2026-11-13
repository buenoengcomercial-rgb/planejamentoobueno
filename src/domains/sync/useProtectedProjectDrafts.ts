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
  savedProjectJsonRef?: RefObject<string | null>;
  projectUpdatedAtRef?: RefObject<string | null>;
  setPartialSyncIssue: Dispatch<SetStateAction<PartialSyncIssue | null>>;
  setSaveStatus: Dispatch<SetStateAction<SaveStatus>>;
}

/** Protege rascunhos do projeto sem confirmar qualquer gravação na nuvem. */
export function useProtectedProjectDrafts({
  partialSyncPendingRef, conflictDetectedRef, rawProjectRef,
  savedProjectJsonRef, projectUpdatedAtRef,
  setPartialSyncIssue, setSaveStatus,
}: ProtectedProjectDraftOptions) {
  const activeDraftWrites = useRef(new Map<string, object>());
  const draftWriteTimerRef = useRef<number | null>(null);
  const pendingDraftRef = useRef<{ project: Project; baseUpdatedAt: string | null; baseProject: Project | null } | null>(null);

  const confirmedAncestor = useCallback((project: Project, baseUpdatedAt: string | null): Project | null => {
    if (!savedProjectJsonRef?.current || projectUpdatedAtRef?.current !== baseUpdatedAt) return null;
    try {
      const ancestor = JSON.parse(savedProjectJsonRef.current) as Project;
      return ancestor.id === project.id ? ancestor : null;
    } catch { return null; }
  }, [savedProjectJsonRef, projectUpdatedAtRef]);

  const cancelScheduledDraft = useCallback((projectId?: string) => {
    const pending = pendingDraftRef.current;
    if (!pending || (projectId && pending.project.id !== projectId)) return;
    if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
    draftWriteTimerRef.current = null;
    pendingDraftRef.current = null;
  }, []);

  const writeProtectedProjectDraft = useCallback((project: Project, baseUpdatedAt: string | null, baseProject = confirmedAncestor(project, baseUpdatedAt)) => {
    const write = {};
    activeDraftWrites.current.set(project.id, write);
    const partial = partialSyncPendingRef.current?.projectId === project.id
      ? partialSyncPendingRef.current
      : null;
    const loadedCollections = partial?.loadedCollections ?? getLoadedProjectCollections(project.id);
    const stored = writeProjectDraft(project, baseUpdatedAt, undefined, partial ? {
      pendingNormalizedSync: true, baseProject,
      loadedCollections,
    } : { loadedCollections, baseProject });
    if (!stored && supportsIndexedDbDrafts()) {
      const candidate = createProjectDraft(project, baseUpdatedAt, partial ? {
        pendingNormalizedSync: true, loadedCollections, baseProject,
      } : { loadedCollections, baseProject });
      void writeIndexedDbProjectDraft(candidate).then(confirmed => {
        if (activeDraftWrites.current.get(project.id) !== write || !confirmed) return;
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
  }, [partialSyncPendingRef, conflictDetectedRef, rawProjectRef, setPartialSyncIssue, setSaveStatus, confirmedAncestor]);

  const scheduleProjectDraft = useCallback((nextProject: Project, baseUpdatedAt: string | null) => {
    const pending = pendingDraftRef.current;
    if (pending && pending.project.id !== nextProject.id) {
      if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
      writeProtectedProjectDraft(pending.project, pending.baseUpdatedAt, pending.baseProject);
    }
    if (draftWriteTimerRef.current) window.clearTimeout(draftWriteTimerRef.current);
    pendingDraftRef.current = { project: nextProject, baseUpdatedAt, baseProject: confirmedAncestor(nextProject, baseUpdatedAt) };
    draftWriteTimerRef.current = window.setTimeout(() => {
      const draft = pendingDraftRef.current;
      draftWriteTimerRef.current = null;
      pendingDraftRef.current = null;
      if (draft) {
        if (!supportsIndexedDbDrafts()) {
          writeProtectedProjectDraft(draft.project, draft.baseUpdatedAt, draft.baseProject);
          return;
        }
        const partial = partialSyncPendingRef.current?.projectId === draft.project.id
          ? partialSyncPendingRef.current : null;
        const candidate = createProjectDraft(draft.project, draft.baseUpdatedAt, {
          pendingNormalizedSync: !!partial,
          loadedCollections: partial?.loadedCollections ?? getLoadedProjectCollections(draft.project.id),
          baseProject: draft.baseProject,
        });
        const write = {};
        activeDraftWrites.current.set(draft.project.id, write);
        void writeIndexedDbProjectDraft(candidate).then(confirmed => {
          // IndexedDB also returns null when a confirmation invalidates this write.
          if (!confirmed && activeDraftWrites.current.get(draft.project.id) === write) {
            writeProtectedProjectDraft(draft.project, draft.baseUpdatedAt, draft.baseProject);
          }
        });
      }
    }, LOCAL_DRAFT_DEBOUNCE_MS);
  }, [partialSyncPendingRef, writeProtectedProjectDraft, confirmedAncestor]);

  const discardProjectDraft = useCallback((projectId: string) => {
    cancelScheduledDraft(projectId);
    activeDraftWrites.current.delete(projectId);
    return clearProjectDraft(projectId);
  }, [cancelScheduledDraft]);

  useEffect(() => () => cancelScheduledDraft(), [cancelScheduledDraft]);

  return { pendingDraftRef, cancelScheduledDraft, writeProtectedProjectDraft,
    scheduleProjectDraft, discardProjectDraft };
}
