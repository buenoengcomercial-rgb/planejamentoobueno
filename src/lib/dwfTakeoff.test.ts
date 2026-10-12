import { describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { PageRenderer } from 'dwf-viewer';
import type { LoadedDwfDocument } from 'dwf-viewer';
import { dwfSheets, openDwfSheets } from './dwfTakeoff';

const ascii = (value: string) => Array.from(new TextEncoder().encode(value));
const integer = (value: number, size: 2 | 4) => {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  if (size === 2) view.setInt16(0, value, true); else view.setInt32(0, value, true);
  return Array.from(bytes);
};
const point16 = (x: number, y: number) => [...integer(x, 2), ...integer(y, 2)];

/** A stored ZIP W2D resource exercises the actual package loader and decoder. */
function dwfFile(stream: number[], includeManifest = false): Blob {
  const encoder = new TextEncoder();
  const files = [{ name: encoder.encode('Model.w2d'), data: new Uint8Array(stream) }];
  if (includeManifest) files.push({ name: encoder.encode('manifest.xml'), data: encoder.encode('<Manifest><Sections><Section name="Model" title="Model"><Toc><Resource role="2d streaming graphics" href="Model.w2d"/></Toc></Section></Sections></Manifest>') });
  const centralOffset = files.reduce((total, file) => total + 30 + file.name.length + file.data.length, 0);
  const centralSize = files.reduce((total, file) => total + 46 + file.name.length, 0);
  const bytes = new Uint8Array(centralOffset + centralSize + 22);
  const view = new DataView(bytes.buffer);
  let local = 0;
  let central = centralOffset;
  for (const { name, data } of files) {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    view.setUint32(local, 0x04034b50, true);
    view.setUint16(local + 4, 20, true);
    view.setUint32(local + 14, crc, true);
    view.setUint32(local + 18, data.length, true);
    view.setUint32(local + 22, data.length, true);
    view.setUint16(local + 26, name.length, true);
    bytes.set(name, local + 30);
    bytes.set(data, local + 30 + name.length);
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint32(central + 16, crc, true);
    view.setUint32(central + 20, data.length, true);
    view.setUint32(central + 24, data.length, true);
    view.setUint16(central + 28, name.length, true);
    view.setUint32(central + 42, local, true);
    bytes.set(name, central + 46);
    local += 30 + name.length + data.length;
    central += 46 + name.length;
  }
  const end = centralOffset + centralSize;
  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 8, files.length, true);
  view.setUint16(end + 10, files.length, true);
  view.setUint32(end + 12, centralSize, true);
  view.setUint32(end + 16, centralOffset, true);
  return new NodeBlob([bytes]) as unknown as Blob;
}

const header = ascii('(W2D V06.00)');
const origin = [0x4f, ...integer(100, 4), ...integer(200, 4)];
const line = [0x0c, ...point16(2, 3), ...point16(3, 4)];

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

  it('decodifica marcadores V6.00 independentes e continua a linha até o fim do W2D', async () => {
    const file = dwfFile([
      ...header, 0x03, 17, 34, 51, 255, 0x17, ...integer(4, 4), ...origin,
      0x8d, 2, ...point16(1, 2), ...point16(4, 6), ...line,
    ]);
    const document = await openDwfSheets(file);
    const page = document.pageData[0];
    expect(page.kind).toBe('w2d-text');
    if (page.kind !== 'w2d-text') throw new Error('Expected W2D vectors');
    expect(page.primitives).toEqual([
      { type: 'rect', x: 99, y: 200, width: 4, height: 4, fill: 'rgba(17, 34, 51, 1)', lineWidth: 4, obraplannerPolymarker: true },
      { type: 'rect', x: 103, y: 206, width: 4, height: 4, fill: 'rgba(17, 34, 51, 1)', lineWidth: 4, obraplannerPolymarker: true },
      { type: 'polyline', points: [107, 211, 110, 215], stroke: 'rgba(17, 34, 51, 1)', lineWidth: 4 },
    ]);
    expect(page.diagnostics.some(diagnostic => diagnostic.code === 'W2D_BINARY_PARTIAL')).toBe(false);
    expect(dwfSheets(document)[0].supported).toBe(true);
  });

  it('consome marcadores invisíveis sem desenhá-los e conserva as coordenadas seguintes', async () => {
    const document = await openDwfSheets(dwfFile([
      ...header, ...origin, 0x76, 0x8d, 2, ...point16(1, 2), ...point16(4, 6), 0x56, ...line,
    ]));
    const page = document.pageData[0];
    if (page.kind !== 'w2d-text') throw new Error('Expected W2D vectors');
    expect(page.primitives).toEqual([{ type: 'polyline', points: [107, 211, 110, 215], stroke: '#000000', lineWidth: 1 }]);
  });

  it('renderiza cada marcador como um ponto visível sem ligar suas coordenadas', async () => {
    const document = await openDwfSheets(dwfFile([
      ...header, 0x03, 17, 34, 51, 255, 0x17, ...integer(0, 4), ...origin,
      0x8d, 2, ...point16(1, 2), ...point16(4, 6),
      0x0c, ...point16(32000, 0), ...point16(32000, 0),
    ]));
    const canvas = { width: 1200, height: 500, style: { width: '1200px' } };
    let scale = 1;
    const circles: { x: number; y: number; diameterPixels: number; fill: string }[] = [];
    const context = {
      canvas, fillStyle: '', strokeStyle: '', lineWidth: 1,
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(),
      setTransform: (a: number) => { scale = Math.abs(a); },
      arc: (x: number, y: number, radius: number) => { circles.push({ x, y, diameterPixels: 2 * radius * scale, fill: context.fillStyle }); },
    };
    const renderer = new PageRenderer(document);
    const stats = await renderer.render(0, { ...canvas, getContext: () => context } as unknown as HTMLCanvasElement, { preferWebgl: false, preferWasm: false, lineWeightMode: 'adaptive' });
    renderer.dispose();
    expect(stats.commands).toBe(3);
    expect(circles.map(({ x, y, fill }) => ({ x, y, fill }))).toEqual([
      { x: 101, y: 202, fill: 'rgba(17, 34, 51, 1)' },
      { x: 105, y: 208, fill: 'rgba(17, 34, 51, 1)' },
    ]);
    expect(circles.every(circle => circle.diameterPixels >= 0.55)).toBe(true);
    expect(context.lineTo).toHaveBeenCalledTimes(1);
    expect(context.lineTo).toHaveBeenCalledWith(64105, 208);
  });

  it('lê a contagem estendida de marcadores e continua depois de 256 pontos', async () => {
    const points = Array.from({ length: 257 }, () => point16(1, 1)).flat();
    const document = await openDwfSheets(dwfFile([...header, ...origin, 0x8d, 0, ...integer(1, 2), ...points, ...line]));
    const page = document.pageData[0];
    if (page.kind !== 'w2d-text') throw new Error('Expected W2D vectors');
    expect(page.primitives).toHaveLength(258);
    expect(page.primitives.at(-1)).toMatchObject({ type: 'polyline', points: [359, 460, 362, 464] });
  });

  it('não aceita uma leitura parcial como uma folha completa', async () => {
    await expect(openDwfSheets(dwfFile([...header, ...origin, ...line, 0x8e]))).rejects.toThrow('decodificada parcialmente');
    const document = { pageData: [{ name: 'Model', kind: 'w2d-text', width: 100, height: 100, primitives: [{ type: 'polyline', points: [0, 0, 1, 1] }], diagnostics: [{ level: 'warning', code: 'W2D_BINARY_PARTIAL', message: 'unsupported opcode' }] }] } as LoadedDwfDocument;
    expect(dwfSheets(document)[0]).toMatchObject({ supported: false, reason: expect.stringContaining('parcialmente') });
  });

  it('abre uma folha com manifesto e 150 mil vetores sem estourar a pilha', async () => {
    const stream = [...header, ...origin];
    for (let index = 0; index < 150_000; index++) stream.push(...line);
    const document = await openDwfSheets(dwfFile(stream, true));
    const page = document.pageData[0];
    if (page.kind !== 'w2d-text') throw new Error('Expected the full Model sheet');
    expect(page.name).toBe('Model');
    expect(page.primitives).toHaveLength(150_000);
    expect(page.primitives.at(-1)).toMatchObject({ type: 'polyline', points: [750097, 1050196, 750100, 1050200] });
    expect(dwfSheets(document)[0].supported).toBe(true);
  });

  it('não interpreta Macro_Draw V6.01 como os marcadores antigos', async () => {
    await expect(openDwfSheets(dwfFile([
      ...ascii('(W2D V06.01)'), ...origin, ...line, 0x8d, 1, ...point16(1, 1),
    ]))).rejects.toThrow('decodificada parcialmente');
  });
});
