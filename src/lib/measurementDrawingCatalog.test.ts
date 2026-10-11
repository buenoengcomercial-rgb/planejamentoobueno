import { describe, expect, it } from 'vitest';
import type { TakeoffPlan } from './planTakeoff';
import { reconcileDrawingCatalog } from './measurementDrawingCatalog';

const drawing = (id: string): TakeoffPlan => ({
  id, name: `${id}.dxf`, floor: id, kind: 'dxf', file: new Blob([id]),
  scales: { 1: 1 }, measures: [], chapterId: 'building',
});

describe('reconcileDrawingCatalog', () => {
  it('adds one drawing to the latest catalog without replacing new marks or other drawings', () => {
    const previous = [drawing('0'), drawing('1')];
    const marked = { ...previous[0], measures: [{ id: 'mark', name: 'Count', kind: 'count' as const, page: 1, points: [{ x: 1, y: 2 }] }] };
    const current = [marked, { ...previous[1], storagePath: 'confirmed/1.dxf' }, drawing('2')];
    const proposed = [...previous, drawing('3')];

    const merged = reconcileDrawingCatalog(current, previous, proposed);

    expect(merged).toEqual([...current, proposed[2]]);
    expect(merged[0]).toBe(marked);
    expect(current).toHaveLength(3);
  });

  it('does not overwrite a changed catalog through an edit or deletion', () => {
    const previous = [drawing('0')];
    const current = [{ ...previous[0], storagePath: 'confirmed/0.dxf' }];
    expect(() => reconcileDrawingCatalog(current, previous, [])).toThrow('Reabra o visualizador');
    expect(() => reconcileDrawingCatalog(current, previous, [{ ...previous[0], floor: 'Térreo' }])).toThrow('Reabra o visualizador');
  });

  it('rejects an already registered filename within the same building', () => {
    const current = [drawing('0')];
    expect(() => reconcileDrawingCatalog(current, [], [{ ...drawing('new'), name: '0.dxf' }]))
      .toThrow('já está cadastrada');
  });

  it('treats a previously confirmed drawing id as an idempotent addition', () => {
    const current = [{ ...drawing('0'), storagePath: 'confirmed/0.dxf' }];
    expect(reconcileDrawingCatalog(current, [], [drawing('0')])).toBe(current);
  });

  it('allows an edit when the catalog has not changed', () => {
    const previous = [drawing('0')];
    const next = [{ ...previous[0], floor: 'Térreo' }];
    expect(reconcileDrawingCatalog([...previous], previous, next)).toBe(next);
  });
});
