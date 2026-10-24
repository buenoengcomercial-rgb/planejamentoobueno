import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { toast } from 'sonner';
import type { AppView, Project } from '@/types/project';
import type { AuditUserInfo } from '@/lib/audit';
import { logToProject } from '@/lib/audit';
import { auditProjectReversal } from '@/lib/projectOperations';
import { applyUndoOperation, createUndoOperation, type UndoOperation } from '@/lib/operationUndo';
import { auditUndoProductionDeletions, assertProductionDeletionSafe, productionDeletionState } from '@/lib/productionDeletionSafety';

const UNDO_LIMIT = 20;

export type UndoStacks = Record<AppView, UndoOperation[]>;

export function emptyUndoStacks(): UndoStacks {
  return {
    dashboard: [], management: [], gantt: [], tasks: [], measurement: [],
    dailyReport: [], additive: [], additiveSchedule: [], realCost: [],
    materials: [], warehouse: [],
  };
}

export function recordProjectUndo(stacks: UndoStacks, view: AppView, before: Project, after: Project): void {
  const stack = stacks[view];
  stack.push(createUndoOperation(before, after));
  if (stack.length > UNDO_LIMIT) stack.shift();
}

export function canUndoProjectChange(stacks: UndoStacks, view: AppView): boolean {
  return view !== 'warehouse' && view !== 'dailyReport' && stacks[view].length > 0;
}

export interface ProjectUndoContext {
  undoStacksRef: MutableRefObject<UndoStacks>;
  rawProjectRef: MutableRefObject<Project | null>;
  productionCaptureBusyRef: MutableRefObject<boolean>;
  conflictDetectedRef: MutableRefObject<boolean>;
  partialSyncPendingRef: MutableRefObject<{ projectId: string } | null>;
  currentProjectUpdatedAtRef: MutableRefObject<string | null>;
  auditActor: AuditUserInfo;
  markLocalProjectChanges: (before: Project, after: Project) => void;
  writeProtectedProjectDraft: (project: Project, baseUpdatedAt: string | null) => void;
  setRawProject: Dispatch<SetStateAction<Project | null>>;
  markUndoChanged: () => void;
}

/** Reverses only the recorded fields after checking the current project and sync guards. */
export function undoProjectChange(view: AppView, context: ProjectUndoContext): void {
  const {
    undoStacksRef, rawProjectRef, productionCaptureBusyRef, conflictDetectedRef,
    partialSyncPendingRef, currentProjectUpdatedAtRef, auditActor,
    markLocalProjectChanges, writeProtectedProjectDraft, setRawProject, markUndoChanged,
  } = context;
  if (productionCaptureBusyRef.current) { toast.error('Aguarde a captura em andamento antes de desfazer.'); return; }
  if (conflictDetectedRef.current) {
    toast.error('Resolva a divergência entre a cópia local e a nuvem antes de desfazer.');
    return;
  }
  if (partialSyncPendingRef.current?.projectId === rawProjectRef.current?.id) {
    toast.error('A sincronização detalhada ainda está pendente. Confirme-a antes de desfazer.');
    return;
  }
  const stack = undoStacksRef.current[view];
  if (stack.length === 0) { toast.message('Nada para desfazer'); return; }
  const operation = stack[stack.length - 1];
  const current = rawProjectRef.current;
  if (!operation || !current) return;
  // These areas reverse through their own audited commands.
  if (view === 'warehouse' || view === 'dailyReport') {
    toast.warning('Use a correção ou o cancelamento específico desta área para preservar o histórico.');
    return;
  }
  try {
    let next = auditUndoProductionDeletions(current, applyUndoOperation(current, operation), auditActor);
    next = auditProjectReversal(current, next, auditActor);
    next = logToProject(next, { ...auditActor, entityType: 'project', entityId: current.id, action: 'updated', title: 'Operação desfeita', metadata: { view, changedFields: operation.changes.map(change => change.path) } });
    assertProductionDeletionSafe(productionDeletionState(current), productionDeletionState(next), current);
    markLocalProjectChanges(current, next);
    writeProtectedProjectDraft(next, currentProjectUpdatedAtRef.current);
    stack.pop(); rawProjectRef.current = next; setRawProject(next);
    markUndoChanged();
    toast.success('Alteração desfeita');
  } catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível desfazer com segurança.'); }
}
