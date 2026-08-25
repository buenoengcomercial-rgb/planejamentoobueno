import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyReportPhotoOptimization, optimizeDailyReportPhoto } from './dailyReportPhotoOptimization';

describe('optimizeDailyReportPhoto', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  let canvas: HTMLCanvasElement;
  let drawImage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    drawImage = vi.fn();
    canvas = document.createElement('canvas');
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(tag => tag === 'canvas' ? canvas : createElement(tag));
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, 'toBlob').mockImplementation(callback => callback(new Blob([new Uint8Array(900)], { type: 'image/jpeg' })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCreateImageBitmap) globalThis.createImageBitmap = originalCreateImageBitmap;
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  });

  it('corrige orientação e limita o maior lado a 1280px antes do upload', async () => {
    const close = vi.fn();
    globalThis.createImageBitmap = vi.fn().mockResolvedValue({ width: 4000, height: 3000, close }) as typeof createImageBitmap;
    const source = new File([new Uint8Array(5_000)], 'campo.png', { type: 'image/png' });

    const optimized = await optimizeDailyReportPhoto(source);

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(960);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 960);
    expect(optimized).toMatchObject({ name: 'campo.jpg', type: 'image/jpeg', size: 900 });
    expect(close).toHaveBeenCalled();
  });

  it('recusa o upload quando a imagem não pode ser decodificada', async () => {
    globalThis.createImageBitmap = vi.fn().mockRejectedValue(new Error('arquivo inválido')) as typeof createImageBitmap;
    await expect(optimizeDailyReportPhoto(new File(['x'], 'quebrada.jpg', { type: 'image/jpeg' })))
      .rejects.toThrow('arquivo inválido');
  });

  it('declara a política de armazenamento do Diário', () => {
    expect(dailyReportPhotoOptimization).toEqual({ maxSide: 1280, jpegQuality: 0.76 });
  });
});
