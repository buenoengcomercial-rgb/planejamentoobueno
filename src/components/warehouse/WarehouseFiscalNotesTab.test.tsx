import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, WarehouseFiscalNote } from '@/types/project';
import { computeWarehouseRows, emptyWarehouse } from '@/lib/warehouse';
import WarehouseFiscalNotesTab from './WarehouseFiscalNotesTab';

const { downloadMock, invokeMock, uploadMock } = vi.hoisted(() => ({
  downloadMock: vi.fn(),
  invokeMock: vi.fn(),
  uploadMock: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: invokeMock },
    storage: {
      from: () => ({
        upload: uploadMock,
        download: downloadMock,
      }),
    },
  },
}));

function projectWithPostedNote(): Project {
  const fiscalNote: WarehouseFiscalNote = {
    id: 'posted-note', createdAt: '2026-08-15T10:00:00.000Z', updatedAt: '2026-08-15T10:00:00.000Z',
    createdBy: { userId: 'user-a', userName: 'Alice', userEmail: 'alice@teste.com' },
    updatedBy: { userId: 'user-b', userName: 'Bruno', userEmail: 'bruno@teste.com' },
    status: 'aprovada', origin: 'upload', sourceFileName: 'whatsapp-image.jpg',
    supplierName: 'FREITAS & CIA LTDA', supplierCnpj: '02.179.328/0001-42', invoiceNumber: '1.301.412',
    issueDate: '2026-08-14', totalAmount: 85.63,
    items: [{
      id: 'posted-item', itemKey: 'warehouse-nf|material-1', productCode: '7563',
      description: 'FITA CREPE 24MM X 50M', quantity: 2, unit: 'UN', unitPrice: 42.815, totalPrice: 85.63,
    }],
  };
  const project: Project = {
    id: 'project-ui', name: 'Obra teste', startDate: '2026-08-01', endDate: '2026-12-31',
    totalBudget: 0, phases: [], warehouse: emptyWarehouse(),
    materialComparisons: [{ id: 'group-1', name: 'Ferramentas' }] as Project['materialComparisons'],
  };
  project.warehouse!.fiscalNotes = [fiscalNote];
  project.warehouse!.items = [{ key: 'warehouse-nf|material-1', description: 'FITA CREPE 24MM X 50M', unit: 'UN', manualItem: true }];
  return project;
}

function emptyProject(): Project {
  const project = projectWithPostedNote();
  project.warehouse!.fiscalNotes = [];
  project.warehouse!.items = [];
  return project;
}

function projectWithLegacyDraft(): Project {
  const project = projectWithPostedNote();
  project.warehouse!.items = [];
  project.warehouse!.fiscalNotes = [{
    ...project.warehouse!.fiscalNotes[0],
    id: 'incomplete-draft',
    status: 'a_conferir',
    items: [],
    stockPostedAt: undefined,
    stockPostedBy: undefined,
  }];
  return project;
}

function projectWithArchivedOrphan(): Project {
  const project = projectWithPostedNote();
  const note = project.warehouse!.fiscalNotes[0];
  note.status = 'rejeitada';
  note.archiveReason = 'descartada';
  note.stockPostedAt = '2026-08-15T10:00:00.000Z';
  note.attachment = {
    id: 'attachment-1', name: 'nota.pdf', mimeType: 'application/pdf', uploadedAt: '2026-08-15T10:00:00.000Z',
    storagePath: 'project-ui/warehouse/nota.pdf',
  };
  note.attachments = [note.attachment];
  project.warehouse!.items[0].purchasedQuantity = 2;
  project.warehouse!.movements = [{
    id: 'entry-1', createdAt: '2026-08-15T10:00:00.000Z', type: 'entrada', date: '2026-08-15',
    itemKey: 'warehouse-nf|material-1', itemCode: '7563', itemDescription: 'FITA CREPE 24MM X 50M', itemUnit: 'UN',
    quantity: 2, unitPrice: 42.815, fiscalNoteId: note.id, invoiceNumber: note.invoiceNumber, attachments: note.attachments,
  }];
  return project;
}

async function readDocument(container: HTMLElement, name = 'nota.jpg') {
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  const file = new File(['imagem da nota'], name, { type: 'application/octet-stream' });
  fireEvent.change(inputs[1], { target: { files: [file] } });
  fireEvent.click(await screen.findByRole('button', { name: 'Enviar para leitura' }));
  expect(await screen.findByText('Validar nota antes do lançamento')).toBeInTheDocument();
}

describe('WarehouseFiscalNotesTab - validação manual antes do lançamento', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue({
      data: {
        ok: true,
        note: {
          supplierName: 'FREITAS & CIA LTDA',
          supplierCnpj: '02.179.328/0001-42',
          invoiceNumber: '1.301.412',
          issueDate: '2026-08-14',
          totalAmount: 85.63,
          items: [{ id: 'read-item', productCode: '7563', description: 'FITA CREPE 24MM X 50M', quantity: 2, unit: 'UN', unitPrice: 42.815, totalPrice: 85.63 }],
        },
      },
      error: null,
    });
    uploadMock.mockReset().mockResolvedValue({ error: null });
    downloadMock.mockReset().mockResolvedValue({ data: new Blob(['nota'], { type: 'application/pdf' }), error: null });
  });

  it('mostra somente lançadas/arquivadas e restaura as colunas sem Arquivo', () => {
    render(<WarehouseFiscalNotesTab project={projectWithPostedNote()} onProjectChange={vi.fn()} canManage />);
    expect(screen.queryByText(/Para conferir/i)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Lançadas no estoque \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Arquivadas \(0\)/i })).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader').map(header => header.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Fornecedor', 'Nº', 'CNPJ', 'Nota', 'Data', 'Itens', 'Valor', 'Status', 'Incluído / alterado por', 'Ações']));
    expect(headers).not.toContain('Arquivo');
    expect(screen.getAllByText(/Incluído por:/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Alice/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Bruno/i).length).toBeGreaterThan(0);
  });

  it('não mostra classificação não fiscal e exibe cabeçalhos e grupo de compra', () => {
    render(<WarehouseFiscalNotesTab project={projectWithPostedNote()} onProjectChange={vi.fn()} canManage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Visualizar dados e grupos' })[0]);
    expect(screen.queryByText(/Documento não fiscal/i)).not.toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    const headers = within(dialog).getAllByRole('columnheader').map(header => header.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Cód. prod.', 'Descrição', 'Qtd', 'Un', 'V. unit. NF', 'V. unit. global', 'V. total', 'Grupo de compra']));
    expect(within(dialog).getAllByRole('combobox')).not.toHaveLength(0);
    within(dialog).getAllByRole('combobox').forEach(combobox => expect(combobox).toBeEnabled());
  });

  it('lê a nota e permite lançar sem classificação orçamentária', async () => {
    const onProjectChange = vi.fn();
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={onProjectChange} canManage auditActor={{ userName: 'Operador' }} />);
    await readDocument(view.container);
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(screen.getByText(/O estoque ainda não foi alterado/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmar lançamento' })).toBeEnabled();
    expect(screen.queryByText('Vínculo com o orçamento')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Insumo do orçamento para/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Confirmação pendente')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Por que não estava previsto?')).not.toBeInTheDocument();
  });

  it('fecha pelo X e cancela o envio sem criar registro, material ou movimento', async () => {
    const onProjectChange = vi.fn();
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={onProjectChange} canManage />);
    await readDocument(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Validar nota antes do lançamento')).not.toBeInTheDocument());
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /Lançadas no estoque \(0\)/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Arquivadas \(0\)/i })).toBeInTheDocument();
  });

  it('cria nota, material e uma única entrada somente após confirmação', async () => {
    const onProjectChange = vi.fn();
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={onProjectChange} canManage auditActor={{ userName: 'Operador' }} />);
    await readDocument(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar lançamento' }));
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(1));
    const posted = onProjectChange.mock.calls[0][0] as Project;
    expect(posted.warehouse!.fiscalNotes).toHaveLength(1);
    expect(posted.warehouse!.fiscalNotes[0].status).toBe('aprovada');
    expect(posted.warehouse!.items).toHaveLength(1);
    expect(posted.warehouse!.movements.filter(movement => movement.type === 'entrada')).toHaveLength(1);
    expect(posted.warehouse!.materialLinks).toHaveLength(0);
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('identifica a nota duplicada e permite abrir o lançamento existente sem salvar o novo envio', async () => {
    const onProjectChange = vi.fn();
    const view = render(<WarehouseFiscalNotesTab project={projectWithPostedNote()} onProjectChange={onProjectChange} canManage />);
    await readDocument(view.container, 'duplicada.jpg');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByText(/FREITAS & CIA LTDA/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Nota 1\.301\.412/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar lançamento' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir lançamento existente' }));
    expect(await screen.findByText('Dados do lançamento')).toBeInTheDocument();
    expect(onProjectChange).not.toHaveBeenCalled();
  });

  it('mantém a validação aberta quando a leitura falha e permite preenchimento manual', async () => {
    invokeMock.mockResolvedValueOnce({ data: { ok: false, error: 'Imagem ilegível' }, error: null });
    const onProjectChange = vi.fn();
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={onProjectChange} canManage />);
    await readDocument(view.container, 'ilegivel.jpg');
    expect(screen.getByText('Imagem ilegível')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar leitura novamente' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar item' }));
    expect(screen.getByText('Itens do documento (1)')).toBeInTheDocument();
    expect(onProjectChange).not.toHaveBeenCalled();
  });

  it('arquiva rascunho técnico antigo uma única vez sem movimentar estoque', async () => {
    const onProjectChange = vi.fn();
    render(<WarehouseFiscalNotesTab project={projectWithLegacyDraft()} onProjectChange={onProjectChange} canManage auditActor={{ userName: 'Operador' }} />);
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(1));
    const archived = onProjectChange.mock.calls[0][0] as Project;
    expect(archived.warehouse!.fiscalNotes[0]).toMatchObject({ status: 'rejeitada', archiveReason: 'descartada' });
    expect(archived.warehouse!.items).toHaveLength(0);
    expect(archived.warehouse!.movements).toHaveLength(0);
  });

  it('revisa e corrige estoque ativo deixado por nota arquivada', async () => {
    const onProjectChange = vi.fn();
    render(<WarehouseFiscalNotesTab project={projectWithArchivedOrphan()} onProjectChange={onProjectChange} canManage auditActor={{ userName: 'Administrador' }} />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Arquivadas \(1\)/i }), { button: 0, ctrlKey: false });
    expect(await screen.findByText('Estoque antigo precisa de revisão')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revisar e corrigir estoque' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Quantidade a estornar/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 UN/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirmar 1 correção/i }));
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(1));
    const reconciled = onProjectChange.mock.calls[0][0] as Project;
    expect(reconciled.warehouse!.movements.filter(movement => movement.type === 'estorno')).toHaveLength(1);
    expect(computeWarehouseRows(reconciled, { includeManual: true })).toHaveLength(0);
  });

  it('oferece visualizar e baixar o documento preservado', () => {
    render(<WarehouseFiscalNotesTab project={projectWithArchivedOrphan()} onProjectChange={vi.fn()} canManage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Arquivadas \(1\)/i }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getAllByRole('button', { name: 'Visualizar dados e grupos' })[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Visualizar documento/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Baixar' })).toBeInTheDocument();
  });
});
