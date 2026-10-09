import { describe, expect, it } from 'vitest';
import type { Project, AuditLog } from '@/types/project';
import { assertProductionDeletionSafe, productionDeletionState } from './productionDeletionSafety';
const base = () => ({ id: 'fake', phases: [{ id: 'p', tasks: [{ id: 't', percentComplete: 0, dailyLogs: [{ id: 'l', date: '2026-09-21', actualQuantity: 5 }] }] }], auditLogs: [] } as unknown as Project);
const check = (before: Project, after: Project) => assertProductionDeletionSafe(productionDeletionState(before), productionDeletionState(after), before);
describe('production deletion intent', () => {
  it('rejects missing logs and missing tasks without issuing writes', () => {
    const before = base(), after = structuredClone(before);
    after.phases[0].tasks[0].dailyLogs = [];
    expect(() => check(before, after)).toThrow('Exclusão bloqueada');
    after.phases[0].tasks = [];
    expect(() => check(before, after)).toThrow();
  });
  it('allows a new explicit individual correction deletion but rejects stale intent', () => {
    const before = base(), after = structuredClone(before);
    after.phases[0].tasks[0].dailyLogs = [];
    const audit: AuditLog = { id: 'a', title: 'Correção fictícia', at: '2026-10-09T00:00:00Z', entityType: 'task', entityId: 't', action: 'deleted', before: before.phases[0].tasks[0].dailyLogs?.[0], metadata: { logId: 'l' } };
    after.auditLogs = [audit];
    expect(() => check(before, after)).not.toThrow();
    before.auditLogs = [audit];
    expect(() => check(before, after)).toThrow();
  });
  it('does not let an explicit task deletion erase production', () => {
    const before = base(), after = structuredClone(before);
    after.phases[0].tasks = [];
    after.auditLogs = [{ id: 'a', entityType: 'task', entityId: 't', action: 'deleted' }] as AuditLog[];
    expect(() => check(before, after)).toThrow();
  });
  it('preserves date and quantity when only scheduling changes', () => {
    const before = base(), after = structuredClone(before);
    after.phases[0].tasks[0].startDate = '2026-10-10';
    expect(() => check(before, after)).not.toThrow();
    expect(after.phases[0].tasks[0].dailyLogs).toEqual(before.phases[0].tasks[0].dailyLogs);
  });
  it('blocks deleting an otherwise empty task referenced by another domain', () => {
    const before = base(); before.phases[0].tasks[0].dailyLogs = [];
    const after = structuredClone(before); after.phases[0].tasks = [];
    after.auditLogs = [{ id: 'a', entityType: 'task', entityId: 't', action: 'deleted' }] as AuditLog[];
    const linked = { ...before, measurements: [{ taskId: 't' }] } as unknown as Project;
    expect(() => assertProductionDeletionSafe(productionDeletionState(before), productionDeletionState(after), linked)).toThrow();
  });
});