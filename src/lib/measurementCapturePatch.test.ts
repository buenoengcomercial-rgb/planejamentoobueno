import { describe, expect, it, vi } from 'vitest';
import { captureMeasurement, newMeasuredRow, type MeasurementWorkspace } from './measurementWorkspace';
import { measurementCapturePatch } from './measurementCapturePatch';

const actor = { id: 'engineer', name: 'Engenheira', canEdit: true };
const mark = (id: string) => ({
  id, name: id, kind: 'count' as const, page: 1, points: [{ x: 1, y: 2 }],
  projectId: 'project', measurementId: 'period', serviceId: 'target',
});
function workspace(): MeasurementWorkspace {
  return {
    schema: 1, projectId: 'project', projectName: 'Obra', revision: 7, backupId: 'backup',
    services: ['target', 'other'].map(id => ({ id, item: id, description: id, unit: 'UN',
      contracted: 100, priceNoBDI: 1, priceWithBDI: 1, bdi: 0, importedPrice: true,
      chapterId: 'chapter', chapter: 'Capítulo', path: 'Capítulo', availableFromNumber: 1 })),
    periods: [{ id: 'period', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'draft' }],
    entries: [
      { projectId: 'project', measurementId: 'period', serviceId: 'target', rows: [newMeasuredRow('row-1'), newMeasuredRow('row-2')] },
      { projectId: 'project', measurementId: 'period', serviceId: 'other', rows: [{ ...newMeasuredRow('other-row'), multiplier: 4 }] },
    ],
    plans: [
      { id: 'plan', name: 'Teste.dxf', floor: 'Térreo', kind: 'dxf', file: new Blob(), scales: { 1: 1 }, measures: [] },
      { id: 'other-plan', name: 'Outra.dxf', floor: '1º', kind: 'dxf', file: new Blob(), scales: { 1: 1 }, measures: [] },
    ],
    importedKeys: [], audit: [{ id: 'previous', at: '2026-10-10T00:00:00.000Z', actor: { id: 'engineer', name: 'Engenheira' },
      action: 'Editar detalhe', affected: [], before: [], after: [] }],
  };
}

describe('captura DXF compacta', () => {
  it('preserva o histórico e os dados não afetados por referência, com uma marca e célula no patch', () => {
    const base = workspace();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const first = captureMeasurement(base, actor,
        { measurementId: 'period', serviceId: 'target', rowId: 'row-1', field: 'measuredQuantity' },
        base.plans[0], mark('mark-1'));
      const patch = measurementCapturePatch(base, first);
      expect(patch).toBeTruthy();
      expect(first.services).toBe(base.services);
      expect(first.periods).toBe(base.periods);
      expect(first.entries[1]).toBe(base.entries[1]);
      expect(first.plans[1]).toBe(base.plans[1]);
      expect(first.audit[0]).toBe(base.audit[0]);
      expect(first.audit.at(-1)?.beforePlans).toBe(base.plans);
      expect(first.audit.at(-1)?.afterPlans).toBe(first.plans);
      expect(patch?.entries).toHaveLength(1);
      expect(patch?.plan.measures.map(measure => measure.id)).toEqual(['mark-1']);
      expect(patch?.entries[0].rows[0].measuredQuantity).toBe(1);
      expect(patch?.entries[0].rows[0].source?.measureId).toBe('mark-1');
      expect(patch?.event.beforePlans).toBeUndefined();
      expect(patch?.event.afterPlans).toBeUndefined();
      expect(stringify.mock.calls.some(([value]) => value === base || value === first
        || value === base.audit || value === first.audit || value === base.plans || value === first.plans)).toBe(false);

      const second = captureMeasurement(first, actor,
        { measurementId: 'period', serviceId: 'target', rowId: 'row-2', field: 'measuredQuantity' },
        first.plans[0], mark('mark-2'));
      const secondPatch = measurementCapturePatch(first, second);
      expect(secondPatch?.plan.measures.map(measure => measure.id)).toEqual(['mark-1', 'mark-2']);
      expect(secondPatch?.entries[0].rows.map(row => row.measuredQuantity)).toEqual([1, 1]);
      expect(base.plans[0].measures).toEqual([]);
      expect(base.entries[0].rows.map(row => row.measuredQuantity)).toEqual([0, 0]);
    } finally { stringify.mockRestore(); }
  });

  it('mantém o caminho completo para atualizar uma marca já vinculada', () => {
    const base = workspace();
    const first = captureMeasurement(base, actor,
      { measurementId: 'period', serviceId: 'target', rowId: 'row-1', field: 'measuredQuantity' },
      base.plans[0], mark('existing'));
    const updatedMark = { ...mark('existing'), points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
    const updated = captureMeasurement(first, actor,
      { measurementId: 'period', serviceId: 'target', rowId: 'row-1', field: 'measuredQuantity' },
      first.plans[0], updatedMark);
    expect(updated.entries[0].rows[0].measuredQuantity).toBe(2);
    expect(updated.entries[0].rows[0].source?.points).toEqual(updatedMark.points);
    expect(updated.plans[0].measures[0].points).toEqual(updatedMark.points);
    expect(updated.entries[1]).not.toBe(first.entries[1]);
  });

  it('gera patch pequeno quando a primeira captura cria a entrada da tarefa na base confirmada', () => {
    const base = workspace();
    base.entries = base.entries.filter(entry => entry.serviceId !== 'target');
    const blank = { projectId: base.projectId, measurementId: 'period', serviceId: 'target', rows: [newMeasuredRow('row-1')] };
    const staged = { ...base, entries: [...base.entries, blank] };
    const captured = captureMeasurement(staged, actor,
      { measurementId: 'period', serviceId: 'target', rowId: 'row-1', field: 'measuredQuantity' },
      base.plans[0], mark('first-mark'));
    const event = { ...captured.audit.at(-1)!,
      before: [{ projectId: base.projectId, measurementId: 'period', serviceId: 'target', rows: [] }],
    };
    const candidate = { ...captured, audit: [...base.audit, event] };
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const patch = measurementCapturePatch(base, candidate);
      expect(patch?.entries).toHaveLength(1);
      expect(patch?.entries[0].rows[0].measuredQuantity).toBe(1);
      expect(patch?.event.before[0].rows).toEqual([]);
      expect(patch?.plan.measures.map(measure => measure.id)).toEqual(['first-mark']);
      expect(stringify.mock.calls.some(([value]) => value === base || value === candidate
        || value === base.audit || value === candidate.audit || value === base.plans || value === candidate.plans)).toBe(false);
    } finally { stringify.mockRestore(); }
    expect(base.entries).toHaveLength(1);
    expect(base.plans[0].measures).toEqual([]);
  });
});
