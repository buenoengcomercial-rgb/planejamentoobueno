import { describe, expect, it } from 'vitest';
import type { Project, WarehouseFiscalNote } from '@/types/project';
import {
  approveFiscalNote,
  archiveFiscalNote,
  archiveLegacyFiscalNoteDrafts,
  cancelFiscalNote,
  checkFiscalNoteCancellation,
  classifyFiscalDocumentText,
  computeWarehouseRows,
  createRequisition,
  deliverRequisition,
  emptyWarehouse,
  ensureWarehouse,
  findFiscalNoteDuplicate,
  fiscalItemConversionFactor,
  fiscalItemGlobalUnitPrice,
  fiscalItemStockQuantity,
  fiscalNoteAllocatedExtras,
  fiscalNoteCostReviewStatus,
  isStockFiscalDocument,
  reconcileArchivedFiscalNoteStock,
  reviewArchivedFiscalNoteStock,
  reviewPostedFiscalNoteCosts,
  updateFiscalItemPurchaseGroup,
} from './warehouse';

function baseProject(): Project {
  return {
    id: 'cpa-test', name: 'CPA OBRA - teste local', startDate: '2026-08-01', endDate: '2026-12-31',
    totalBudget: 0, phases: [], warehouse: emptyWarehouse(),
  };
}

function note(patch: Partial<WarehouseFiscalNote> = {}): WarehouseFiscalNote {
  return {
    id: 'nf-1', createdAt: '2026-08-15T10:00:00.000Z', updatedAt: '2026-08-15T10:00:00.000Z',
    status: 'a_conferir', origin: 'upload', sourceFileName: 'nota.pdf', documentType: 'nfe',
    supplierName: 'Fornecedor Teste', supplierCnpj: '12.345.678/0001-95', invoiceNumber: '100',
    issueDate: '2026-08-15', totalAmount: 100,
    items: [{ id: 'item-1', productCode: 'MAT-01', description: 'Cimento CP II', quantity: 2, unit: 'SC', unitPrice: 50, totalPrice: 100 }],
    ...patch,
  };
}

function withNote(entry: WarehouseFiscalNote) {
  const project = baseProject();
  project.warehouse!.fiscalNotes = [entry];
  return project;
}

describe('fluxo de documentos fiscais do almoxarifado', () => {
  it('classifica Pedido de Venda 915 como comprovante não fiscal', () => {
    const type = classifyFiscalDocumentText('Bling - Pedido de Venda Nº 915 - Itens do pedido');
    expect(type).toBe('pedido_venda');
    expect(isStockFiscalDocument(type)).toBe(false);
  });

  it('recupera leitura interrompida como rascunho editável', () => {
    const project = withNote(note({ status: 'em_processamento', extractionStatus: undefined }));
    const normalized = ensureWarehouse(project).warehouse!.fiscalNotes[0];
    expect(normalized.status).toBe('a_conferir');
    expect(normalized.extractionStatus).toBe('failed');
    expect(normalized.processingError).toMatch(/interrompida/i);
  });

  it('detecta duplicidade por fornecedor e número antes do lançamento', () => {
    const existing = note({ status: 'aprovada' });
    const candidate = note({ id: 'nf-candidate' });
    expect(findFiscalNoteDuplicate(withNote(existing), candidate)?.id).toBe(existing.id);
  });

  it('bloqueia no domínio uma segunda entrada para nota já aprovada', () => {
    const existing = note({ id: 'existing', status: 'aprovada' });
    const candidate = note({ id: 'candidate' });
    const project = baseProject();
    project.warehouse!.fiscalNotes = [existing, candidate];
    expect(() => approveFiscalNote(project, candidate.id)).toThrow(/já foi lançada no estoque/i);
    expect(project.warehouse!.movements).toHaveLength(0);
  });

  it.each(['rejeitada', 'cancelada'] as const)('não trata nota %s como bloqueio para novo upload', status => {
    const previous = note({ id: 'previous', status });
    const candidate = note({ id: 'candidate' });
    const project = baseProject();
    project.warehouse!.fiscalNotes = [previous, candidate];
    expect(findFiscalNoteDuplicate(project, candidate)).toBeUndefined();
    const posted = approveFiscalNote(project, candidate.id);
    expect(posted.warehouse!.fiscalNotes.find(entry => entry.id === candidate.id)?.status).toBe('aprovada');
  });

  it('lança Pedido de Venda no estoque independentemente da classificação documental', () => {
    const project = withNote(note({ id: 'pedido-915', documentType: 'pedido_venda', invoiceNumber: '915' }));
    const posted = approveFiscalNote(project, 'pedido-915', 'operador@teste');
    expect(posted.warehouse!.fiscalNotes[0].status).toBe('aprovada');
    expect(posted.warehouse!.items).toHaveLength(1);
    expect(posted.warehouse!.movements).toHaveLength(1);
  });

  it.each(['recibo', 'outro'] as const)('lança documento %s quando existe item válido', documentType => {
    const posted = approveFiscalNote(withNote(note({ documentType })), 'nf-1');
    expect(posted.warehouse!.fiscalNotes[0].status).toBe('aprovada');
    expect(computeWarehouseRows(posted, { includeManual: true })[0].balance).toBe(2);
  });

  it('exige ao menos um item válido e aplica UN quando a unidade está vazia', () => {
    const invalid = withNote(note({ items: [] }));
    expect(() => approveFiscalNote(invalid, 'nf-1')).toThrow(/ao menos um item/i);
    const posted = approveFiscalNote(withNote(note({ items: [{ ...note().items[0], unit: '' }] })), 'nf-1');
    expect(posted.warehouse!.fiscalNotes[0].items[0].unit).toBe('UN');
  });

  it('não gera duas entradas ao repetir a aprovação', () => {
    const approved = approveFiscalNote(withNote(note()), 'nf-1', 'engenheiro@teste');
    const repeated = approveFiscalNote(approved, 'nf-1', 'engenheiro@teste');
    expect(repeated.warehouse!.movements.filter(movement => movement.type === 'entrada')).toHaveLength(1);
    expect(computeWarehouseRows(repeated, { includeManual: true })[0].balance).toBe(2);
  });

  it('ignora classificações orçamentárias legadas da nota e preserva vínculos existentes', () => {
    const linkedLegacyItem = {
      ...note().items[0],
      projectMaterialDecision: 'linked',
      projectMaterialKey: 'insumo-novo',
      projectMaterialDescription: 'Insumo novo',
      projectMaterialUnit: 'SC',
      projectMaterialConversionFactor: 1,
    };
    const unplannedLegacyItem = {
      id: 'item-2', productCode: 'MAT-02', description: 'Areia lavada', quantity: 1, unit: 'M3', unitPrice: 80, totalPrice: 80,
      projectMaterialDecision: 'unplanned', projectMaterialJustification: 'Compra extraordinária',
    };
    const project = withNote(note({ items: [linkedLegacyItem, unplannedLegacyItem] }));
    project.warehouse!.materialLinks = [{
      id: 'link-existente', warehouseItemKey: 'material-existente', projectMaterialKey: 'insumo-existente',
      projectMaterialDescription: 'Insumo existente', projectMaterialUnit: 'UN', conversionFactor: 1,
      source: 'manual', createdAt: '2026-08-14T10:00:00.000Z',
    }];

    const posted = approveFiscalNote(project, 'nf-1');

    expect(posted.warehouse!.materialLinks).toEqual(project.warehouse!.materialLinks);
    expect(posted.warehouse!.items.find(item => item.code === 'MAT-02')?.unplannedReason).toBeUndefined();
    expect(posted.warehouse!.movements.filter(movement => movement.type === 'entrada')).toHaveLength(2);
  });

  it('mantém o mesmo material quando o preço muda e atualiza o preço mais recente', () => {
    const first = approveFiscalNote(withNote(note()), 'nf-1');
    const secondNote = note({
      id: 'nf-2', invoiceNumber: '101', totalAmount: 120,
      items: [{ id: 'item-2', productCode: 'MAT-01', description: 'Cimento CP II', quantity: 2, unit: 'SC', unitPrice: 60, totalPrice: 120 }],
    });
    first.warehouse!.fiscalNotes.push(secondNote);
    const second = approveFiscalNote(first, 'nf-2');
    expect(second.warehouse!.items).toHaveLength(1);
    expect(second.warehouse!.items[0].purchasedQuantity).toBe(4);
    expect(second.warehouse!.items[0].unitPrice).toBe(60);
    expect(second.warehouse!.movements.filter(movement => movement.type === 'entrada').map(movement => movement.unitPrice)).toEqual([50, 60]);
  });

  it('cancela com estorno auditável e oculta material criado só pela nota', () => {
    const approved = approveFiscalNote(withNote(note()), 'nf-1', 'operador@teste');
    const result = cancelFiscalNote(approved, 'nf-1', { reason: 'Documento lançado indevidamente', actor: 'admin@teste' });
    expect(result.canceled).toBe(true);
    expect(result.project.warehouse!.fiscalNotes[0]).toMatchObject({ status: 'cancelada', archiveReason: 'lancamento_cancelado', canceledBy: 'admin@teste' });
    expect(result.project.warehouse!.movements.some(movement => movement.type === 'estorno' && !!movement.reversesId)).toBe(true);
    expect(computeWarehouseRows(result.project, { includeManual: true })).toHaveLength(0);
    expect(computeWarehouseRows(result.project, { includeManual: true, includeArchived: true })).toHaveLength(1);
  });

  it('revisa e reconcilia entrada ativa deixada por nota arquivada antiga', () => {
    const inconsistent = approveFiscalNote(withNote(note()), 'nf-1', 'operador@teste');
    inconsistent.warehouse!.fiscalNotes[0] = {
      ...inconsistent.warehouse!.fiscalNotes[0],
      status: 'rejeitada',
      archiveReason: 'descartada',
      archivedAt: '2026-08-16T10:00:00.000Z',
    };
    const review = reviewArchivedFiscalNoteStock(inconsistent);
    expect(review).toMatchObject({ safeCount: 1, blockedCount: 0, movementCount: 1 });
    expect(review.issues[0]).toMatchObject({ noteId: 'nf-1', canReconcile: true });
    expect(review.issues[0].materialKeysToArchive).toHaveLength(1);

    const actor = { userId: 'admin-id', userName: 'Administrador', userEmail: 'admin@teste.com' };
    const result = reconcileArchivedFiscalNoteStock(inconsistent, ['nf-1'], actor);
    expect(result.reconciledNoteIds).toEqual(['nf-1']);
    expect(result.reversedMovementIds).toHaveLength(1);
    expect(result.archivedMaterialKeys).toHaveLength(1);
    expect(result.project.warehouse!.movements.some(movement => movement.type === 'estorno' && movement.createdBy?.userId === 'admin-id')).toBe(true);
    expect(result.project.warehouse!.fiscalNotes[0]).toMatchObject({ status: 'rejeitada', archiveReason: 'descartada', updatedBy: actor });
    expect(result.project.warehouse!.fiscalNotes[0].cancellationReason).toMatch(/Reconciliação/i);
    expect(computeWarehouseRows(result.project, { includeManual: true })).toHaveLength(0);

    const repeated = reconcileArchivedFiscalNoteStock(result.project, ['nf-1'], actor);
    expect(repeated.reconciledNoteIds).toHaveLength(0);
    expect(repeated.project.warehouse!.movements).toHaveLength(result.project.warehouse!.movements.length);
  });

  it('bloqueia a reconciliação antiga quando existe movimentação dependente', () => {
    const inconsistent = approveFiscalNote(withNote(note()), 'nf-1');
    const entry = inconsistent.warehouse!.movements[0];
    inconsistent.warehouse!.fiscalNotes[0] = { ...inconsistent.warehouse!.fiscalNotes[0], status: 'cancelada' };
    inconsistent.warehouse!.movements.push({
      id: 'retirada-posterior', createdAt: '2099-08-16T10:00:00.000Z', type: 'retirada', date: '2026-08-16',
      itemKey: entry.itemKey, itemDescription: entry.itemDescription, itemUnit: entry.itemUnit, quantity: 1,
    });
    const review = reviewArchivedFiscalNoteStock(inconsistent);
    expect(review).toMatchObject({ safeCount: 0, blockedCount: 1 });
    expect(review.issues[0].blockers.join(' ')).toMatch(/retirada posterior/i);
    const result = reconcileArchivedFiscalNoteStock(inconsistent, ['nf-1'], 'Administrador');
    expect(result.reconciledNoteIds).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.project.warehouse!.movements).toHaveLength(2);
  });

  it('não sinaliza documento descartado sem entrada nem lançamento já estornado', () => {
    const discarded = archiveFiscalNote(withNote(note()), 'nf-1', 'descartada');
    expect(reviewArchivedFiscalNoteStock(discarded).issues).toHaveLength(0);
    const canceled = cancelFiscalNote(approveFiscalNote(withNote(note()), 'nf-1'), 'nf-1', { reason: 'Erro' }).project;
    expect(reviewArchivedFiscalNoteStock(canceled).issues).toHaveLength(0);
  });

  it('bloqueia cancelamento depois de uma retirada dependente', () => {
    const approved = approveFiscalNote(withNote(note()), 'nf-1');
    const entry = approved.warehouse!.movements[0];
    approved.warehouse!.movements.push({
      id: 'ret-1', createdAt: '2099-08-15T11:00:00.000Z', type: 'retirada', date: '2026-08-15',
      itemKey: entry.itemKey, itemDescription: entry.itemDescription, itemUnit: entry.itemUnit, quantity: 1,
    });
    const check = checkFiscalNoteCancellation(approved, 'nf-1');
    expect(check.allowed).toBe(false);
    expect(check.blockers.join(' ')).toMatch(/retirada posterior/i);
    expect(cancelFiscalNote(approved, 'nf-1', { reason: 'Teste' }).canceled).toBe(false);
  });

  it('impede definitivamente relançar nota cancelada ou arquivada', () => {
    const approved = approveFiscalNote(withNote(note()), 'nf-1');
    const canceled = cancelFiscalNote(approved, 'nf-1', { reason: 'Erro de lançamento' }).project;
    expect(() => approveFiscalNote(canceled, 'nf-1')).toThrow(/cancelado é definitivo/i);
    const archived = archiveFiscalNote(withNote(note()), 'nf-1', 'descartada');
    expect(() => approveFiscalNote(archived, 'nf-1')).toThrow(/arquivado não pode/i);
  });

  it('arquiva rascunhos técnicos antigos sem gerar estoque ou movimentos', () => {
    const project = baseProject();
    const ready = note({ id: 'ready', invoiceNumber: '101' });
    const incomplete = note({ id: 'incomplete', invoiceNumber: '102', items: [] });
    project.warehouse!.fiscalNotes = [ready, incomplete];
    const first = archiveLegacyFiscalNoteDrafts(project, 'operador@teste');
    expect(first.archivedIds).toEqual(['ready', 'incomplete']);
    expect(first.project.warehouse!.fiscalNotes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ready', status: 'rejeitada', archiveReason: 'descartada' }),
      expect.objectContaining({ id: 'incomplete', status: 'rejeitada', archiveReason: 'descartada' }),
    ]));
    expect(first.project.warehouse!.items).toHaveLength(0);
    expect(first.project.warehouse!.movements).toHaveLength(0);
    const second = archiveLegacyFiscalNoteDrafts(first.project, 'operador@teste');
    expect(second.archivedIds).toHaveLength(0);
  });

  it('sincroniza grupo global sem alterar movimentos, saldo ou preço', () => {
    const approved = approveFiscalNote(withNote(note()), 'nf-1');
    const noteItem = approved.warehouse!.fiscalNotes[0].items[0];
    const movementsBefore = structuredClone(approved.warehouse!.movements);
    const balanceBefore = computeWarehouseRows(approved, { includeManual: true })[0].balance;
    const priceBefore = approved.warehouse!.items[0].unitPrice;
    const grouped = updateFiscalItemPurchaseGroup(approved, 'nf-1', noteItem.id, 'grupo-eletrica');
    expect(grouped.warehouse!.fiscalNotes[0].items[0].purchaseGroupId).toBe('grupo-eletrica');
    expect(grouped.warehouse!.items[0].purchaseGroupId).toBe('grupo-eletrica');
    expect(grouped.warehouse!.movements).toEqual(movementsBefore);
    expect(computeWarehouseRows(grouped, { includeManual: true })[0].balance).toBe(balanceBefore);
    expect(grouped.warehouse!.items[0].unitPrice).toBe(priceBefore);
  });

  it('preserva os dados fiscais e lança a quantidade convertida no estoque', () => {
    const converted = note({
      items: [{ ...note().items[0], quantity: 10, unit: 'KG', unitPrice: 10, totalPrice: 100, stockQuantity: 25, stockUnit: 'M', conversionFactor: 2.5 }],
    });
    const posted = approveFiscalNote(withNote(converted), 'nf-1');
    const stored = posted.warehouse!.fiscalNotes[0].items[0];
    const movement = posted.warehouse!.movements[0];
    expect(stored).toMatchObject({ quantity: 10, unit: 'KG', stockQuantity: 25, stockUnit: 'M', conversionFactor: 2.5 });
    expect(movement).toMatchObject({ quantity: 25, itemUnit: 'M', unitPrice: 4, fiscalNoteItemId: stored.id });
    expect(fiscalItemStockQuantity(stored)).toBe(25);
    expect(fiscalItemConversionFactor(stored)).toBe(2.5);
  });

  it('mantém compatibilidade com item antigo sem campos de conversão', () => {
    const legacy = note().items[0];
    expect(fiscalItemStockQuantity(legacy)).toBe(2);
    expect(fiscalItemConversionFactor(legacy)).toBe(1);
    expect(fiscalItemGlobalUnitPrice(legacy)).toBe(50);
  });

  it('rateia adicionais em centavos sem perder o resíduo', () => {
    const items = [1, 2, 3].map(index => ({ ...note().items[0], id: `item-${index}`, totalPrice: 10 }));
    const allocated = fiscalNoteAllocatedExtras({ items, freightAmount: 0.01, icmsAmount: 0 });
    expect(allocated).toEqual([0.01, 0, 0]);
    expect(allocated.reduce((sum, value) => sum + value, 0)).toBe(0.01);
  });

  it('classifica pendência interestadual e aceita confirmação explícita em zero', () => {
    expect(fiscalNoteCostReviewStatus(note())).toBe('unknown_origin');
    expect(fiscalNoteCostReviewStatus(note({ supplierState: 'RO', destinationState: 'RO' }))).toBe('not_required');
    expect(fiscalNoteCostReviewStatus(note({ supplierState: 'SP', destinationState: 'RO' }))).toBe('pending');
    expect(fiscalNoteCostReviewStatus(note({ supplierState: 'SP', destinationState: 'RO', freightAmount: 0, icmsAmount: 0, costReviewStatus: 'confirmed', costReviewedAt: '2026-08-18T10:00:00.000Z' }))).toBe('confirmed');
  });

  it('reavalia duas compras e a retirada posterior sem alterar o saldo', () => {
    const first = note({
      supplierState: 'SP', destinationState: 'RO',
      items: [{ ...note().items[0], quantity: 10, unit: 'KG', unitPrice: 10, totalPrice: 100, stockQuantity: 20, stockUnit: 'M', conversionFactor: 2 }],
    });
    let project = approveFiscalNote(withNote(first), first.id);
    const second = note({ id: 'nf-2', invoiceNumber: '101', items: [{ ...note().items[0], id: 'item-2', quantity: 10, unit: 'M', unitPrice: 10, totalPrice: 100 }] });
    project.warehouse!.fiscalNotes!.push(second);
    project = approveFiscalNote(project, second.id);
    project.warehouse!.movements = project.warehouse!.movements.map((movement, index) => ({ ...movement, createdAt: `2026-08-18T10:0${index}:00.000Z` }));
    const itemKey = project.warehouse!.fiscalNotes![0].items[0].itemKey!;
    const created = createRequisition(project, {
      date: '2026-08-18', chapterId: 'cap-1', teamId: 'team-1', receiverName: 'Operador', signatureReceiver: 'data:image/png;base64,x',
      items: [{ itemKey, description: 'Cimento CP II', unit: 'M', quantity: 10 }],
    });
    project = deliverRequisition(created.project, created.requisition.id);
    const balanceBefore = computeWarehouseRows(project, { includeManual: true }).find(row => row.key === itemKey)!.balance;
    const revalued = reviewPostedFiscalNoteCosts(project, first.id, {
      supplierState: 'SP', destinationState: 'RO', freightAmount: 20, icmsAmount: 10, confirmCosts: true,
      actor: { userName: 'Engenheira' },
    });
    const withdrawal = revalued.warehouse!.movements.find(movement => movement.type === 'retirada')!;
    const requisition = revalued.warehouse!.requisitions.find(entry => entry.id === created.requisition.id)!;
    expect(withdrawal.costSnapshot).toBe(7.66);
    expect(requisition.items[0].unitCostSnapshot).toBe(7.66);
    expect(computeWarehouseRows(revalued, { includeManual: true }).find(row => row.key === itemKey)!.balance).toBe(balanceBefore);
    expect(revalued.warehouse!.fiscalNotes!.find(entry => entry.id === first.id)).toMatchObject({ costReviewStatus: 'confirmed', freightAmount: 20, icmsAmount: 10 });
    expect(revalued.auditLogs?.at(-1)).toMatchObject({ entityType: 'warehouse_fiscal_note', action: 'updated', userName: 'Engenheira' });
  });
});
