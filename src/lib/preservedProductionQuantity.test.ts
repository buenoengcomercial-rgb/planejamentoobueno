import { describe, expect, it } from 'vitest';
import type { DailyProductionLog, Project, Task } from '@/types/project';
import { detailTotal, editableQuantityRows } from './productionQuantityDetails';
import { changeQuantityRows, makeQuantityClipboard, pasteQuantityRow } from './productionQuantityReferences';
import { quantityForMeasurement } from './productionMeasurementPeriods';

const daily: DailyProductionLog = { id: 'old-day', date: '2026-09-21', actualQuantity: 221, plannedQuantity: 15, notes: 'Nota antiga', laborEntries: [{ id: 'worker', workerName: 'Equipe original', role: 'Eletricista', hours: 8, hourlyCost: 10 }] };
function project(): Project {
  const task = (id: string, log: DailyProductionLog): Task => ({ id, name: id, phase: 'building', startDate: '2026-08-24', duration: 23, quantity: 360, unit: 'un', percentComplete: 0, dependencies: [], responsible: '', materials: [], level: 0, dailyLogs: [log] });
  return { id: 'preserved-project', name: 'Teste', startDate: '2026-08-24', endDate: '2026-09-22', totalBudget: 0, phases: [{ id: 'building', name: 'Prédio', color: '#333333', tasks: [task('first', structuredClone(daily)), task('second', { id: 'second-day', date: daily.date, actualQuantity: 0, plannedQuantity: 15 })] }], measurementDraft: { number: 1, startDate: '2026-08-24', endDate: '2026-09-22' } };
}
const log = (p: Project, index = 0) => p.phases[0].tasks[index].dailyLogs![0];
const address = { taskId: 'first', logId: daily.id };
const actor = { userId: 'engineer', userName: 'Engenheira' };

describe('quantidade diária preservada no detalhe editável', () => {
  it('projeta quantidade em A e data no comentário sem mutar, duplicar ou inventar período', () => {
    const original = structuredClone(daily);
    const rows = editableQuantityRows(daily);
    expect(rows[0]).toMatchObject({ id: 'preserved-old-day', comment: 'Dado preservado · 21/09/2026', formula: 'STANDARD', multiplier: 221, measuredQuantity: 0, dimensionC: 0, dimensionD: 0 });
    expect(detailTotal(rows)).toBe(221);
    expect(editableQuantityRows(JSON.parse(JSON.stringify(daily)))).toEqual(rows);
    expect(daily).toEqual(original);
  });
  it('não substitui fórmulas, comentários, fontes ou detalhes já existentes', () => {
    const row = { ...editableQuantityRows(daily)[0], comment: 'Original', multiplierSource: { planId: 'plan', planName: 'Planta', page: 1, measureId: 'mark', measureName: 'Pontos', kind: 'count' as const, points: [{ x: 1, y: 2 }] } };
    const recorded = { ...daily, quantityDetails: [row] };
    expect(editableQuantityRows(recorded)).toBe(recorded.quantityDetails);
    expect(editableQuantityRows({ ...daily, actualQuantity: 0 })).toEqual([]);
    expect(editableQuantityRows({ ...daily, measurementPeriod: { number: 1, startDate: '2026-08-24', endDate: '2026-09-22' } })).toEqual([]);
  });
  it('materializa somente o registro editado, preserva data, mão de obra e auditoria com antes/depois', () => {
    const p = project(); const before = JSON.stringify(p);
    const rows = editableQuantityRows(log(p)).map(row => ({ ...row, multiplier: 220 }));
    const changed = changeQuantityRows(p, address, rows, actor).project!;
    expect(log(changed)).toMatchObject({ ...daily, actualQuantity: 220, quantityDetailsAppliedTotal: 220 });
    expect(log(changed, 1)).toEqual(log(p, 1));
    expect(log(changed).measurementPeriod).toBeUndefined();
    expect(changed.auditLogs?.[0]).toMatchObject({ userId: actor.userId, before: daily, after: { actualQuantity: 220 }, metadata: { logId: daily.id, affectedTaskIds: ['first'] } });
    expect(JSON.stringify(p)).toBe(before);
    const reloaded = JSON.parse(JSON.stringify(changed)) as Project;
    expect(editableQuantityRows(log(reloaded))).toHaveLength(1);
    expect(quantityForMeasurement([log(reloaded)], '2026-08-24', '2026-09-22', 1).period).toBe(220);
  });
  it('exclui a linha preservada com auditoria recuperável, sem reaparecer após recarga', () => {
    const p = project(); const deleted = changeQuantityRows(p, address, [], actor).project!;
    expect(log(deleted)).toMatchObject({ id: daily.id, date: daily.date, actualQuantity: 0, quantityDetails: [], quantityDetailsAppliedTotal: 0 });
    expect(deleted.auditLogs?.[0].before).toMatchObject({ actualQuantity: 221, date: daily.date });
    expect(editableQuantityRows(log(JSON.parse(JSON.stringify(deleted))))).toEqual([]);
  });
  it('bloqueia aumento acima do contrato e edição fiscal/perfil sem escrita parcial', () => {
    const p = project(); const before = JSON.stringify(p);
    const rows = editableQuantityRows(log(p)).map(row => ({ ...row, multiplier: 361 }));
    expect(changeQuantityRows(p, address, rows, actor).project).toBeUndefined();
    expect(changeQuantityRows(p, address, editableQuantityRows(log(p)), actor, true).project).toBeUndefined();
    expect(JSON.stringify(p)).toBe(before);
    p.measurements = [{ id: 'm1', number: 1, startDate: '2026-08-24', endDate: '2026-09-22', issueDate: '2026-09-22', status: 'approved', bdiPercent: 0, items: [] }];
    expect(changeQuantityRows(p, address, [], actor).error).toContain('aprovada');
  });
  it.each(['copy', 'reference', 'cut'] as const)('permite %s de linha preservada usando as operações existentes', mode => {
    const p = project(); const row = editableQuantityRows(log(p))[0];
    const clipboard = makeQuantityClipboard(p.id, mode, { ...address, rowId: row.id }, 'un', row);
    const pasted = pasteQuantityRow(p, clipboard, { taskId: 'second', logId: 'second-day' }, actor).project!;
    expect(log(pasted, 1).actualQuantity).toBe(221);
    expect(log(pasted).actualQuantity).toBe(mode === 'cut' ? 0 : 221);
    expect(log(pasted).date).toBe(daily.date);
    if (mode === 'reference') {
      const edited = changeQuantityRows(pasted, address, log(pasted).quantityDetails!.map(row => ({ ...row, multiplier: 220 })), actor).project!;
      expect(log(edited, 1).actualQuantity).toBe(220);
    }
  });
});
