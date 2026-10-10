import { describe, expect, it } from 'vitest';
import { dxfModelOnly } from './dxfModel';
import { extractDxfGeometry, snapDxf } from './dxfSnap';

const file = (entities: string, tables = '') => `0\nSECTION\n2\nTABLES\n${tables}0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
const line = (layer: string, space = '') => `0\nLINE\n8\n${layer}\n${space}10\n0\n20\n0\n11\n10\n21\n0\n`;

describe('DXF somente Model', () => {
  it('exclui Paper Space pelo grupo 67, nome do Layout e proprietário, mesmo com flag contraditória', () => {
    const tables = '0\nBLOCK_RECORD\n5\nAB\n2\n*Paper_Space0\n';
    const result = dxfModelOnly(file(line('MODEL') + line('MODEL_EXPLICITO', '67\n0\n410\nModel\n') +
      line('PAPER_67', '67\n1\n') + line('PAPER_410', '67\n0\n410\nLayout1\n') +
      line('PAPER_OWNER', '330\nab\n'), tables));
    expect(result).toContain('MODEL_EXPLICITO');
    expect(result).not.toMatch(/PAPER_67|PAPER_410|PAPER_OWNER/);
    expect(result).toContain('*Paper_Space0'); // Table metadata remains intact.
    expect(result).toContain('0\nEOF\n');
  });

  it('preserva polilinhas e atributos do Model e remove os filhos de polilinhas/INSERT do Layout', () => {
    const children = '0\nVERTEX\n10\n1\n20\n2\n0\nSEQEND\n';
    const result = dxfModelOnly(file(`0\nPOLYLINE\n8\nMODEL\n${children}0\nPOLYLINE\n67\n1\n${children}0\nINSERT\n67\n1\n0\nATTRIB\n1\nPAPER_TEXT\n0\nSEQEND\n${line('LAST_MODEL')}`));
    expect(result.match(/\nVERTEX\n/g)).toHaveLength(1);
    expect(result).not.toContain('PAPER_TEXT');
    expect(result).toContain('LAST_MODEL');
    expect(dxfModelOnly(result.replace(/\n/g, '\r\n'))).toBe(result);
  });

  it('ignora extremos, centros e inserções do Layout também na geometria usada para capturas', () => {
    const geometry = extractDxfGeometry({ entities: [
      { type: 'LINE', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { type: 'LINE', inPaperSpace: true, vertices: [{ x: 100, y: 0 }, { x: 110, y: 0 }] },
      { type: 'CIRCLE', layoutName: 'Layout1', center: { x: 200, y: 0 }, radius: 1 },
      { type: 'INSERT', inPaperSpace: true, name: 'SYMBOL', position: { x: 300, y: 0 } },
    ], blocks: { SYMBOL: { entities: [{ type: 'POINT', position: { x: 0, y: 0 } }] } } });
    expect(geometry.segments).toHaveLength(1);
    expect(geometry.circles).toHaveLength(0);
    for (const x of [100, 200, 300]) expect(snapDxf({ x, y: 0 }, geometry, new Set(['endpoint', 'center', 'insertion', 'point']), .1, new Set())).toBeNull();
  });
});
