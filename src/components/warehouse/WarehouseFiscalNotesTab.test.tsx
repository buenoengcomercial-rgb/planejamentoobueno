import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, WarehouseFiscalNote } from '@/types/project';
import { computeWarehouseRows, emptyWarehouse } from '@/lib/warehouse';
import WarehouseFiscalNotesTab from './WarehouseFiscalNotesTab';

const { createHeaderImageMock, createObjectURLMock, destroyPdfMock, downloadMock, getDocumentMock, invokeMock, removeMock, renderPdfPageMock, revokeObjectURLMock, uploadMock } = vi.hoisted(() => ({
  createHeaderImageMock: vi.fn(),
  createObjectURLMock: vi.fn(),
  destroyPdfMock: vi.fn(),
  downloadMock: vi.fn(),
  getDocumentMock: vi.fn(),
  invokeMock: vi.fn(),
  removeMock: vi.fn(),
  renderPdfPageMock: vi.fn(),
  revokeObjectURLMock: vi.fn(),
  uploadMock: vi.fn(),
}));

vi.mock('@/lib/fiscalSupplierHeaderImage', () => ({
  createSupplierHeaderImageDataUrl: createHeaderImageMock,
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: getDocumentMock,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: invokeMock },
    storage: {
      from: () => ({
        upload: uploadMock,
        download: downloadMock,
        remove: removeMock,
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
  fireEvent.click(await screen.findByRole('button', { name: 'Ler documento' }));
  expect(await screen.findByText('Validar entrada antes do lançamento')).toBeInTheDocument();
}

describe('WarehouseFiscalNotesTab - validação manual antes do lançamento', () => {
  beforeEach(() => {
    createHeaderImageMock.mockReset().mockResolvedValue('data:image/jpeg;base64,Y2FiZWNhbGhv');
    invokeMock.mockReset().mockResolvedValue({
      data: {
        ok: true,
        readerVersion: 'issuer-address-v1',
        note: {
          supplierName: 'FREITAS & CIA LTDA',
          supplierCnpj: '02.179.328/0001-42',
          supplierState: null,
          supplierCity: 'São Paulo',
          supplierHeaderText: 'B LUX MATERIAIS ELETRICOS LTDA SÃO PAULO - SP',
          supplierLocationText: 'SÃO PAULO - SP',
          invoiceNumber: '1.301.412',
          issueDate: '2026-08-14',
          totalAmount: 85.63,
          items: [{ id: 'read-item', productCode: '7563', description: 'FITA CREPE 24MM X 50M', quantity: 2, unit: 'UN', unitPrice: 42.815, totalPrice: 85.63 }],
        },
      },
      error: null,
    });
    uploadMock.mockReset().mockResolvedValue({ error: null });
    removeMock.mockReset().mockResolvedValue({ error: null });
    const pdfBlob = new Blob(['nota'], { type: 'application/pdf' });
    Object.defineProperty(pdfBlob, 'arrayBuffer', { configurable: true, value: vi.fn().mockResolvedValue(new ArrayBuffer(8)) });
    downloadMock.mockReset().mockResolvedValue({ data: pdfBlob, error: null });
    destroyPdfMock.mockReset().mockResolvedValue(undefined);
    renderPdfPageMock.mockReset().mockReturnValue({ promise: Promise.resolve() });
    getDocumentMock.mockReset().mockReturnValue({ promise: Promise.resolve({
      numPages: 2,
      getPage: vi.fn().mockResolvedValue({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 840 * scale }),
        render: renderPdfPageMock,
      }),
      destroy: destroyPdfMock,
    }) });
    createObjectURLMock.mockReset().mockReturnValue('blob:nota-fiscal');
    revokeObjectURLMock.mockReset();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLMock });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLMock });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: vi.fn().mockReturnValue({}) });
    Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', { configurable: true, value: vi.fn().mockReturnValue('data:image/png;base64,cGFnZQ==') });
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
    expect(headers).toEqual(expect.arrayContaining(['Cód. prod.', 'Descrição', 'Qtd. NF', 'Un. NF', 'V. unit. NF', 'Total NF', 'V. unit. global', 'V. total global', 'Grupo de compra']));
    expect(headers).not.toEqual(expect.arrayContaining(['Qtd. estoque', 'Un. estoque', 'Fator']));
    expect(within(dialog).getByRole('combobox', { name: 'UF do fornecedor' })).toBeEnabled();
    expect(within(dialog).getByRole('combobox', { name: 'UF da obra' })).toBeDisabled();
    expect(within(dialog).getByRole('combobox', { name: 'UF da obra' })).toHaveTextContent('RO');
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
    expect(screen.getByRole('combobox', { name: 'UF do fornecedor' })).toHaveTextContent('SP');
    expect(screen.getByRole('combobox', { name: 'UF da obra' })).toHaveTextContent('RO');
    expect(screen.getByRole('combobox', { name: 'UF da obra' })).toBeDisabled();
    expect(screen.getByText('Frete/ICMS pendentes')).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][1].body.supplierHeaderImageDataUrl).toBe('data:image/jpeg;base64,Y2FiZWNhbGhv');
  });

  it('continua com a imagem completa em uma única chamada quando o recorte do cabeçalho falha', async () => {
    createHeaderImageMock.mockResolvedValueOnce(undefined);
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={vi.fn()} canManage />);

    await readDocument(view.container, 'foto-horizontal.jpg');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][1].body.supplierHeaderImageDataUrl).toBeUndefined();
    expect(screen.getByRole('combobox', { name: 'UF do fornecedor' })).toHaveTextContent('SP');
  });

  it('fecha pelo X e cancela o envio sem criar registro, material ou movimento', async () => {
    const onProjectChange = vi.fn();
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={onProjectChange} canManage />);
    await readDocument(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Validar entrada antes do lançamento')).not.toBeInTheDocument());
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
    expect(posted.warehouse!.fiscalNotes[0]).not.toHaveProperty('supplierCity');
    expect(posted.warehouse!.fiscalNotes[0]).not.toHaveProperty('supplierHeaderText');
    expect(posted.warehouse!.fiscalNotes[0]).not.toHaveProperty('supplierLocationText');
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('confirma a nota imediatamente na nuvem antes de fechar o formulário', async () => {
    const onProjectChange = vi.fn();
    const onCommitProject = vi.fn().mockResolvedValue(undefined);
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={onProjectChange} onCommitProject={onCommitProject} canManage />);
    await readDocument(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar lançamento' }));
    await waitFor(() => expect(onCommitProject).toHaveBeenCalledTimes(1));
    expect(onProjectChange).not.toHaveBeenCalled();
    expect((onCommitProject.mock.calls[0][0] as Project).warehouse!.fiscalNotes[0].status).toBe('aprovada');
    await waitFor(() => expect(screen.queryByText('Validar entrada antes do lançamento')).not.toBeInTheDocument());
  });

  it('não lança nem movimenta o estoque quando o anexo falha na nuvem', async () => {
    uploadMock.mockResolvedValueOnce({ error: new Error('sem conexão') });
    const onProjectChange = vi.fn();
    const onCommitProject = vi.fn().mockResolvedValue(undefined);
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={onProjectChange} onCommitProject={onCommitProject} canManage />);
    await readDocument(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar lançamento' }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar lançamento' })).toBeEnabled());
    expect(onCommitProject).not.toHaveBeenCalled();
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(screen.getByText('Validar entrada antes do lançamento')).toBeInTheDocument();
  });

  it('reutiliza o anexo já enviado quando a confirmação da obra precisa ser repetida', async () => {
    const onCommitProject = vi.fn()
      .mockRejectedValueOnce(new Error('falha temporária'))
      .mockResolvedValueOnce(undefined);
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={vi.fn()} onCommitProject={onCommitProject} canManage />);
    await readDocument(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar lançamento' }));
    await waitFor(() => expect(onCommitProject).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar lançamento' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar lançamento' }));
    await waitFor(() => expect(onCommitProject).toHaveBeenCalledTimes(2));
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
    expect(await screen.findByText('Dados da entrada')).toBeInTheDocument();
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

  it('informa quando a Edge Function publicada está desatualizada e mantém o modal aberto', async () => {
    invokeMock.mockResolvedValueOnce({
      data: { ok: true, note: { supplierName: 'B LUX MATERIAIS ELETRICOS LTDA', items: [] } },
      error: null,
    });
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={vi.fn()} canManage />);
    await readDocument(view.container, 'b-lux.jpg');
    expect(screen.getByText(/Leitor de notas desatualizado/i)).toBeInTheDocument();
    expect(screen.getByText('Leitura incompleta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar leitura novamente' })).toBeInTheDocument();
  });

  it('mantém a mesma janela aberta durante a leitura e troca para a conferência sem voltar à página', async () => {
    let resolveRead!: (value: unknown) => void;
    invokeMock.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={vi.fn()} canManage />);
    const file = new File(['imagem'], 'nota.jpg', { type: 'image/jpeg' });
    fireEvent.change(view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], { target: { files: [file] } });
    expect(await screen.findByRole('heading', { name: 'Registrar entrada' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ler documento' }));
    expect(screen.getByText('Lendo o documento. Permaneça nesta janela.')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await act(async () => resolveRead({
      data: { ok: true, readerVersion: 'issuer-address-v1', note: { supplierName: 'Fornecedor', totalAmount: 10, items: [{ description: 'Tubo', quantity: 1, unit: 'UN', unitPrice: 10, totalPrice: 10 }] } },
      error: null,
    }));
    expect(await screen.findByText('Validar entrada antes do lançamento')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('mantém itens móveis recolhidos e expande somente o item tocado', async () => {
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={vi.fn()} canManage />);
    await readDocument(view.container);
    const dialog = screen.getByRole('dialog');
    const headers = within(dialog).getAllByRole('columnheader').map(header => header.textContent);
    expect(headers).not.toEqual(expect.arrayContaining(['Qtd. estoque', 'Un. estoque', 'Fator']));
    const itemButton = screen.getByRole('button', { name: /FITA CREPE 24MM X 50M/i });
    expect(itemButton).toHaveAttribute('aria-expanded', 'false');
    expect(itemButton).toHaveTextContent('2,00 UN');
    expect(within(itemButton).getByText('FITA CREPE 24MM X 50M')).toHaveClass('line-clamp-2');
    expect(screen.queryByText('Dados da nota')).not.toBeInTheDocument();
    fireEvent.click(itemButton);
    expect(itemButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Dados da nota')).toBeInTheDocument();
    expect(screen.getByText('Custo real rateado')).toBeInTheDocument();
    expect(screen.queryByText('Entrada no estoque')).not.toBeInTheDocument();
    expect(screen.queryByText('Quantidade estoque')).not.toBeInTheDocument();
    expect(screen.queryByText('Unidade estoque')).not.toBeInTheDocument();
    expect(screen.queryByText('Fator de conversão')).not.toBeInTheDocument();
  });

  it('formata quantidades e valores com duas casas após a edição', async () => {
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={vi.fn()} canManage />);
    await readDocument(view.container);
    const quantity = screen.getByLabelText('Quantidade NF do item 1 na tabela');
    const unitPrice = screen.getByLabelText('Valor unitário NF do item 1 na tabela');
    const totalPrice = screen.getByLabelText('Total NF do item 1 na tabela');

    expect(quantity).toHaveValue('2,00');
    expect(unitPrice).toHaveValue('42,82');
    expect(totalPrice).toHaveValue('85,63');

    for (const [typed, formatted] of [['1', '1,00'], ['1,5', '1,50'], ['1.5', '1,50'], ['0', '0,00']]) {
      fireEvent.focus(quantity);
      fireEvent.change(quantity, { target: { value: typed } });
      fireEvent.blur(quantity);
      expect(quantity).toHaveValue(formatted);
    }

    fireEvent.focus(quantity);
    fireEvent.change(quantity, { target: { value: '2' } });
    fireEvent.blur(quantity);
    fireEvent.focus(unitPrice);
    fireEvent.change(unitPrice, { target: { value: '50' } });
    fireEvent.blur(unitPrice);
    expect(unitPrice).toHaveValue('50,00');
    expect(totalPrice).toHaveValue('100,00');
  });

  it('usa descrição de duas linhas com crescimento automático no desktop e no celular', async () => {
    const view = render(<WarehouseFiscalNotesTab project={emptyProject()} onProjectChange={vi.fn()} canManage />);
    await readDocument(view.container);
    const desktopDescription = screen.getByLabelText('Descrição do item 1 na tabela');
    expect(desktopDescription.tagName).toBe('TEXTAREA');
    expect(desktopDescription).toHaveAttribute('rows', '2');
    expect(desktopDescription).toHaveClass('resize-none', 'overflow-hidden');

    fireEvent.change(desktopDescription, { target: { value: 'DESCRIÇÃO LONGA DO MATERIAL QUE PRECISA OCUPAR MAIS DE DUAS LINHAS PARA SER LIDA POR INTEIRO' } });
    expect(desktopDescription).toHaveValue('DESCRIÇÃO LONGA DO MATERIAL QUE PRECISA OCUPAR MAIS DE DUAS LINHAS PARA SER LIDA POR INTEIRO');

    fireEvent.click(screen.getByRole('button', { name: /DESCRIÇÃO LONGA DO MATERIAL/i }));
    const mobileDescription = screen.getByLabelText('Descrição do item 1 no celular');
    expect(mobileDescription.tagName).toBe('TEXTAREA');
    expect(mobileDescription).toHaveAttribute('rows', '2');
    expect(mobileDescription).toHaveClass('text-base');
  });

  it('sinaliza compra interestadual sem bloquear e restringe a revisão tardia à engenharia', () => {
    const project = projectWithPostedNote();
    project.warehouse!.fiscalNotes![0] = { ...project.warehouse!.fiscalNotes![0], supplierState: 'SP', destinationState: 'RO' };
    render(<WarehouseFiscalNotesTab project={project} onProjectChange={vi.fn()} canManage canReviewCosts={false} />);
    expect(screen.getByRole('button', { name: /Pendências fiscais \(1\)/i })).toBeInTheDocument();
    expect(screen.getAllByText('Frete/ICMS pendentes').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Visualizar dados e grupos' })[0]);
    expect(screen.getByLabelText('Frete adicional')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Confirmar custos' })).not.toBeInTheDocument();
  });

  it('permite à engenharia confirmar frete e ICMS explicitamente em zero', async () => {
    const project = projectWithPostedNote();
    project.warehouse!.fiscalNotes![0] = { ...project.warehouse!.fiscalNotes![0], supplierState: 'SP', destinationState: 'RO' };
    const onProjectChange = vi.fn();
    render(<WarehouseFiscalNotesTab project={project} onProjectChange={onProjectChange} canManage canReviewCosts />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Visualizar dados e grupos' })[0]);
    fireEvent.change(screen.getByLabelText('Frete adicional'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('ICMS/DIFAL adicional'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar custos' }));
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledTimes(1));
    expect((onProjectChange.mock.calls[0][0] as Project).warehouse!.fiscalNotes![0]).toMatchObject({ costReviewStatus: 'confirmed', freightAmount: 0, icmsAmount: 0 });
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

  it('renderiza todas as páginas do PDF internamente sem depender de iframe ou aba em branco', async () => {
    const open = vi.spyOn(window, 'open');
    const view = render(<WarehouseFiscalNotesTab project={projectWithArchivedOrphan()} onProjectChange={vi.fn()} canManage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Arquivadas \(1\)/i }), { button: 0, ctrlKey: false });

    fireEvent.click(screen.getAllByRole('button', { name: 'Abrir documento original' })[0]);

    const preview = await screen.findByLabelText('Visualização de nota.pdf');
    expect(within(preview).getAllByRole('img')).toHaveLength(2);
    expect(within(preview).getByRole('img', { name: 'Página 1 de nota.pdf' })).toHaveAttribute('src', 'data:image/png;base64,cGFnZQ==');
    expect(screen.queryByTitle('Visualização de nota.pdf')).not.toBeInTheDocument();
    expect(downloadMock).toHaveBeenCalledWith('project-ui/warehouse/nota.pdf');
    expect(getDocumentMock).toHaveBeenCalled();
    expect(renderPdfPageMock).toHaveBeenCalledTimes(2);
    expect(destroyPdfMock).toHaveBeenCalled();
    expect(createObjectURLMock).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(revokeObjectURLMock).not.toHaveBeenCalled();
    view.unmount();
  });

  it('orienta baixar o arquivo quando o conteúdo não é um PDF válido', async () => {
    getDocumentMock.mockImplementationOnce(() => ({ promise: Promise.reject(new Error('Invalid PDF structure')) }));
    render(<WarehouseFiscalNotesTab project={projectWithArchivedOrphan()} onProjectChange={vi.fn()} canManage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Arquivadas \(1\)/i }), { button: 0, ctrlKey: false });

    fireEvent.click(screen.getAllByRole('button', { name: 'Abrir documento original' })[0]);

    expect(await screen.findByText(/Não foi possível renderizar este PDF/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Baixar' })).toBeInTheDocument();
  });

  it('mostra o erro do Storage dentro do visualizador sem abandonar a tela', async () => {
    downloadMock.mockResolvedValueOnce({ data: null, error: { statusCode: 403, message: 'Forbidden by policy' } });
    render(<WarehouseFiscalNotesTab project={projectWithArchivedOrphan()} onProjectChange={vi.fn()} canManage />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Arquivadas \(1\)/i }), { button: 0, ctrlKey: false });

    fireEvent.click(screen.getAllByRole('button', { name: 'Abrir documento original' })[0]);

    expect(await screen.findByText(/não possui permissão para acessar este documento/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Documento original' })).toBeInTheDocument();
  });
});
