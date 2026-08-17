import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import WarehouseStockTab from './WarehouseStockTab';

const { downloadAttachmentMock, openAttachmentMock } = vi.hoisted(() => ({
  downloadAttachmentMock: vi.fn(),
  openAttachmentMock: vi.fn(),
}));

vi.mock('@/lib/warehouseAttachments', () => ({
  downloadWarehouseAttachment: downloadAttachmentMock,
  openWarehouseAttachment: openAttachmentMock,
  warehouseAttachmentErrorMessage: () => 'Falha no anexo',
}));

function projectWithPurchaseHistory(): Project {
  const project: Project = {
    id: 'project-stock', name: 'Obra teste', startDate: '2026-08-01', endDate: '2026-12-31',
    totalBudget: 0, phases: [], warehouse: emptyWarehouse(),
  };
  const attachment = {
    id: 'attachment-1', name: 'nota.pdf', mimeType: 'application/pdf', uploadedAt: '2026-08-17T10:00:00.000Z',
    storagePath: 'project-stock/warehouse/nota.pdf',
  };
  project.warehouse!.items = [{
    key: 'warehouse-nf|item-1', code: 'MAT-01', description: 'Material de teste', unit: 'UN',
    manualItem: true, purchasedQuantity: 2,
  }];
  project.warehouse!.movements = [{
    id: 'entry-1', createdAt: '2026-08-17T10:00:00.000Z', type: 'entrada', date: '2026-08-17',
    itemKey: 'warehouse-nf|item-1', itemCode: 'MAT-01', itemDescription: 'Material de teste', itemUnit: 'UN',
    quantity: 2, unitPrice: 10, fiscalNoteId: 'note-1', invoiceNumber: '123', attachments: [attachment],
  }];
  project.warehouse!.fiscalNotes = [{
    id: 'note-1', createdAt: '2026-08-17T10:00:00.000Z', status: 'aprovada', origin: 'upload',
    sourceFileName: 'nota.pdf', supplierName: 'Fornecedor', invoiceNumber: '123', totalAmount: 20,
    attachment, attachments: [attachment],
    items: [{ id: 'item-1', itemKey: 'warehouse-nf|item-1', description: 'Material de teste', quantity: 2, unit: 'UN', unitPrice: 10, totalPrice: 20 }],
  }];
  return project;
}

describe('WarehouseStockTab - documentos no histórico', () => {
  beforeEach(() => {
    downloadAttachmentMock.mockReset().mockResolvedValue(undefined);
    openAttachmentMock.mockReset().mockResolvedValue(undefined);
  });

  it('oferece visualização e download pelo carregador interno', async () => {
    render(<WarehouseStockTab project={projectWithPurchaseHistory()} onProjectChange={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Histórico de compras'));
    const dialog = screen.getByRole('dialog');
    const viewButton = within(dialog).getByRole('button', { name: 'Visualizar NF' });
    const downloadButton = within(dialog).getByRole('button', { name: 'Baixar NF' });
    fireEvent.click(viewButton);
    fireEvent.click(downloadButton);
    expect(openAttachmentMock).toHaveBeenCalledTimes(1);
    expect(downloadAttachmentMock).toHaveBeenCalledTimes(1);
  });
});
