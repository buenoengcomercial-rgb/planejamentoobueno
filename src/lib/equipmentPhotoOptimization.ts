const EQUIPMENT_PHOTO_MAX_SIDE = 1280;
const EQUIPMENT_PHOTO_JPEG_QUALITY = 0.78;

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
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close?.(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error('Não foi possível decodificar a imagem.'));
      candidate.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Não foi possível compactar a imagem.'));
    }, 'image/jpeg', EQUIPMENT_PHOTO_JPEG_QUALITY);
  });
}

function jpegName(name: string) {
  const base = name.replace(/\.[^.]+$/, '') || 'equipamento';
  return `${base}.jpg`;
}

/**
 * Corrige a orientação, limita o maior lado e gera um JPEG leve. Qualquer
 * resultado maior preserva o arquivo recebido (ele já ocupa menos espaço).
 * Falha de conversão bloqueia o envio para nunca subir um original pesado por exceção.
 */
export async function optimizeEquipmentPhoto(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;

  let decoded: DecodedImage | undefined;
  try {
    decoded = await decodeImage(file);
    if (!decoded.width || !decoded.height) return file;

    const scale = Math.min(1, EQUIPMENT_PHOTO_MAX_SIDE / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(decoded.source, 0, 0, width, height);

    const blob = await canvasToBlob(canvas);
    if (blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Não foi possível otimizar a foto.');
  } finally {
    decoded?.release();
  }
}

export const equipmentPhotoOptimization = {
  maxSide: EQUIPMENT_PHOTO_MAX_SIDE,
  jpegQuality: EQUIPMENT_PHOTO_JPEG_QUALITY,
};
