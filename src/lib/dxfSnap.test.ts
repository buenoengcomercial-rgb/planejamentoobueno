import { describe, expect, it } from 'vitest';
import { extractDxfGeometry, snapDxf } from './dxfSnap';

describe('capturas sobre entidades DXF reconhecidas', () => {
  const drawing = extractDxfGeometry({ entities: [
    { type: 'LINE', layer: 'PAREDES', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { type: 'LINE', layer: 'PAREDES', vertices: [{ x: 5, y: -5 }, { x: 5, y: 5 }] },
    { type: 'CIRCLE', layer: 'SIMBOLOS', center: { x: 20, y: 10 }, radius: 2 },
    { type: 'INSERT', layer: 'SIMBOLOS', position: { x: 30, y: 4 } },
  ] });

  it('identifica extremos, interseção, quadrantes e inserção nas coordenadas do visualizador', () => {
    expect(drawing.available).toEqual(expect.arrayContaining(['endpoint', 'midpoint', 'intersection', 'center', 'quadrant', 'insertion']));
    expect(snapDxf({ x: 0.3, y: 0.1 }, drawing, new Set(['endpoint']), 1, new Set())?.point).toEqual({ x: 0, y: -0 });
    expect(snapDxf({ x: 5.1, y: -0.1 }, drawing, new Set(['intersection']), 1, new Set())?.point).toEqual({ x: 5, y: 0 });
    expect(snapDxf({ x: 22.1, y: -10 }, drawing, new Set(['quadrant']), 1, new Set())?.point).toEqual({ x: 22, y: -10 });
    expect(snapDxf({ x: 30, y: -4.2 }, drawing, new Set(['insertion']), 1, new Set())?.point).toEqual({ x: 30, y: -4 });
  });

  it('não captura entidades de um layer oculto e mantém marcação livre sem opções válidas', () => {
    expect(snapDxf({ x: 30, y: -4 }, drawing, new Set(['insertion']), 1, new Set(['SIMBOLOS']))).toBeNull();
    expect(extractDxfGeometry({ entities: [] }).available).toEqual([]);
  });
});
