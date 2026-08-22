import { jsPDF } from 'jspdf';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type AttachmentOptimizationProfile = 'field-photo' | 'fiscal-document';

/** Incrementar sempre que um perfil mudar: anexos gravados com versão menor
 * voltam a ser elegíveis para reotimização retroativa. */
export const ATTACHMENT_OPTIMIZATION_VERSION = 2;

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
    return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    decoded?.release();
  }
}

/** Renderiza PDFs fiscais em páginas JPEG A4 para remover dados redundantes.
 * Se a versão resultante for maior, o PDF original já é a alternativa mais leve. */
export async function optimizeFiscalPdf(file: File): Promise<File> {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) throw new Error('Selecione um PDF válido.');
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
    let output: jsPDF | undefined;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, Math.max(1, PROFILES['fiscal-document'].maxSide / natural.width));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas indisponível para processar o PDF.');
      await page.render({ canvas, canvasContext: context, viewport } as Parameters<typeof page.render>[0]).promise;
      const widthPt = 595.28;
      const heightPt = widthPt * (canvas.height / canvas.width);
      const orientation = widthPt > heightPt ? 'landscape' : 'portrait';
      if (!output) output = new jsPDF({ orientation, unit: 'pt', format: [widthPt, heightPt], compress: true });
      else output.addPage([widthPt, heightPt], orientation);
      output.addImage(canvas.toDataURL('image/jpeg', PROFILES['fiscal-document'].quality), 'JPEG', 0, 0, widthPt, heightPt, undefined, 'MEDIUM');
    }
    if (!output) throw new Error('O PDF não possui páginas.');
    const result = new File([output.output('blob')], `${file.name.replace(/\.pdf$/i, '') || 'nota-fiscal'}-otimizada.pdf`, { type: 'application/pdf', lastModified: file.lastModified });
    return result.size < file.size ? result : file;
  } finally {
    await pdf.destroy();
  }
}

export async function optimizeStorageAttachment(file: File, kind?: 'nf' | 'foto' | 'recibo' | 'termo' | 'outro'): Promise<File> {
  if (file.type.startsWith('image/')) return optimizeImageAttachment(file, kind === 'nf' ? 'fiscal-document' : 'field-photo');
  if (kind === 'nf' && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) return optimizeFiscalPdf(file);
  return file;
}
