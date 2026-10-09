import { describe, expect, it } from 'vitest';
import { extractDxfGeometry, snapDxf, trackAlignment } from './dxfSnap';

describe('capturas sobre entidades DXF reconhecidas', () => {
  const drawing = extractDxfGeometry({ entities: [
    { type: 'LINE', layer: 'PAREDES', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { type: 'LINE', layer: 'PAREDES', vertices: [{ x: 5, y: -5 }, { x: 5, y: 5 }] },
    { type: 'CIRCLE', layer: 'SIMBOLOS', center: { x: 20, y: 10 }, radius: 2 },
    { type: 'INSERT', layer: 'SIMBOLOS', position: { x: 30, y: 4 } },
  ] });

  it('identifica extremos, interseção, quadrantes e inserção nas coordenadas do visualizador', () => {
    expect(drawing.available).toEqual(expect.arrayContaining(['endpoint', 'midpoint', 'intersection', 'center', 'quadrant', 'insertion']));
    expect(snapDxf({ x: 0.3, y: 0.1 }, drawing, new Set(['endpoint']), 1, new Set())?.point).toEqual({ x: 0, y: 0 });
    expect(snapDxf({ x: 5.1, y: -0.1 }, drawing, new Set(['intersection']), 1, new Set())?.point).toEqual({ x: 5, y: 0 });
    expect(snapDxf({ x: 22.1, y: -10 }, drawing, new Set(['quadrant']), 1, new Set())?.point).toEqual({ x: 22, y: -10 });
    expect(snapDxf({ x: 30, y: -4.2 }, drawing, new Set(['insertion']), 1, new Set())?.point).toEqual({ x: 30, y: -4 });
  });

  it('não captura entidades de um layer oculto e mantém marcação livre sem opções válidas', () => {
    expect(snapDxf({ x: 30, y: -4 }, drawing, new Set(['insertion']), 1, new Set(['SIMBOLOS']))).toBeNull();
    expect(extractDxfGeometry({ entities: [] }).available).toEqual([]);
  });

  it('captura linhas dentro de blocos aninhados com escala, rotação, origem e layers herdados', () => {
    const nested = extractDxfGeometry({ blocks: {
      WALL: { position: { x: 1, y: 1 }, entities: [{ type: 'LINE', layer: '0', vertices: [{ x: 1, y: 1 }, { x: 4, y: 1 }] }] },
      FLOOR: { entities: [{ type: 'INSERT', name: 'WALL', layer: '0', position: { x: 2, y: 0 } }] },
    }, entities: [{ type: 'INSERT', name: 'FLOOR', layer: 'PAREDES', position: { x: 20, y: 30 }, rotation: 90, xScale: 2, yScale: 2 }] });
    expect(nested.segments).toHaveLength(1);
    expect(snapDxf({ x: 20.1, y: -34.1 }, nested, new Set(['endpoint']), .5, new Set())?.point).toEqual(expect.objectContaining({ x: expect.closeTo(20), y: expect.closeTo(-34) }));
    expect(snapDxf({ x: 20, y: -37.1 }, nested, new Set(['midpoint']), .5, new Set())?.point).toEqual(expect.objectContaining({ x: expect.closeTo(20), y: expect.closeTo(-37) }));
    expect(snapDxf({ x: 20, y: -34 }, nested, new Set(['endpoint']), .5, new Set(['PAREDES']))).toBeNull();
  });

  it('não exige rastreamento para perpendicular e não exige ponto anterior para extensão', () => {
    expect(snapDxf({ x: 3.1, y: .1 }, drawing, new Set(['perpendicular']), .5, new Set(), { x: 3, y: 4 })?.point).toEqual({ x: 3, y: 0 });
    expect(snapDxf({ x: 12, y: .1 }, drawing, new Set(['extension']), .5, new Set())?.point).toEqual({ x: 12, y: 0 });
    expect(snapDxf({ x: 3, y: .1 }, drawing, new Set(['perpendicular']), .5, new Set())).toBeNull();
  });

  it('não oferece o trecho inexistente de um arco como ponto mais próximo', () => {
    const arc = extractDxfGeometry({ entities: [{ type: 'ARC', center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI / 2 }] });
    expect(snapDxf({ x: -5, y: 0 }, arc, new Set(['nearest']), .5, new Set())).toBeNull();
    expect(snapDxf({ x: 5.1, y: 0 }, arc, new Set(['endpoint']), .5, new Set())?.point).toEqual({ x: 5, y: 0 });
  });

  it('rastreia alinhamentos a partir de um ponto adquirido, sem puxar posições distantes', () => {
    expect(trackAlignment({ x: 3.1, y: 10 }, { x: 3, y: 4 }, .5)).toEqual({ point: { x: 3, y: 10 }, from: { x: 3, y: 4 }, axes: ['x'] });
    expect(trackAlignment({ x: 9, y: 4.1 }, { x: 3, y: 4 }, .5)?.point).toEqual({ x: 9, y: 4 });
    expect(trackAlignment({ x: 9, y: 9 }, { x: 3, y: 4 }, .5)).toBeNull();
  });

  it('captura todos os tipos básicos e interrompe blocos cíclicos', () => {
    const geometry = extractDxfGeometry({ ...{ blocks: { CYCLE: { entities: [{ type: 'INSERT', name: 'CYCLE', position: { x: 0, y: 0 } }] } } }, entities: [
      { type: 'LINE', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { type: 'POINT', position: { x: 50, y: 50 } },
      { type: 'INSERT', name: 'CYCLE', position: { x: 30, y: 4 } },
    ] });
    expect(snapDxf({ x: 50.1, y: -50 }, geometry, new Set(['point']), .5, new Set())?.kind).toBe('point');
    expect(snapDxf({ x: 4, y: 3.1 }, geometry, new Set(['parallel']), .5, new Set(), { x: 0, y: 3 })?.point).toEqual({ x: 4, y: 3 });
    expect(snapDxf({ x: 4, y: .1 }, geometry, new Set(['nearest']), .5, new Set())?.point).toEqual({ x: 4, y: 0 });
    expect(geometry.anchors.filter(anchor => anchor.kind === 'insertion')).toHaveLength(2);
  });

  it('não cria capturas na corda de uma polilinha curva e respeita layer do bloco', () => {
    const geometry = extractDxfGeometry({ blocks: { CURVE: { entities: [{ type: 'LWPOLYLINE', layer: 'SIMBOLO', vertices: [{ x: 0, y: 0, bulge: 1 }, { x: 10, y: 0 }] }] } }, entities: [{ type: 'INSERT', name: 'CURVE', layer: 'PAREDES', position: { x: 20, y: 30 } }] });
    expect(geometry.segments).toHaveLength(0);
    expect(snapDxf({ x: 25, y: -30 }, geometry, new Set(['nearest']), .5, new Set())).toBeNull();
    expect(snapDxf({ x: 25, y: -25.1 }, geometry, new Set(['midpoint']), .5, new Set())?.point).toEqual({ x: 25, y: -25 });
    expect(snapDxf({ x: 25, y: -25 }, geometry, new Set(['midpoint']), .5, new Set(['PAREDES']))).toBeNull();
  });
});
