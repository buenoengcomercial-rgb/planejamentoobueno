import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WarehouseAttachment } from '@/types/project';
import {
  loadWarehouseAttachmentBlob,
  openWarehouseAttachment,
  warehouseAttachmentErrorMessage,
} from './warehouseAttachments';

const { downloadMock } = vi.hoisted(() => ({ downloadMock: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { storage: { from: () => ({ download: downloadMock }) } },
}));

function attachment(patch: Partial<WarehouseAttachment> = {}): WarehouseAttachment {
  return {
    id: 'attachment-1', name: 'nota.pdf', mimeType: 'application/pdf', uploadedAt: '2026-08-17T10:00:00.000Z',
    storagePath: 'project-1/warehouse/nota.pdf', ...patch,
  };
}

describe('anexos do almoxarifado', () => {
  beforeEach(() => {
    downloadMock.mockReset();
    vi.restoreAllMocks();
  });

  it('baixa o arquivo autenticado do Storage como Blob', async () => {
    const source = new Blob(['conteúdo'], { type: 'application/pdf' });
    downloadMock.mockResolvedValue({ data: source, error: null });
    const result = await loadWarehouseAttachmentBlob(attachment());
    expect(result).toBe(source);
    expect(downloadMock).toHaveBeenCalledWith('project-1/warehouse/nota.pdf');
  });

  it('mantém compatibilidade com dataURL antigo sem consultar o Storage', async () => {
    const result = await loadWarehouseAttachmentBlob(attachment({ storagePath: undefined, dataUrl: 'data:text/plain;base64,bm90YSBhbnRpZ2E=' }));
    expect(result).toMatchObject({ size: 11, type: 'text/plain' });
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('diferencia erro de permissão do arquivo ausente', async () => {
    downloadMock.mockResolvedValue({ data: null, error: { statusCode: 403, message: 'Forbidden by policy' } });
    await expect(loadWarehouseAttachmentBlob(attachment())).rejects.toMatchObject({ code: 'permission' });
    try {
      await loadWarehouseAttachmentBlob(attachment());
    } catch (error) {
      expect(warehouseAttachmentErrorMessage(error)).toMatch(/permissão/i);
    }
  });

  it('abre uma aba local antes do download e não navega para o domínio do Supabase', async () => {
    downloadMock.mockResolvedValue({ data: new Blob(['pdf'], { type: 'application/pdf' }), error: null });
    const replace = vi.fn();
    const popup = { opener: window, location: { replace }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const createObjectURL = vi.fn().mockReturnValue('blob:https://planejamentoobueno.local/documento');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    await openWarehouseAttachment(attachment());

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(replace).toHaveBeenCalledWith('blob:https://planejamentoobueno.local/documento');
    expect(replace).not.toHaveBeenCalledWith(expect.stringMatching(/supabase\.co/));
  });
});
