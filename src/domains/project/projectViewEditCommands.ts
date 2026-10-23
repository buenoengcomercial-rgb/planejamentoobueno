import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { toast } from 'sonner';
import type { AppView, Project } from '@/types/project';
import type { OrgRole } from '@/lib/organizations';
import { applyProjectOperation } from '@/lib/projectOperations';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { createUndoOperation, type UndoOperation } from '@/lib/operationUndo';
import { assertProductionDeletionSafe, productionDeletionState } from '@/lib/productionDeletionSafety';

const UNDO_LIMIT = 20;

export interface ProjectViewEditContext {
  /** The projection used by the rendered area before a concurrent update. */
  renderedBase: Project | null;
  editor: boolean;
  dailyReportEditor: boolean;
  warehouseEditor: boolean;
  role: OrgRole | undefined;
  rawProjectRef: MutableRefObject<Project | null>;
  conflictDetectedRef: MutableRefObject<boolean>;
  productionCaptureBusyRef: MutableRefObject<boolean>;
  partialSyncPendingRef: MutableRefObject<{ projectId: string } | null>;
  lastSavedProjectJsonRef: MutableRefObject<string | null>;
  currentProjectUpdatedAtRef: MutableRefObject<string | null>;
  undoStacksRef: MutableRefObject<Record<AppView, UndoOperation[]>>;
  setRawProject: Dispatch<SetStateAction<Project | null>>;
  setUndoVersion: Dispatch<SetStateAction<number>>;
  markLocalProjectChanges: (before: Project, after: Project) => void;
  saveDailyReportDirectly: (before: Project, after: Project) => void;
  scheduleProjectDraft: (project: Project, baseUpdatedAt: string | null) => void;
  discardProjectDraft: (projectId: string) => void;
}

/** Applies a view's edit against the latest project without replacing other areas. */
export function createProjectViewSetter(view: AppView, context: ProjectViewEditContext) {
  const {
    renderedBase, editor, dailyReportEditor, warehouseEditor, role, rawProjectRef,
    conflictDetectedRef, productionCaptureBusyRef, partialSyncPendingRef,
    lastSavedProjectJsonRef, currentProjectUpdatedAtRef, undoStacksRef,
    setRawProject, setUndoVersion, markLocalProjectChanges, saveDailyReportDirectly,
    scheduleProjectDraft, discardProjectDraft,
  } = context;

  return (next: Project | ((prev: Project) => Project)): void => {
    const mayEditView = editor
      || (view === 'dailyReport' && dailyReportEditor)
      || (view === 'warehouse' && warehouseEditor);
    if (!mayEditView) {
      toast.error('Você não tem permissão para editar.');
      return;
    }
    if (view === 'dailyReport' && !navigator.onLine) {
      toast.error('Conecte-se à internet para editar o Diário de Obra.');
      return;
    }
    if (conflictDetectedRef.current && view !== 'dailyReport') {
      toast.error('A sincronização com a nuvem ainda não foi concluída. Recarregue a obra antes de editar.');
      return;
    }
    if (productionCaptureBusyRef.current) {
      toast.error('Aguarde a confirmação conjunta da planta e do quantitativo.');
      return;
    }
    if (partialSyncPendingRef.current?.projectId === rawProjectRef.current?.id) {
      toast.error('A sincronização detalhada ainda está pendente. Aguarde a confirmação antes de fazer outra alteração.');
      return;
    }

    setRawProject(prev => {
      if (!prev) return prev;
      const candidate = typeof next === 'function' ? next(prev) : next;
      let resolved: Project;
      try {
        resolved = role === 'warehouse_operator' && view === 'warehouse'
          ? { ...prev, warehouse: candidate.warehouse }
          : applyProjectOperation(view, prev, typeof next === 'function' ? prev : (renderedBase ?? prev), candidate);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'A alteração conflita com o estado atual.');
        return prev;
      }
      if (resolved === prev) return prev;
      // An identical projection must not restart autosave or create an undo entry.
      const synchronizedJson = serializeProject(resolved);
      if (synchronizedJson === serializeProject(prev)) return prev;
      try {
        assertProductionDeletionSafe(productionDeletionState(prev), productionDeletionState(resolved), prev);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Exclusão bloqueada.');
        return prev;
      }
      markLocalProjectChanges(prev, resolved);
      const stack = undoStacksRef.current[view];
      stack.push(createUndoOperation(prev, resolved));
      if (stack.length > UNDO_LIMIT) stack.shift();
      rawProjectRef.current = resolved;
      if (view === 'dailyReport') {
        saveDailyReportDirectly(prev, resolved);
      } else if (synchronizedJson !== lastSavedProjectJsonRef.current) {
        scheduleProjectDraft(resolved, currentProjectUpdatedAtRef.current);
      } else {
        discardProjectDraft(resolved.id);
      }
      setUndoVersion(v => v + 1);
      return resolved;
    });
  };
}
