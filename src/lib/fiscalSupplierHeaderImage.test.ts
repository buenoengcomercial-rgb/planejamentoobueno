import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupplierHeaderImageDataUrl } from './fiscalSupplierHeaderImage';

function mockImage(width: number, height: number, shouldFail = false) {
  class MockImage {
    naturalWidth = width;
    naturalHeight = height;
    width = width;
    height = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => shouldFail ? this.onerror?.() : this.onload?.());
    }
  }
  vi.stubGlobal('Image', MockImage);
}

describe('createSupplierHeaderImageDataUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('recorta e amplia o cabeçalho de uma foto vertical', async () => {
    mockImage(1000, 1600);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,Y2FiZWNhbGhv');

    await expect(createSupplierHeaderImageDataUrl('data:image/jpeg;base64,bm90YQ=='))
      .resolves.toBe('data:image/jpeg;base64,Y2FiZWNhbGhv');
    const canvas = document.querySelector('canvas');
    expect(canvas).toBeNull();
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1000, 640, 0, 0, 1500, 960);
  });

  it('limita a largura do recorte de uma imagem horizontal', async () => {
    mockImage(2400, 1200);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,Y2FiZWNhbGhv');

    await createSupplierHeaderImageDataUrl('data:image/png;base64,bm90YQ==');
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2400, 480, 0, 0, 1800, 360);
  });

  it('mantém o fluxo com a imagem completa quando o recorte falha', async () => {
    mockImage(1000, 1600, true);
    await expect(createSupplierHeaderImageDataUrl('data:image/jpeg;base64,bm90YQ==')).resolves.toBeUndefined();
    await expect(createSupplierHeaderImageDataUrl('data:application/pdf;base64,bm90YQ==')).resolves.toBeUndefined();
  });
});
