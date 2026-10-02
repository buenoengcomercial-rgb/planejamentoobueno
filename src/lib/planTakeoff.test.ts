import { describe, expect, it } from 'vitest';
import { quantity, calibration, scopeKey } from './planTakeoff';

describe('levantamento em coordenadas do documento', () => {
  it('conta sete pontos sem exigir escala', () => {
    expect(quantity('count', Array.from({ length: 7 }, (_, x) => ({ x, y: 0 })), null)).toBe(7);
  });
  it('mede percurso e área, aplicando escala às dimensões corretas', () => {
    const path = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }];
    expect(quantity('length', path, 1)).toBe(7);
    expect(quantity('area', [...path, { x: 0, y: 4 }], 1)).toBe(12);
    expect(quantity('area', [...path, { x: 0, y: 4 }], 2)).toBe(48);
    expect(quantity('length', path, null)).toBeNull();
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
});
