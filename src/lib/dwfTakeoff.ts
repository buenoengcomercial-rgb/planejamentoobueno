import type { LoadedDwfDocument } from 'dwf-viewer';

export interface DwfSheet { name: string; width: number; height: number; supported: boolean; reason?: string }

/** A DWF sheet is measurable only when its own 2D vector stream was decoded. */
export function dwfSheets(document: LoadedDwfDocument): DwfSheet[] {
  return document.pageData.map(page => {
    const supported = page.kind === 'w2d-text' && page.primitives.length > 0 || page.kind === 'xps-fixed-page';
    const reason = supported ? undefined : page.kind === 'image'
      ? 'Esta folha contém somente uma imagem de prévia; o vetor DWF não foi decodificado.'
      : page.kind === 'w3d-model' ? 'Modelo 3D não é uma prancha 2D mensurável.'
        : 'O leitor não conseguiu identificar geometria 2D nesta folha.';
    return { name: page.name, width: page.width, height: page.height, supported, reason };
  });
}

export async function openDwfSheets(file: Blob): Promise<LoadedDwfDocument> {
  const { openDwfDocument } = await import('dwf-viewer');
  const document = await openDwfDocument(file, { fileName: typeof File !== 'undefined' && file instanceof File ? file.name : 'planta.dwf' });
  if (!dwfSheets(document).some(sheet => sheet.supported)) throw new Error('DWF sem folha 2D vetorial compatível. Nenhuma planta foi cadastrada.');
  return document;
}
