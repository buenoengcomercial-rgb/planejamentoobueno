import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { applyProjectOperation, undoProjectOperation } from './projectOperations';

const base = { id: 'p', phases: [{ id: 'c', tasks: [{ id: 't', startDate: '2026-10-01', dailyLogs: [] }] }], measurements: [1, 2, 3].map(number => ({ id: `m${number}`, number, startDate: `2026-${number + 9}-01`, items: [{ qtyProposed: number }] })) } as unknown as Project;
describe('isolamento dos módulos e desfazer', () => {
  it('rebaseia planejamento antigo sem perder os lançamentos ou as três medições', () => {
    const latest = structuredClone(base);
    latest.phases[0].tasks[0].dailyLogs = [{ id: 'l', date: '', actualQuantity: 3, plannedQuantity: 0 }];
    const stale = structuredClone(base); stale.phases[0].tasks[0].startDate = '2026-11-01'; stale.measurements = [];
    const result = applyProjectOperation('gantt', latest, base, stale);
    expect(result.phases[0].tasks[0].dailyLogs).toEqual(latest.phases[0].tasks[0].dailyLogs);
    expect(result.measurements).toEqual(base.measurements);
    expect(result.phases[0].tasks[0].startDate).toBe('2026-11-01');
  });
  it('desfaz somente o planejamento, conservando registros criados depois', () => {
    const after = structuredClone(base); after.phases[0].tasks[0].startDate = '2026-11-01';
    const current = structuredClone(after); current.measurements![0].items[0].qtyProposed = 30;
    const restored = undoProjectOperation('gantt', current, { before: base, after });
    expect(restored.phases[0].tasks[0].startDate).toBe('2026-10-01');
    expect(restored.measurements).toEqual(current.measurements);
  });
  it('bloqueia desfazer quando o mesmo campo sofreu outra alteração', () => {
    const after = structuredClone(base); after.phases[0].tasks[0].startDate = '2026-11-01';
    const current = structuredClone(after); current.phases[0].tasks[0].startDate = '2026-12-01';
    expect(() => undoProjectOperation('gantt', current, { before: base, after })).toThrow('alteração posterior');
  });
  it('aditivo não pode gravar execução nem trocar snapshots', () => {
    const candidate = structuredClone(base); candidate.phases[0].tasks[0].dailyLogs = [{ id: 'fake', date: '', actualQuantity: 99, plannedQuantity: 0 }]; candidate.measurements![0].items[0].qtyProposed = 0;
    expect(applyProjectOperation('additiveSchedule', base, base, candidate)).toEqual(base);
  });
});
