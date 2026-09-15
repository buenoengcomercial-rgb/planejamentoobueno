import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { equipmentPhotoOptimization, optimizeEquipmentPhoto } from './equipmentPhotoOptimization';

describe('optimizeEquipmentPhoto', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  let canvas: HTMLCanvasElement;
  let drawImage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    drawImage = vi.fn();
    canvas = document.createElement('canvas');
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(tagName => {
      if (tagName === 'canvas') return canvas;
      return createElement(tagName);
    });
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCreateImageBitmap) globalThis.createImageBitmap = originalCreateImageBitmap;
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  });

  function mockBitmap(width: number, height: number) {
    const close = vi.fn();
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({ width, height, close }) as typeof createImageBitmap;
    return close;
  }

  function mockJpeg(size: number) {
    vi.spyOn(canvas, 'toBlob').mockImplementation(callback => {
      callback(new Blob([new Uint8Array(size)], { type: 'image/jpeg' }));
    });
  }

  it('limita o maior lado a 960 px e gera um JPEG menor', async () => {
    const close = mockBitmap(4000, 3000);
    mockJpeg(1_000);
    const original = new File([new Uint8Array(5_000)], 'furadeira.png', { type: 'image/png' });

    const optimized = await optimizeEquipmentPhoto(original);

    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 960, 720);
    expect(optimized).not.toBe(original);
    expect(optimized.name).toBe('furadeira.jpg');
    expect(optimized.type).toBe('image/jpeg');
    expect(optimized.size).toBe(1_000);
    expect(close).toHaveBeenCalled();
    expect(equipmentPhotoOptimization).toEqual({ maxSide: 960, jpegQuality: 0.72 });
  });

  it('não amplia imagem pequena', async () => {
    mockBitmap(640, 480);
    mockJpeg(500);
    const original = new File([new Uint8Array(2_000)], 'etiqueta.jpeg', { type: 'image/jpeg' });

    await optimizeEquipmentPhoto(original);

    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 640, 480);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('preserva o original quando a conversão fica maior e recusa falha de conversão', async () => {
    mockBitmap(640, 480);
    mockJpeg(3_000);
    const original = new File([new Uint8Array(2_000)], 'etiqueta.jpeg', { type: 'image/jpeg' });

    expect(await optimizeEquipmentPhoto(original)).toBe(original);

    globalThis.createImageBitmap = vi.fn().mockRejectedValue(new Error('imagem inválida')) as typeof createImageBitmap;
    await expect(optimizeEquipmentPhoto(original)).rejects.toThrow('imagem inválida');
  });

  it('mantém a versão reduzida mesmo quando o JPEG fica maior que o original', async () => {
    mockBitmap(4_000, 3_000);
    mockJpeg(6_000);
    const original = new File([new Uint8Array(5_000)], 'camera.png', { type: 'image/png' });

    const optimized = await optimizeEquipmentPhoto(original);

    expect(optimized).not.toBe(original);
    expect(optimized.type).toBe('image/jpeg');
    expect(optimized.size).toBe(6_000);
  });
});
