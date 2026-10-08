import { describe, expect, it } from 'vitest';
import { quantity, calibration, measureUnit, measuresForContext, scopeKey } from './planTakeoff';

describe('levantamento em coordenadas do documento', () => {
  it('conta sete pontos sem exigir escala', () => {
    expect(quantity('count', Array.from({ length: 7 }, (_, x) => ({ x, y: 0 })), null)).toBe(7);
  });
  it('mede percurso e área, aplicando escala às dimensões corretas', () => {
    const path = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }];
    expect(quantity('length', path, 1)).toBe(7);
    expect(quantity('area', [...path, { x: 0, y: 4 }], 1)).toBe(12);
    expect(quantity('area', [...path, { x: 0, y: 4 }], 2)).toBe(48);
    expect(quantity('length', path, null)).toBe(7);
    expect(measureUnit('length', null)).toBe('u.d.');
    expect(measureUnit('area', null)).toBe('u.d.²');
    expect(measureUnit('area', 1)).toBe('m²');
  });
  it('calcula os modos geométricos do visualizador com escala e altura reais', () => {
    const diagonal = [{ x: 1, y: 2 }, { x: 4, y: 6 }];
    const rectangle = [{ x: 1, y: 2 }, { x: 4, y: 6 }];
    const polygon = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }, { x: 0, y: 4 }];
    expect(quantity('linearLength', diagonal, 1)).toBe(5);
    expect(quantity('circlePerimeter', [{ x: 0, y: 0 }, { x: 3, y: 4 }], 1)).toBeCloseTo(10 * Math.PI);
    expect(quantity('rectangleArea', rectangle, 1)).toBe(12);
    expect(quantity('circleArea', [{ x: 0, y: 0 }, { x: 3, y: 4 }], 1)).toBeCloseTo(25 * Math.PI);
    expect(quantity('verticalArea', diagonal, 1, 3)).toBe(15);
    expect(quantity('polygonVolume', polygon, 1, 3)).toBe(36);
    expect(quantity('polygonVolume', polygon, 1, 0)).toBeNull();
    expect(quantity('rectangleArea', rectangle, null)).toBe(12);
  });
  it('rejeita referências inválidas e calibra distância conhecida', () => {
    expect(calibration([{ x: 0, y: 0 }, { x: 300, y: 400 }], 5)).toBe(.01);
    expect(() => calibration([{ x: 0, y: 0 }, { x: 0, y: 0 }], 5)).toThrow();
    expect(() => calibration([{ x: 0, y: 0 }, { x: 1, y: 0 }], -1)).toThrow();
  });
  it('isola usuários, organizações e obras sem colisão de delimitadores', () => {
    expect(scopeKey('a:b', 'c', 'd')).not.toBe(scopeKey('a', 'b:c', 'd'));
    expect(scopeKey('a', 'b', 'c')).not.toBe(scopeKey('a', 'b', 'd'));
  });
  it('reutiliza o arquivo sem misturar marcações de tarefas e dias diferentes', () => {
    const measures = [
      { id: 'legacy', name: 'Legado', kind: 'count' as const, page: 1, points: [] },
      { id: 'a1', name: 'Tarefa A dia 1', kind: 'count' as const, page: 1, points: [], taskId: 'a', logId: 'dia-1' },
      { id: 'a2', name: 'Tarefa A dia 2', kind: 'count' as const, page: 1, points: [], taskId: 'a', logId: 'dia-2' },
      { id: 'b1', name: 'Tarefa B dia 1', kind: 'count' as const, page: 1, points: [], taskId: 'b', logId: 'dia-1' },
    ];
    expect(measuresForContext(measures, { taskId: 'a', logId: 'dia-1' }).map(measure => measure.id)).toEqual(['legacy', 'a1']);
    expect(measuresForContext(measures, { taskId: 'b', logId: 'dia-1' }).map(measure => measure.id)).toEqual(['legacy', 'b1']);
    expect(measuresForContext(measures, { taskId: 'b', logId: 'dia-1' }, ['a1']).map(measure => measure.id)).toEqual(['legacy', 'a1', 'b1']);
  });
});
