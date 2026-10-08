import { describe, expect, it } from 'vitest';
import type { LoadedDwfDocument } from 'dwf-viewer';
import { dwfSheets } from './dwfTakeoff';

describe('folhas DWF', () => {
  it('libera somente folhas 2D decodificadas, sem tratar miniatura como desenho', () => {
    const document = { pageData: [
      { name: 'Térreo', kind: 'w2d-text', width: 1000, height: 700, primitives: [{ type: 'polyline', points: [0, 0, 1, 1] }] },
      { name: 'Cobertura', kind: 'image', width: 1000, height: 700 },
      { name: 'Modelo', kind: 'w3d-model', width: 1000, height: 700 },
    ] } as LoadedDwfDocument;
    expect(dwfSheets(document).map(sheet => sheet.supported)).toEqual([true, false, false]);
    expect(dwfSheets(document)[1].reason).toContain('imagem de prévia');
  });
});
