
export type AttachmentOptimizationProfile = 'field-photo' | 'fiscal-document';

export { ATTACHMENT_OPTIMIZATION_VERSION } from './attachmentOptimizationVersion';


const PROFILES: Record<AttachmentOptimizationProfile, { maxSide: number; quality: number }> = {
  'field-photo': { maxSide: 1600, quality: 0.8 },
  // NF precisa preservar CNPJ, chave, itens e valores. 1600 px (~A4 a 150 dpi)
  // mantém esses campos legíveis com cerca de 1/4 do armazenamento anterior.
  'fiscal-document': { maxSide: 1600, quality: 0.8 },
};


function jpegName(name: string) {
  return `${name.replace(/\.[^.]+$/, '') || 'anexo'}.jpg`;
}

async function decodedImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
      .catch(() => createImageBitmap(file));
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error('Não foi possível decodificar a imagem.'));
      candidate.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível compactar a imagem.')), 'image/jpeg', quality));
}

export async function optimizeImageAttachment(file: File, profile: AttachmentOptimizationProfile): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('Selecione uma imagem válida.');
  const settings = PROFILES[profile];
  let decoded: Awaited<ReturnType<typeof decodedImage>> | undefined;
  try {
    decoded = await decodedImage(file);
    if (!decoded.width || !decoded.height) throw new Error('A imagem não possui dimensões válidas.');
    const scale = Math.min(1, settings.maxSide / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas indisponível para compactar a imagem.');
    context.drawImage(decoded.source, 0, 0, width, height);
    const blob = await canvasBlob(canvas, settings.quality);
    if (!blob.size) throw new Error('A compactação não gerou uma imagem válida.');
    return blob.size < file.size ? new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified }) : file;
  } finally {
    decoded?.release();
  }
}

/** Preserve the original PDF bytes, text, signatures and embedded evidence.
 * Raster previews must never replace the authoritative fiscal document. */
export async function optimizeFiscalPdf(file: File): Promise<File> {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) throw new Error('Selecione um PDF válido.');
  return file;
}

export async function optimizeStorageAttachment(file: File, kind?: 'nf' | 'foto' | 'recibo' | 'termo' | 'outro'): Promise<File> {
  if (file.type.startsWith('image/')) return optimizeImageAttachment(file, kind === 'nf' ? 'fiscal-document' : 'field-photo');
  // Documentos fiscais e comprovantes mantêm os bytes originais para auditoria.
  if ((kind === 'nf' || kind === 'recibo') && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) return optimizeFiscalPdf(file);
  return file;
}
