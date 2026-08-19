const HEADER_HEIGHT_RATIO = 0.62;
const MAX_HEADER_WIDTH = 1800;
const MAX_UPSCALE = 1.5;

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Não foi possível preparar o cabeçalho da nota.'));
    image.src = source;
  });
}

/** Creates an enlarged upper-page crop while leaving the original image untouched. */
export async function createSupplierHeaderImageDataUrl(source?: string) {
  if (!source?.startsWith('data:image/')) return undefined;
  try {
    const image = await loadImage(source);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) return undefined;

    const sourceCropHeight = Math.max(1, Math.round(sourceHeight * HEADER_HEIGHT_RATIO));
    const scale = Math.min(MAX_UPSCALE, MAX_HEADER_WIDTH / sourceWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceCropHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(image, 0, 0, sourceWidth, sourceCropHeight, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL('image/jpeg', 0.9);
    return result.startsWith('data:image/') ? result : undefined;
  } catch {
    return undefined;
  }
}
