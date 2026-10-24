import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import {
  canUndoProjectChange, emptyUndoStacks, recordProjectUndo, undoProjectChange,
  type ProjectUndoContext,
} from './projectUndoController';

const messages = vi.hoisted(() => ({ error: vi.fn(), message: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: messages }));

function project(): Project {
  return {
    id: 'obra-1', name: 'Obra', phases: [{ id: 'capitulo', tasks: [{ id: 'tarefa', name: 'Original', duration: 2, dailyLogs: [] }] }],
    dailyReports: [{ id: 'diario', date: '2026-10-20', observations: 'Original' }],
    measurements: [], auditLogs: [],
  } as Project;
}

function setup(current: Project) {
  let rendered = current;
  const context: ProjectUndoContext = {
    undoStacksRef: { current: emptyUndoStacks() },
    rawProjectRef: { current },
    productionCaptureBusyRef: { current: false },
    conflictDetectedRef: { current: false },
    partialSyncPendingRef: { current: null },
    currentProjectUpdatedAtRef: { current: 'revision-1' },
    auditActor: { userId: 'editor-1' },
    markLocalProjectChanges: vi.fn(),
    writeProtectedProjectDraft: vi.fn(),
    setRawProject: update => { rendered = typeof update === 'function' ? update(rendered) as Project : update!; },
    markUndoChanged: vi.fn(),
  };
  return { context, rendered: () => rendered };
}

beforeEach(() => { Object.values(messages).forEach(mock => mock.mockClear()); });

describe('controlador de Desfazer por domínio', () => {
  it('reverte somente o campo editado e preserva outra aba e auditoria posterior', () => {
    const before = project();
    const after = structuredClone(before);
    after.phases[0].tasks[0].name = 'Alterado';
    const current = structuredClone(after);
    current.dailyReports![0].observations = 'Outra pessoa';
    const { context, rendered } = setup(current);
    recordProjectUndo(context.undoStacksRef.current, 'tasks', before, after);

    undoProjectChange('tasks', context);

    expect(rendered().phases[0].tasks[0].name).toBe('Original');
    expect(rendered().dailyReports?.[0].observations).toBe('Outra pessoa');
    expect(rendered().auditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'updated', title: 'Operação desfeita' }),
    ]));
    expect(context.writeProtectedProjectDraft).toHaveBeenCalledWith(rendered(), 'revision-1');
    expect(context.undoStacksRef.current.tasks).toHaveLength(0);
    expect(context.markUndoChanged).toHaveBeenCalledOnce();
  });

  it('mantém a pilha e o rascunho quando o mesmo campo mudou depois', () => {
    const before = project();
    const after = structuredClone(before);
    after.phases[0].tasks[0].name = 'Alterado';
    const current = structuredClone(after);
    current.phases[0].tasks[0].name = 'Edição posterior';
    const { context, rendered } = setup(current);
    recordProjectUndo(context.undoStacksRef.current, 'tasks', before, after);

    undoProjectChange('tasks', context);

    expect(rendered()).toBe(current);
    expect(context.undoStacksRef.current.tasks).toHaveLength(1);
    expect(context.writeProtectedProjectDraft).not.toHaveBeenCalled();
    expect(messages.error).toHaveBeenCalledWith(expect.stringContaining('mudou depois'));
  });

  it.each(['conflictDetectedRef', 'productionCaptureBusyRef'] as const)('bloqueia reversão quando %s está ativo', key => {
    const before = project(), after = { ...before, name: 'Alterado' };
    const { context } = setup(after);
    recordProjectUndo(context.undoStacksRef.current, 'dashboard', before, after);
    context[key].current = true;

    undoProjectChange('dashboard', context);

    expect(context.undoStacksRef.current.dashboard).toHaveLength(1);
    expect(context.writeProtectedProjectDraft).not.toHaveBeenCalled();
    expect(messages.error).toHaveBeenCalledOnce();
  });

  it('bloqueia sincronização parcial, outra obra e falha ao proteger o rascunho', () => {
    const before = project(), after = { ...before, name: 'Alterado' };
    const { context } = setup(after);
    recordProjectUndo(context.undoStacksRef.current, 'dashboard', before, after);
    context.partialSyncPendingRef.current = { projectId: after.id };
    undoProjectChange('dashboard', context);
    expect(context.undoStacksRef.current.dashboard).toHaveLength(1);
    context.partialSyncPendingRef.current = null;
    context.rawProjectRef.current = { ...after, id: 'outra-obra' };
    undoProjectChange('dashboard', context);
    expect(context.undoStacksRef.current.dashboard).toHaveLength(1);
    context.rawProjectRef.current = after;
    vi.mocked(context.writeProtectedProjectDraft).mockImplementationOnce(() => { throw new Error('Rascunho indisponível'); });
    undoProjectChange('dashboard', context);
    expect(context.undoStacksRef.current.dashboard).toHaveLength(1);
    expect(context.markUndoChanged).not.toHaveBeenCalled();
  });

  it('limita o histórico e reserva Diário e Almoxarifado para correções próprias', () => {
    const before = project(), after = { ...before, name: 'Alterado' };
    const { context } = setup(after);
    for (let i = 0; i < 21; i++) recordProjectUndo(context.undoStacksRef.current, 'dashboard', before, after);
    expect(context.undoStacksRef.current.dashboard).toHaveLength(20);
    recordProjectUndo(context.undoStacksRef.current, 'warehouse', before, after);
    recordProjectUndo(context.undoStacksRef.current, 'dailyReport', before, after);
    expect(canUndoProjectChange(context.undoStacksRef.current, 'dashboard')).toBe(true);
    expect(canUndoProjectChange(context.undoStacksRef.current, 'warehouse')).toBe(false);
    expect(canUndoProjectChange(context.undoStacksRef.current, 'dailyReport')).toBe(false);
    undoProjectChange('warehouse', context);
    expect(context.undoStacksRef.current.warehouse).toHaveLength(1);
    expect(context.writeProtectedProjectDraft).not.toHaveBeenCalled();
    expect(messages.warning).toHaveBeenCalledOnce();
  });
});
