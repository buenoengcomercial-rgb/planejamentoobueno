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
  it('Medição e Almoxarifado não substituem coleções um do outro por fotografia parcial', () => {
    const current = {
      ...base,
      warehouse: { movements: [{ id: 'entrada-1', quantity: 8 }] },
    } as unknown as Project;
    const partialMeasurement = { ...current, warehouse: { movements: [] }, measurements: [] } as unknown as Project;
    const savedMeasurement = applyProjectOperation('measurement', current, current, partialMeasurement);
    expect(savedMeasurement.warehouse).toEqual(current.warehouse);
    expect(savedMeasurement.measurements).toEqual([]);

    const partialWarehouse = { ...current, warehouse: { movements: [{ id: 'entrada-2', quantity: 3 }] }, measurements: [] } as unknown as Project;
    const savedWarehouse = applyProjectOperation('warehouse', current, current, partialWarehouse);
    expect(savedWarehouse.measurements).toEqual(current.measurements);
    expect(savedWarehouse.warehouse?.movements).toEqual([{ id: 'entrada-2', quantity: 3 }]);
  });
  it('mantém a publicação auditada da retirada no Diário durante a migração de domínio', () => {
    const current = { ...base, dailyReports: [] } as unknown as Project;
    const report = { id: 'daily-1', date: '2026-10-20', requisitionIds: ['req-1'] };
    const next = applyProjectOperation('warehouse', current, current, {
      ...current,
      dailyReports: [report],
    } as unknown as Project);
    expect(next.dailyReports).toEqual([report]);
  });
});
