import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    id: 'note-1', createdAt: '2026-08-17T10:00:00.000Z', updatedAt: '2026-08-17T10:00:00.000Z', status: 'aprovada', origin: 'upload',
    sourceFileName: 'nota.pdf', supplierName: 'Fornecedor', invoiceNumber: '123', totalAmount: 20,
    attachment, attachments: [attachment],
    items: [{ id: 'item-1', itemKey: 'warehouse-nf|item-1', description: 'Material de teste', quantity: 2, unit: 'UN', unitPrice: 10, totalPrice: 20 }],
  }];
  return project;
}

function projectWithPlannedMaterials(): Project {
  const project = projectWithPurchaseHistory();
  project.analyticCompositions = [
    {
      id: 'composition-1', item: '1.1', code: 'COMP-1', bank: 'SINAPI', description: 'Serviço com argamassa',
      quantity: 10, unit: 'M²', unitPriceNoBDI: 0, unitPriceWithBDI: 0, total: 0,
      inputs: [{ id: 'input-1', code: 'ORC-ARG', bank: 'SINAPI', description: 'Argamassa colante AC II', unit: 'KG', coefficient: 2, unitPrice: 1, total: 2 }],
    },
    {
      id: 'composition-2', item: '1.2', code: 'COMP-2', bank: 'SINAPI', description: 'Serviço com tinta',
      quantity: 5, unit: 'M²', unitPriceNoBDI: 0, unitPriceWithBDI: 0, total: 0,
      inputs: [{ id: 'input-2', code: 'ORC-TINTA', bank: 'SINAPI', description: 'Tinta acrílica premium', unit: 'L', coefficient: 1, unitPrice: 1, total: 1 }],
    },
  ];
  return project;
}

describe('WarehouseStockTab - documentos no histórico', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    delete (Element.prototype as Element & { scrollIntoView?: () => void }).scrollIntoView;
  });

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

  it('mantém consulta e histórico sem oferecer arquivamento ao Almoxarife', () => {
    render(<WarehouseStockTab project={projectWithPurchaseHistory()} onProjectChange={vi.fn()} canArchive={false} />);

    expect(screen.queryByTitle('Arquivar e ocultar material')).not.toBeInTheDocument();
    expect(screen.getByTitle('Histórico de compras')).toBeInTheDocument();
  });

  it('reserva espaço para a descrição e mantém as ações alinhadas na tabela desktop', () => {
    const { container } = render(
      <WarehouseStockTab project={projectWithPurchaseHistory()} onProjectChange={vi.fn()} canDelete />,
    );

    const table = container.querySelector('table');
    const columns = table?.querySelectorAll('col');

    expect(table).toHaveClass('min-w-[1800px]');
    expect(columns?.[1]).toHaveClass('w-80');
    expect(columns).toHaveLength(17);
    expect(screen.getByText('Excluir', { selector: 'span' })).toBeInTheDocument();
  });

  it('pesquisa insumos previstos pela descrição sem exibir o código', () => {
    render(<WarehouseStockTab project={projectWithPlannedMaterials()} onProjectChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Revisar vínculos' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Selecionar insumo previsto' }));

    const search = screen.getByPlaceholderText('Digite uma palavra-chave...');
    fireEvent.change(search, { target: { value: 'argamassa' } });

    expect(screen.getByText('Argamassa colante AC II')).toBeInTheDocument();
    expect(screen.queryByText('Tinta acrílica premium')).not.toBeInTheDocument();
    expect(screen.queryByText(/ORC-ARG|ORC-TINTA/)).not.toBeInTheDocument();
  });
});
