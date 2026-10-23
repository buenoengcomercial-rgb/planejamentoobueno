import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { createProjectViewSetter, type ProjectViewEditContext } from './projectViewEditCommands';

const messages = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: messages.error } }));

function project(): Project {
  return {
    id: 'obra-1', name: 'Obra', startDate: '2026-10-01', endDate: '2026-12-01',
    totalBudget: 0,
    phases: [{ id: 'capitulo-1', tasks: [{ id: 'tarefa-1', startDate: '2026-10-01', dailyLogs: [] }] }],
    dailyReports: [{ id: 'diario-1', date: '2026-10-20', observations: 'Inicial' }],
    warehouse: { items: [] }, additives: [], measurements: [],
  } as Project;
}

function setup(current = project(), overrides: Partial<ProjectViewEditContext> = {}) {
  let state: Project | null = current;
  const context: ProjectViewEditContext = {
    renderedBase: current,
    editor: true,
    dailyReportEditor: false,
    warehouseEditor: false,
    role: 'owner',
    rawProjectRef: { current },
    conflictDetectedRef: { current: false },
    productionCaptureBusyRef: { current: false },
    partialSyncPendingRef: { current: null },
    lastSavedProjectJsonRef: { current: JSON.stringify(current) },
    currentProjectUpdatedAtRef: { current: 'v1' },
    undoStacksRef: { current: {
      dashboard: [], management: [], gantt: [], tasks: [], measurement: [],
      dailyReport: [], additive: [], additiveSchedule: [], realCost: [], materials: [], warehouse: [],
    } },
    setRawProject: updater => {
      state = typeof updater === 'function' ? updater(state) : updater;
    },
    setUndoVersion: vi.fn(),
    markLocalProjectChanges: vi.fn(),
    saveDailyReportDirectly: vi.fn(),
    scheduleProjectDraft: vi.fn(),
    discardProjectDraft: vi.fn(),
    ...overrides,
  };
  return { context, current: () => state };
}

afterEach(() => { vi.restoreAllMocks(); messages.error.mockClear(); });

describe('comandos de edição por aba', () => {
  it('aplica só o planejamento e preserva um Diário recebido depois da base renderizada', () => {
    const base = project();
    const current = structuredClone(base);
    current.dailyReports![0].observations = 'Outra pessoa';
    const { context, current: read } = setup(current, { renderedBase: base });
    const candidate = structuredClone(base);
    candidate.phases[0].tasks[0].startDate = '2026-11-01';

    createProjectViewSetter('gantt', context)(candidate);

    expect(read()?.phases[0].tasks[0].startDate).toBe('2026-11-01');
    expect(read()?.dailyReports?.[0]?.observations).toBe('Outra pessoa');
    expect(context.scheduleProjectDraft).toHaveBeenCalledWith(read(), 'v1');
    expect(context.undoStacksRef.current.gantt).toHaveLength(1);
  });

  it('nega edição sem permissão antes de alterar estado ou criar rascunho', () => {
    const { context, current } = setup(project(), { editor: false, role: 'viewer' });
    const before = current();

    createProjectViewSetter('additive', context)({ ...before!, name: 'Indevido' });

    expect(current()).toBe(before);
    expect(context.scheduleProjectDraft).not.toHaveBeenCalled();
    expect(messages.error).toHaveBeenCalledWith('Você não tem permissão para editar.');
  });

  it('limita o operador do Almoxarifado aos dados de estoque', () => {
    const { context, current } = setup(project(), {
      editor: false, warehouseEditor: true, role: 'warehouse_operator',
    });
    const candidate = { ...current()!, name: 'Não autorizado', warehouse: { items: [{ key: 'item-1' }] } } as Project;

    createProjectViewSetter('warehouse', context)(candidate);

    expect(current()?.name).toBe('Obra');
    expect(current()?.warehouse?.items).toEqual([{ key: 'item-1' }]);
    expect(context.scheduleProjectDraft).toHaveBeenCalledOnce();
  });

  it('ignora objeto novo com conteúdo idêntico sem criar autosave ou desfazer', () => {
    const { context, current } = setup();
    const before = current();

    createProjectViewSetter('gantt', context)(structuredClone(before!));

    expect(current()).toBe(before);
    expect(context.scheduleProjectDraft).not.toHaveBeenCalled();
    expect(context.undoStacksRef.current.gantt).toHaveLength(0);
  });

  it('envia o Diário pelo salvamento da data sem agendar autosave geral', () => {
    const { context, current } = setup(project(), {
      editor: false, dailyReportEditor: true, role: 'field_user',
    });
    const candidate = structuredClone(current()!);
    candidate.dailyReports![0].observations = 'Registro de campo';

    createProjectViewSetter('dailyReport', context)(candidate);

    expect(current()?.dailyReports?.[0]?.observations).toBe('Registro de campo');
    expect(context.saveDailyReportDirectly).toHaveBeenCalledOnce();
    expect(context.scheduleProjectDraft).not.toHaveBeenCalled();
  });

  it('bloqueia nova edição enquanto uma sincronização parcial está pendente', () => {
    const { context, current } = setup(project(), {
      partialSyncPendingRef: { current: { projectId: 'obra-1' } },
    });
    const before = current();

    createProjectViewSetter('gantt', context)({ ...before!, name: 'Indevido' });

    expect(current()).toBe(before);
    expect(context.scheduleProjectDraft).not.toHaveBeenCalled();
    expect(messages.error).toHaveBeenCalledWith(expect.stringContaining('sincronização detalhada'));
  });

  it('bloqueia edição durante conflito sem descartar a obra em memória', () => {
    const { context, current } = setup(project(), { conflictDetectedRef: { current: true } });
    const before = current();

    createProjectViewSetter('gantt', context)({ ...before!, name: 'Indevido' });

    expect(current()).toBe(before);
    expect(context.scheduleProjectDraft).not.toHaveBeenCalled();
    expect(messages.error).toHaveBeenCalledWith(expect.stringContaining('sincronização com a nuvem'));
  });
});
