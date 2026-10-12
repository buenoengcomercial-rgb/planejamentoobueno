import type { LoadedDwfDocument, W2dPrimitive } from 'dwf-viewer';

export interface DwfSheet { name: string; width: number; height: number; supported: boolean; reason?: string }

/** A DWF sheet is measurable only when its own 2D vector stream was decoded. */
export function dwfSheets(document: LoadedDwfDocument): DwfSheet[] {
  return document.pageData.map(page => {
    const partial = page.kind === 'w2d-text' && page.diagnostics?.some(diagnostic => diagnostic.code === 'W2D_BINARY_PARTIAL');
    const supported = !partial && (page.kind === 'w2d-text' && page.primitives.length > 0 || page.kind === 'xps-fixed-page');
    const reason = supported ? undefined : partial
      ? 'Esta folha foi decodificada parcialmente; o leitor ainda não suporta toda a geometria DWF.'
      : page.kind === 'image'
      ? 'Esta folha contém somente uma imagem de prévia; o vetor DWF não foi decodificado.'
      : page.kind === 'w3d-model' ? 'Modelo 3D não é uma prancha 2D mensurável.'
        : 'O leitor não conseguiu identificar geometria 2D nesta folha.';
    return { name: page.name, width: page.width, height: page.height, supported, reason };
  });
}

export async function openDwfSheets(file: Blob): Promise<LoadedDwfDocument> {
  const { openDwfDocument } = await import('dwf-viewer');
  const document = await openDwfDocument(file, { fileName: typeof File !== 'undefined' && file instanceof File ? file.name : 'planta.dwf' });
  const sheets = dwfSheets(document);
  if (!sheets.some(sheet => sheet.supported)) throw new Error(sheets.find(sheet => sheet.reason)?.reason ?? 'DWF sem folha 2D vetorial compatível. Nenhuma planta foi cadastrada.');
  return rebaseDwfGeometry(document);
}

/** Keep Canvas path coordinates near zero; large WHIP origins lose precision in the browser's float32 path storage. */
export function rebaseDwfGeometry(document: LoadedDwfDocument): LoadedDwfDocument {
  return { ...document, pageData: document.pageData.map(page => {
    if (page.kind !== 'w2d-text' || !page.bounds) return page;
    const { minX, minY, maxX, maxY } = page.bounds;
    if (![minX, minY, maxX, maxY].every(Number.isFinite) || Math.max(Math.abs(minX), Math.abs(minY)) < 1_000_000) return page;
    return { ...page, bounds: { minX: 0, minY: 0, maxX: maxX - minX, maxY: maxY - minY }, primitives: page.primitives.map(primitive => {
      if (!primitive.matrix) return shiftPrimitive(primitive, minX, minY);
      // Retain rotation/scale/skew around a nearby local anchor and move only its translation.
      const [x, y] = primitiveAnchor(primitive);
      const { a, b, c, d, e, f } = primitive.matrix;
      return { ...shiftPrimitive(primitive, x, y), matrix: { a, b, c, d, e: a * x + c * y + e - minX, f: b * x + d * y + f - minY } };
    }) };
  }) };
}

function primitiveAnchor(primitive: W2dPrimitive): [number, number] {
  if ('points' in primitive) return [primitive.points[0] ?? 0, primitive.points[1] ?? 0];
  if (primitive.type === 'path') {
    const first = primitive.commands.find(command => 'x' in command && 'y' in command);
    return first && 'x' in first && 'y' in first ? [first.x, first.y] : [0, 0];
  }
  return [primitive.x, primitive.y];
}

function shiftPrimitive(primitive: W2dPrimitive, x: number, y: number): W2dPrimitive {
  if ('points' in primitive) return { ...primitive, points: primitive.points.map((coordinate, index) => coordinate - (index % 2 === 0 ? x : y)) };
  if (primitive.type === 'path') return { ...primitive, commands: primitive.commands.map(command => {
    switch (command.type) {
      case 'M': case 'L': case 'A': return { ...command, x: command.x - x, y: command.y - y };
      case 'C': return { ...command, x: command.x - x, y: command.y - y, x1: command.x1 - x, y1: command.y1 - y, x2: command.x2 - x, y2: command.y2 - y };
      case 'Q': return { ...command, x: command.x - x, y: command.y - y, x1: command.x1 - x, y1: command.y1 - y };
      case 'Z': return command;
    }
  }) };
  return { ...primitive, x: primitive.x - x, y: primitive.y - y };
}
