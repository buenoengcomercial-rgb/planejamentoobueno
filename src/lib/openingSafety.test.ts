import { afterEach, describe, expect, it, vi } from 'vitest';
import { withReadDeadline } from './readDeadline';
import { projectCollectionsForView } from './projectDataScope';
import { createProjectDraft } from './cloudProjectDraftCore';
import type { Project } from '@/types/project';

afterEach(() => vi.useRealTimers());
describe('abertura sem histórico integral', () => {
  it('protege auditoria nova no rascunho offline mesmo sem histórico previamente carregado', () => {
    const project = { id: 'project-1', name: 'Obra', phases: [], auditLogs: [{ id: 'audit-new', entityType: 'task', entityId: 'task-1', at: '2026-10-09', action: 'updated', title: 'Nova alteração', before: 1, after: 2 }] } as unknown as Project;
    const draft = createProjectDraft(project, 'v1', { loadedCollections: ['eapChapters', 'tasks'] });
    expect(draft.loadedCollections).toContain('auditLogs');
    expect(draft.project.auditLogs).toEqual(project.auditLogs);
  });
  it.each(['dashboard', 'management', 'gantt', 'tasks', 'measurement', 'additive', 'additiveSchedule', 'realCost', 'materials', 'dailyReport'] as const)('%s não aguarda auditoria', view => {
    expect(projectCollectionsForView(view)).not.toContain('auditLogs');
  });
  it.each(['notas', 'requisicoes'] as const)('%s não baixa detalhes de auditoria', tab => {
    expect(projectCollectionsForView('warehouse', tab)).not.toContain('auditLogs');
  });
  it('encerra uma leitura que não responde', async () => {
    vi.useFakeTimers();
    const result = expect(withReadDeadline(new Promise(() => {}), 100)).rejects.toThrow('Tente novamente');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
