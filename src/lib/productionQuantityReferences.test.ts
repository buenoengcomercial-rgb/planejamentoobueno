import { describe, expect, it } from 'vitest';
import type { DailyProductionLog, ProductionQuantityDetail, Project, Task } from '@/types/project';
import { changeQuantityRows, makeQuantityClipboard, pasteQuantityRow, recalibrateQuantitySources, referencedTakeoffMeasureIds, sharedTaskNames } from './productionQuantityReferences';

const row = (id: string, amount: number): ProductionQuantityDetail => ({ id, location: '', comment: 'Placas', formula: 'STANDARD', multiplier: 0, measuredQuantity: amount, dimensionC: 0, dimensionD: 0 });
const day = (id: string, actual: number, rows: ProductionQuantityDetail[] = []): DailyProductionLog => ({ id, date: '2026-10-02', plannedQuantity: 40, actualQuantity: actual, quantityDetails: rows, ...(rows.length ? { quantityDetailsAppliedTotal: actual } : {}) });
function task(id: string, name: string, quantity: number, logs: DailyProductionLog[], unit = 'UND'): Task {
  return { id, name, phase: 'building', startDate: '2026-10-01', duration: 10, dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0, quantity, unit, dailyLogs: logs };
}
function project(firstLimit = 100, secondLimit = 100, secondUnit = 'UND'): Project {
  return { id: 'project-1', phases: [{ id: 'building', name: 'Prédio', tasks: [
    task('task-a', 'Instalação', firstLimit, [day('day-a', 29, [row('row-29', 29)])]),
    task('task-b', 'Conferência', secondLimit, [day('day-b', 0)], secondUnit),
  ] }] } as unknown as Project;
}
const getTask = (p: Project, id: string) => p.phases[0].tasks.find(task => task.id === id)!;
const getRows = (p: Project, taskId: string) => getTask(p, taskId).dailyLogs![0].quantityDetails!;
const actor = { userId: 'engineer-1', userName: 'Engenheira' };

describe('registro de quantitativos compartilhados', () => {
  it('bloqueia atomicamente a edição se uma referência pertence a medição em fiscalização', () => {
    let current = project();
    const source = { taskId: 'task-a', logId: 'day-a', rowId: 'row-29' };
    current = pasteQuantityRow(current, makeQuantityClipboard(current.id, 'reference', source, 'UND', getRows(current, 'task-a')[0]), { taskId: 'task-b', logId: 'day-b' }, actor).project!;
    current.measurements = [{ id: 'measurement-1', number: 1, startDate: '2026-09-01', endDate: '2026-09-30', status: 'in_review', items: [] }] as Project['measurements'];
    getTask(current, 'task-b').dailyLogs![0].measurementPeriod = { measurementId: 'measurement-1', number: 1, startDate: '2026-09-01', endDate: '2026-09-30' };
    getTask(current, 'task-b').dailyLogs![0].date = '';
    const before = JSON.stringify(current);
    const result = changeQuantityRows(current, source, [{ ...getRows(current, 'task-a')[0], measuredQuantity: 30 }], actor);
    expect(result.project).toBeUndefined();
    expect(result.error).toContain('Conferência');
    expect(result.error).toContain('fiscalização');
    expect(JSON.stringify(current)).toBe(before);
  });
  it('protege fontes de todas as colunas e dias, inclusive referências de outra tarefa', () => {
    const p = project();
    const source = (id: string) => ({ planId: 'plan', planName: 'Planta', page: 1, measureId: id, measureName: id, kind: 'count' as const, points: [{ x: 1, y: 1 }] });
    getRows(p, 'task-a')[0] = { ...row('all-columns', 1), multiplierSource: source('a'), source: source('b'), dimensionCSource: source('c'), dimensionDSource: source('d') };
    getTask(p, 'task-b').dailyLogs!.push(day('old-day', 1, [{ ...row('reference-copy', 1), sharedRecordId: 'shared', source: source('b') }, { ...row('legacy', 1), source: source('legacy') }]));
    expect(referencedTakeoffMeasureIds(JSON.parse(JSON.stringify(p)))).toEqual(['a', 'b', 'c', 'd', 'legacy']);
  });
  it('cópia normal de 29 é independente, enquanto cópia por referência acompanha 30, inclusive após recarga', () => {
    let current = project();
    const source = { taskId: 'task-a', logId: 'day-a', rowId: 'row-29' };
    const independent = makeQuantityClipboard(current.id, 'copy', source, 'UND', getRows(current, 'task-a')[0]);
    current = pasteQuantityRow(current, independent, { taskId: 'task-b', logId: 'day-b' }, actor).project!;
    expect(getRows(current, 'task-b')[0]).toMatchObject({ measuredQuantity: 29, sharedRecordId: undefined });
    const linked = makeQuantityClipboard(current.id, 'reference', source, 'UND', getRows(current, 'task-a')[0]);
    current = pasteQuantityRow(current, linked, { taskId: 'task-b', logId: 'day-b' }, actor).project!;
    const recordId = getRows(current, 'task-a')[0].sharedRecordId;
    expect(getRows(current, 'task-b')[1].sharedRecordId).toBe(recordId);
    expect(sharedTaskNames(current, recordId!)).toEqual(['Instalação', 'Conferência']);
    const edited = { ...getRows(current, 'task-a')[0], measuredQuantity: 30, comment: 'Placas executadas' };
    const result = changeQuantityRows(current, { taskId: 'task-a', logId: 'day-a' }, [edited], actor);
    expect(result.error).toBeUndefined();
    current = JSON.parse(JSON.stringify(result.project)) as Project;
    expect(getRows(current, 'task-b').map(item => item.measuredQuantity)).toEqual([29, 30]);
    expect(getRows(current, 'task-b')[1].comment).toBe('Placas executadas');
    expect(getTask(current, 'task-a').dailyLogs![0].actualQuantity).toBe(30);
    expect(getTask(current, 'task-b').dailyLogs![0].actualQuantity).toBe(59);
    const history = current.auditLogs!.at(-1)!;
    expect(history.userName).toBe('Engenheira');
    expect(history.before).toMatchObject({ quantityDetails: expect.arrayContaining([expect.objectContaining({ measuredQuantity: 29 })]) });
    expect(history.metadata?.affectedTaskNames).toEqual(['Instalação', 'Conferência']);
  });

  it('bloqueia toda a edição compartilhada se qualquer tarefa ultrapassar o saldo', () => {
    let current = project(100, 29);
    const source = { taskId: 'task-a', logId: 'day-a', rowId: 'row-29' };
    current = pasteQuantityRow(current, makeQuantityClipboard(current.id, 'reference', source, 'UND', getRows(current, 'task-a')[0]), { taskId: 'task-b', logId: 'day-b' }, actor).project!;
    const previous = JSON.stringify(current);
    const result = changeQuantityRows(current, { taskId: 'task-a', logId: 'day-a' }, [{ ...getRows(current, 'task-a')[0], measuredQuantity: 30 }], actor);
    expect(result.project).toBeUndefined();
    expect(result.error).toContain('Conferência');
    expect(JSON.stringify(current)).toBe(previous);
  });

  it('valida a permissão de cada tarefa afetada antes de alterar qualquer referência', () => {
    let current = project();
    const source = { taskId: 'task-a', logId: 'day-a', rowId: 'row-29' };
    current = pasteQuantityRow(current, makeQuantityClipboard(current.id, 'reference', source, 'UND', getRows(current, 'task-a')[0]), { taskId: 'task-b', logId: 'day-b' }, actor).project!;
    const result = changeQuantityRows(current, { taskId: 'task-a', logId: 'day-a' }, [{ ...getRows(current, 'task-a')[0], measuredQuantity: 30 }], actor, false, task => task.id !== 'task-b');
    expect(result.project).toBeUndefined();
    expect(result.error).toContain('Conferência');
    expect(getRows(current, 'task-a')[0].measuredQuantity).toBe(29);
    expect(getRows(current, 'task-b')[0].measuredQuantity).toBe(29);
  });

  it('recalibra células de várias tarefas em uma operação e bloqueia todas se uma ultrapassar o limite', () => {
    const marked = { ...row('length-row', 3), source: { planId: 'plan-1', planName: 'Térreo.dxf', page: 1, measureId: 'length-1', measureName: 'Trecho', kind: 'length' as const, points: [{ x: 0, y: 0 }, { x: 3, y: 0 }] } };
    const base = { id: 'project-length', phases: [{ id: 'building', name: 'Prédio', tasks: [
      task('task-a', 'Tubulação A', 10, [day('day-a', 3, [marked])], 'm'),
      task('task-b', 'Tubulação B', 5, [day('day-b', 3, [{ ...marked, id: 'length-row-b' }])], 'm'),
    ] }] } as unknown as Project;
    const rejected = recalibrateQuantitySources(base, 'plan-1', 1, 2, actor);
    expect(rejected.project).toBeUndefined();
    expect(rejected.error).toContain('Tubulação B');
    expect(getRows(base, 'task-a')[0].measuredQuantity).toBe(3);
    const revised = { ...base, phases: [{ ...base.phases[0], tasks: base.phases[0].tasks.map(item => ({ ...item, quantity: 10 })) }] } as Project;
    const accepted = recalibrateQuantitySources(revised, 'plan-1', 1, 2, actor);
    expect(accepted.error).toBeUndefined();
    expect(getRows(accepted.project!, 'task-a')[0].measuredQuantity).toBe(6);
    expect(getRows(accepted.project!, 'task-b')[0].measuredQuantity).toBe(6);
    expect(getRows(accepted.project!, 'task-a')[0].source?.resultUnit).toBe('m');
    expect(getTask(accepted.project!, 'task-a').dailyLogs![0].actualQuantity).toBe(6);
    expect(accepted.project!.auditLogs!.at(-1)!.metadata?.affectedTaskNames).toEqual(['Tubulação A', 'Tubulação B']);
    const restored = recalibrateQuantitySources(accepted.project!, 'plan-1', 1, null, actor);
    expect(getRows(restored.project!, 'task-a')[0].measuredQuantity).toBe(3);
    expect(getRows(restored.project!, 'task-a')[0].source?.resultUnit).toBe('u.d.');
  });

  it('propaga fórmula, valores e pontos, e excluir uma referência só desvincula aquela linha', () => {
    let current = project();
    const source = { taskId: 'task-a', logId: 'day-a', rowId: 'row-29' };
    current = pasteQuantityRow(current, makeQuantityClipboard(current.id, 'reference', source, 'UND', getRows(current, 'task-a')[0]), { taskId: 'task-b', logId: 'day-b' }, actor).project!;
    const changed = { ...getRows(current, 'task-b')[0], formula: 'A*B' as const, multiplier: 1, source: { planId: 'plan', planName: 'Pavimento.dxf', page: 1, measureId: 'measure', measureName: 'Placas', kind: 'count' as const, points: [{ x: 4, y: 5 }] } };
    current = changeQuantityRows(current, { taskId: 'task-b', logId: 'day-b' }, [changed], actor).project!;
    expect(getRows(current, 'task-a')[0]).toMatchObject({ formula: 'A*B', multiplier: 1, source: { points: [{ x: 4, y: 5 }] } });
    current = changeQuantityRows(current, { taskId: 'task-b', logId: 'day-b' }, [], actor).project!;
    expect(getRows(current, 'task-a')).toHaveLength(1);
    expect(getRows(current, 'task-a')[0].source?.points).toEqual([{ x: 4, y: 5 }]);
    expect(getRows(current, 'task-b')).toHaveLength(0);
    expect(getTask(current, 'task-a').dailyLogs![0].actualQuantity).toBe(29);
    expect(getTask(current, 'task-b').dailyLogs![0].actualQuantity).toBe(0);
  });

  it('recortar move a linha e a referência rejeita unidades distintas ou consulta somente leitura', () => {
    let current = project();
    const source = { taskId: 'task-a', logId: 'day-a', rowId: 'row-29' };
    const cut = makeQuantityClipboard(current.id, 'cut', source, 'UND', getRows(current, 'task-a')[0]);
    current = pasteQuantityRow(current, cut, { taskId: 'task-b', logId: 'day-b' }, actor).project!;
    expect(getRows(current, 'task-a')).toHaveLength(0);
    expect(getRows(current, 'task-b')[0].id).toBe('row-29');
    expect(getTask(current, 'task-a').dailyLogs![0].actualQuantity).toBe(0);
    expect(getTask(current, 'task-b').dailyLogs![0].actualQuantity).toBe(29);

    const mismatched = project(100, 100, 'm²');
    const reference = makeQuantityClipboard(mismatched.id, 'reference', source, 'UND', getRows(mismatched, 'task-a')[0]);
    expect(pasteQuantityRow(mismatched, reference, { taskId: 'task-b', logId: 'day-b' }, actor).error).toContain('Conferência');
    expect(pasteQuantityRow(mismatched, reference, { taskId: 'task-b', logId: 'day-b' }, actor, true).project).toBeUndefined();
  });
});
