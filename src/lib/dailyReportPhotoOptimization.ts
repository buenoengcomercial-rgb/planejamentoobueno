import { photoStampLines, type DailyReportPhotoStamp } from '@/lib/dailyReportPhotoStamp';

const DAILY_REPORT_PHOTO_MAX_SIDE = 1280;
const DAILY_REPORT_PHOTO_MIN_SIDE = 320;
const DAILY_REPORT_PHOTO_MAX_BYTES = 100 * 1024;
const DAILY_REPORT_PHOTO_JPEG_QUALITIES = [0.76, 0.64, 0.52, 0.4, 0.3, 0.22];

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

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível compactar a imagem.')),
      'image/jpeg', quality);
  });
}

function drawPhotoStamp(context: CanvasRenderingContext2D, width: number, height: number, stamp?: DailyReportPhotoStamp) {
  if (!stamp) return;
  const lines = photoStampLines(stamp);
  if (lines.length === 0) return;

  const fontSize = Math.max(18, Math.round(width * 0.032));
  const lineHeight = Math.round(fontSize * 1.18);
  const padding = Math.max(14, Math.round(width * 0.02));
  const blockHeight = padding * 2 + lines.length * lineHeight;
  const blockWidth = Math.min(width, Math.round(width * 0.88));
  const x = width - padding;
  const top = height - blockHeight;

  context.save();
  context.fillStyle = 'rgba(0, 0, 0, 0.58)';
  context.fillRect(width - blockWidth, top, blockWidth, blockHeight);
  context.fillStyle = '#ffffff';
  context.font = `600 ${fontSize}px sans-serif`;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  lines.forEach((line, index) => {
    context.fillText(line, x, top + padding + lineHeight * index + lineHeight / 2, blockWidth - padding * 2);
  });
  context.restore();
}

/**
 * Gera a única cópia persistida para o Diário: JPEG orientado, leve e adequado
 * para visualização de campo e impressão em até seis fotos por folha A4.
 * A cópia só é aceita quando ficar dentro do limite operacional de 100 KB.
 */
export async function optimizeDailyReportPhoto(file: File, stamp?: DailyReportPhotoStamp): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('Selecione uma imagem válida.');

  let decoded: DecodedImage | undefined;
  try {
    decoded = await decodeImage(file);
    if (!decoded.width || !decoded.height) throw new Error('A imagem não possui dimensões válidas.');
    const sourceMaxSide = Math.max(decoded.width, decoded.height);
    const minimumSide = Math.min(DAILY_REPORT_PHOTO_MIN_SIDE, sourceMaxSide);
    let targetMaxSide = Math.min(DAILY_REPORT_PHOTO_MAX_SIDE, sourceMaxSide);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas indisponível para compactar a imagem.');
    let blob: Blob | undefined;

    while (!blob && targetMaxSide >= minimumSide) {
      const scale = targetMaxSide / sourceMaxSide;
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      canvas.width = width;
      canvas.height = height;
      context.drawImage(decoded.source, 0, 0, width, height);
      drawPhotoStamp(context, width, height, stamp);

      for (const quality of DAILY_REPORT_PHOTO_JPEG_QUALITIES) {
        const candidate = await toJpeg(canvas, quality);
        if (candidate.size > 0 && candidate.size <= DAILY_REPORT_PHOTO_MAX_BYTES) {
          blob = candidate;
          break;
        }
      }

      if (targetMaxSide === minimumSide) break;
      targetMaxSide = Math.max(minimumSide, Math.floor(targetMaxSide * 0.75));
    }

    if (!blob) throw new Error('Não foi possível reduzir a foto para o limite de 100 KB. Tente enquadrar um objeto menor ou usar melhor iluminação.');
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
  minSide: DAILY_REPORT_PHOTO_MIN_SIDE,
  maxBytes: DAILY_REPORT_PHOTO_MAX_BYTES,
  jpegQualities: DAILY_REPORT_PHOTO_JPEG_QUALITIES,
};
