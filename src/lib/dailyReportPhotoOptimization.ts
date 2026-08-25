const DAILY_REPORT_PHOTO_MAX_SIDE = 1280;
const DAILY_REPORT_PHOTO_JPEG_QUALITY = 0.76;

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
      .catch(() => createImageBitmap(file));
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error('Não foi possível decodificar a imagem.'));
      candidate.src = objectUrl;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível compactar a imagem.')),
      'image/jpeg', DAILY_REPORT_PHOTO_JPEG_QUALITY);
  });
}

/**
 * Gera a única cópia persistida para o Diário: JPEG orientado, leve e adequado
 * para visualização de campo e impressão em até seis fotos por folha A4,
 * sem carregar pixels desnecessários nas miniaturas do Diário.
 */
export async function optimizeDailyReportPhoto(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('Selecione uma imagem válida.');

  let decoded: DecodedImage | undefined;
  try {
    decoded = await decodeImage(file);
    if (!decoded.width || !decoded.height) throw new Error('A imagem não possui dimensões válidas.');
    const scale = Math.min(1, DAILY_REPORT_PHOTO_MAX_SIDE / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas indisponível para compactar a imagem.');
    context.drawImage(decoded.source, 0, 0, width, height);
    const blob = await toJpeg(canvas);
    if (!blob.size) throw new Error('A compactação não gerou uma imagem válida.');
    const base = file.name.replace(/\.[^.]+$/, '') || 'foto-diario';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Não foi possível otimizar a foto.');
  } finally {
    decoded?.release();
  }
}

export const dailyReportPhotoOptimization = {
  maxSide: DAILY_REPORT_PHOTO_MAX_SIDE,
  jpegQuality: DAILY_REPORT_PHOTO_JPEG_QUALITY,
};
