import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Project, SavedMeasurement, Task } from '@/types/project';
import { useMeasurementRows } from './useMeasurementRows';

const task = { id: 't', name: 'Placas', phase: 'p', startDate: '2026-10-01', duration: 10, dependencies: [], responsible: '', percentComplete: 0, materials: [], level: 0, quantity: 100, unit: 'UN', dailyLogs: [
  { id: 'legacy', date: '2026-09-10', plannedQuantity: 10, actualQuantity: 29 },
  { id: 'period', date: '', plannedQuantity: 0, actualQuantity: 3, measurementPeriod: { number: 2, startDate: '2026-10-01', endDate: '2026-10-31' } },
] } satisfies Task;
const project = { id: 'project', phases: [{ id: 'p', name: 'Prédio', color: '#000', tasks: [task] }], startDate: '2026-09-01', endDate: '2026-12-31', name: 'Teste', totalBudget: 0 } as Project;
const params = { project, measurements: [] as SavedMeasurement[], activeId: 'live', startDate: '2026-10-01', endDate: '2026-10-31', chapterFilter: 'all', search: '', issueDate: '2026-10-31', bdiPercent: 0, measurementNumber: '2' };
describe('Medição recebe a produção por período', () => {
  it('soma o período correto, preserva o anterior e reage a troca de número', () => {
    const { result, rerender } = renderHook(props => useMeasurementRows(props), { initialProps: params });
    expect(result.current.rows[0]).toMatchObject({ qtyPeriod: 3, qtyPriorAccum: 29, qtyCurrentAccum: 32 });
    rerender({ ...params, startDate: '2026-11-01', endDate: '2026-11-30', measurementNumber: '3' });
    expect(result.current.rows[0]).toMatchObject({ qtyPeriod: 0, qtyPriorAccum: 32 });
  });
  it('preserva o snapshot em fiscalização mesmo com produção posterior diferente', () => {
    const saved = { id: 'm1', number: 1, startDate: '2026-09-01', endDate: '2026-09-30', issueDate: '2026-09-30', bdiPercent: 0, status: 'in_review', items: [{ taskId: 't', phaseId: 'p', phaseChain: 'Prédio', item: '1.1', description: 'Placas', unit: 'UN', qtyContracted: 100, qtyProposed: 29, qtyPriorAccum: 0, unitPriceNoBDI: 10, unitPriceWithBDI: 10 }] } as SavedMeasurement;
    const { result } = renderHook(() => useMeasurementRows({ ...params, activeId: 'm1', measurements: [saved] }));
    expect(result.current.rows[0]).toMatchObject({ qtyPeriod: 29, qtyPriorAccum: 0, qtyCurrentAccum: 29 });
    expect(saved.items[0].qtyProposed).toBe(29);
  });
  it('não inclui snapshots de medições futuras no acumulado anterior', () => {
    const future = { id: 'm3', number: 3, status: 'generated', items: [{ taskId: 't', qtyProposed: 50 }] } as SavedMeasurement;
    const { result } = renderHook(() => useMeasurementRows({ ...params, measurements: [future] }));
    expect(result.current.rows[0]).toMatchObject({ qtyPeriod: 3, qtyPriorAccum: 29 });
  });
});
