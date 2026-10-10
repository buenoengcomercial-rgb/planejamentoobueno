import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { applyUndoOperation, createUndoOperation } from './operationUndo';
import { auditUndoProductionDeletions, assertProductionDeletionSafe, productionDeletionState } from './productionDeletionSafety';

const base = () => ({ id: 'fictional', name: 'Teste', phases: [{ id: 'p', tasks: [{ id: 't', name: 'Original', duration: 2, dailyLogs: [] }] }], measurements: [], auditLogs: [] } as unknown as Project);
describe('operation-scoped undo', () => {
  it('audits the inverse of a newly created empty task without replacing another area', () => {
    const before = base(), after = structuredClone(before);
    after.phases[0].tasks.push({ ...after.phases[0].tasks[0], id: 'new', percentComplete: 0 });
    const current = { ...after, name: 'Edição posterior' };
    const next = auditUndoProductionDeletions(current, applyUndoOperation(current, createUndoOperation(before, after)), {});
    expect(() => assertProductionDeletionSafe(productionDeletionState(current), productionDeletionState(next), current)).not.toThrow();
    expect(next.name).toBe('Edição posterior');
    expect(next.auditLogs).toEqual([expect.objectContaining({ entityType: 'task', entityId: 'new', action: 'deleted', metadata: { undo: true } })]);
  });
  it('preserves later changes to another field, another area and audit', () => {
    const before = base();
    const after = structuredClone(before);
    after.phases[0].tasks[0].name = 'Novo';
    const op = createUndoOperation(before, after);
    const current = structuredClone(after);
    current.name = 'Alterado depois';
    current.phases[0].tasks[0].duration = 5;
    current.auditLogs = [{ id: 'later' }] as Project['auditLogs'];
    const undone = applyUndoOperation(current, op);
    expect(undone.phases[0].tasks[0].name).toBe('Original');
    expect(undone.phases[0].tasks[0].duration).toBe(5);
    expect(undone.name).toBe('Alterado depois');
    expect(undone.auditLogs).toEqual(current.auditLogs);
    expect(current.phases[0].tasks[0].name).toBe('Novo');
  });
  it('rejects a later same-field edit atomically', () => {
    const before = base(), after = structuredClone(before);
    after.name = 'Primeira';
    after.phases[0].tasks[0].name = 'Novo';
    const current = { ...after, name: 'Posterior' };
    expect(() => applyUndoOperation(current, createUndoOperation(before, after))).toThrow('mudou');
    expect(current.phases[0].tasks[0].name).toBe('Novo');
  });
  it('does not remove a created record changed after creation', () => {
    const before = base(), after = structuredClone(before);
    after.phases[0].tasks.push({ ...after.phases[0].tasks[0], id: 'new' });
    const current = structuredClone(after);
    current.phases[0].tasks[1].name = 'Editado';
    expect(() => applyUndoOperation(current, createUndoOperation(before, after))).toThrow();
  });
  it('stores only changed values rather than the project', () => {
    const before = base(), after = { ...before, name: 'Outra' };
    expect(createUndoOperation(before, after).changes).toHaveLength(1);
    expect(JSON.stringify(createUndoOperation(before, after))).not.toContain('dailyLogs');
  });
});
