import { supabase } from '@/integrations/supabase/client';
import type { WarehouseAttachment } from '@/types/project';

const BUCKET = 'daily-report-photos';

export type WarehouseAttachmentErrorCode = 'missing' | 'permission' | 'network' | 'popup' | 'unavailable';

export class WarehouseAttachmentError extends Error {
  constructor(public readonly code: WarehouseAttachmentErrorCode, message: string) {
    super(message);
    this.name = 'WarehouseAttachmentError';
  }
}

function classifyStorageError(error: unknown): WarehouseAttachmentError {
  const source = error as { message?: string; statusCode?: string | number; status?: string | number } | null;
  const message = source?.message?.toLowerCase() ?? '';
  const status = Number(source?.statusCode ?? source?.status ?? 0);
  if (status === 401 || status === 403 || /permission|policy|unauthorized|forbidden|row-level/.test(message)) {
    return new WarehouseAttachmentError('permission', 'Você não possui permissão para acessar este documento.');
  }
  if (status === 404 || /not found|does not exist|object not found/.test(message)) {
    return new WarehouseAttachmentError('missing', 'O arquivo original não foi encontrado no armazenamento.');
  }
  if (/network|fetch|timeout|connection|offline/.test(message)) {
    return new WarehouseAttachmentError('network', 'Não foi possível carregar o documento. Verifique sua conexão e tente novamente.');
  }
  return new WarehouseAttachmentError('unavailable', 'Não foi possível carregar o documento original.');
}

export async function loadWarehouseAttachmentBlob(attachment: WarehouseAttachment): Promise<Blob> {
  if (attachment.dataUrl) {
    try {
      const response = await fetch(attachment.dataUrl);
      if (!response.ok) throw new Error('dataURL inválido');
      return await response.blob();
    } catch {
      throw new WarehouseAttachmentError('unavailable', 'O anexo antigo está corrompido ou incompleto.');
    }
  }
  if (!attachment.storagePath) {
    throw new WarehouseAttachmentError('missing', 'O documento original não está disponível neste registro.');
  }
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(attachment.storagePath);
    if (error) throw error;
    if (!data) throw new WarehouseAttachmentError('missing', 'O arquivo original não foi encontrado no armazenamento.');
    return data;
  } catch (error) {
    if (error instanceof WarehouseAttachmentError) throw error;
    throw classifyStorageError(error);
  }
}

export function warehouseAttachmentErrorMessage(error: unknown): string {
  if (error instanceof WarehouseAttachmentError) return error.message;
  return 'Não foi possível abrir o documento original.';
}

export async function openWarehouseAttachment(attachment: WarehouseAttachment): Promise<void> {
  const popup = window.open('about:blank', '_blank');
  if (!popup) {
    throw new WarehouseAttachmentError('popup', 'O navegador bloqueou a nova aba. Autorize pop-ups para visualizar o documento.');
  }
  popup.opener = null;
  try {
    const blob = await loadWarehouseAttachmentBlob(attachment);
    const url = URL.createObjectURL(blob);
    popup.location.replace(url);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    popup.close();
    throw error;
  }
}

export async function downloadWarehouseAttachment(attachment: WarehouseAttachment): Promise<void> {
  const blob = await loadWarehouseAttachmentBlob(attachment);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = attachment.name || 'documento';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Limpeza complementar de objetos do Storage após exclusão confirmada do registro de origem. */
export async function deleteWarehouseAttachments(attachments?: WarehouseAttachment[]): Promise<void> {
  const paths = attachments?.flatMap(attachment => attachment.storagePath ? [attachment.storagePath] : []) ?? [];
  if (!paths.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) throw classifyStorageError(error);
}
