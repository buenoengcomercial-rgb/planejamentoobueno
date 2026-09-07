import { describe, expect, it } from 'vitest';
import type { Project, WarehouseFiscalNote } from '@/types/project';
import {
  approveFiscalNote,
  applyFiscalItemStockConversionSuggestion,
  applyWarehouseSupplierPresentation,
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
  normalizeFiscalNoteNumber,
  reconcileFiscalNoteDuplicates,
  fiscalItemConversionFactor,
  fiscalItemGlobalTotal,
  fiscalItemGlobalUnitPrice,
  fiscalItemStockQuantity,
  fiscalItemStockConversionStatus,
  fiscalNoteAllocatedExtras,
  fiscalNoteCostReviewStatus,
  hardDeleteFiscalNote,
  isStockFiscalDocument,
  reconcileArchivedFiscalNoteStock,
  confirmFiscalNotePackagingConversion,
  reviewFiscalNotePackagingConversions,
  reviewArchivedFiscalNoteStock,
  reviewPostedFiscalNoteCosts,
  replacePostedFiscalNote,
  updateFiscalItemPurchaseGroup,
  suggestFiscalItemStockConversion,
  upsertWarehouseSupplierPresentation,
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

  it.each(['4169', '004169', '000.004.169'])('normaliza a numeração fiscal %s sem alterar a identidade', value => {
    expect(normalizeFiscalNoteNumber(value)).toBe('4169');
  });

  it('bloqueia a mesma NF quando o PDF altera apenas zeros e pontuação', () => {
    const existing = note({ id: 'existente', status: 'aprovada', invoiceNumber: '000.004.169', totalAmount: 243.8 });
    const candidate = note({ id: 'pdf', invoiceNumber: '4169', totalAmount: 243.8 });
    expect(findFiscalNoteDuplicate(withNote(existing), candidate)?.id).toBe('existente');
    expect(() => approveFiscalNote({ ...withNote(existing), warehouse: { ...withNote(existing).warehouse!, fiscalNotes: [existing, candidate] } }, candidate.id)).toThrow(/já foi lançada/i);
  });

  it('aplica apresentação por CNPJ e código sem alterar a quantidade fiscal', () => {
    const project = upsertWarehouseSupplierPresentation(baseProject(), {
      supplierName: 'Jessica', supplierCnpj: '57.893.587/0001-22', supplierProductCode: 'MLB582',
      warehouseItemKey: 'parafuso-fisico', contentPerFiscalUnit: 1000, stockUnit: 'PC', active: true,
    });
    const converted = applyWarehouseSupplierPresentation(project, '57.893.587/0001-22', {
      ...note().items[0], productCode: 'MLB582', quantity: 4, unit: 'UNID',
    });
    expect(converted.quantity).toBe(4);
    expect(converted.stockQuantity).toBe(4000);
    expect(converted.stockUnit).toBe('PC');
    expect(converted.itemKey).toBe('parafuso-fisico');
    expect(converted.stockConversionStatus).toBe('manual');
    expect(() => approveFiscalNote(withNote(note({ items: [converted] })), 'nf-1')).toThrow(/confirme a conversão/i);
  });

  it('não aplica apresentação de outro fornecedor ao mesmo código', () => {
    const project = upsertWarehouseSupplierPresentation(baseProject(), {
      supplierCnpj: '57.893.587/0001-22', supplierProductCode: 'MLB582',
      warehouseItemKey: 'parafuso-fisico', contentPerFiscalUnit: 1000, stockUnit: 'PC', active: true,
    });
    const untouched = applyWarehouseSupplierPresentation(project, '12.345.678/0001-95', { ...note().items[0], productCode: 'MLB582', quantity: 4 });
    expect(untouched.stockQuantity).toBeUndefined();
    expect(untouched.stockConversionStatus).toBeUndefined();
  });

  it('não confunde número normalizado quando CNPJ ou valor são diferentes', () => {
    const existing = note({ id: 'existente', status: 'aprovada', invoiceNumber: '000.004.169', totalAmount: 243.8 });
    expect(findFiscalNoteDuplicate(withNote(existing), note({ id: 'valor', invoiceNumber: '4169', totalAmount: 243.81 }))).toBeUndefined();
    expect(findFiscalNoteDuplicate(withNote(existing), note({ id: 'cnpj', invoiceNumber: '4169', supplierCnpj: '98.765.432/0001-10', totalAmount: 243.8 }))).toBeUndefined();
  });

  it('reconcilia a duplicidade histórica mantendo a entrada mais antiga e auditando o cancelamento', () => {
    const older = note({ id: 'mais-antiga', status: 'aprovada', invoiceNumber: '000.004.169', totalAmount: 243.8, createdAt: '2026-08-21T10:55:00.000Z' });
    const newer = note({ id: 'mais-nova', status: 'aprovada', invoiceNumber: '4169', totalAmount: 243.8, createdAt: '2026-09-07T09:41:00.000Z' });
    const project = { ...baseProject(), warehouse: { ...emptyWarehouse(), fiscalNotes: [older, newer], movements: [
      { id: 'entrada-antiga', type: 'entrada' as const, date: '2026-08-21', createdAt: older.createdAt, fiscalNoteId: older.id, itemKey: 'nf-antiga', itemDescription: 'Cimento CP II', itemUnit: 'SC', quantity: 2 },
      { id: 'entrada-nova', type: 'entrada' as const, date: '2026-09-07', createdAt: newer.createdAt, fiscalNoteId: newer.id, itemKey: 'nf-nova', itemDescription: 'Cimento CP II', itemUnit: 'SC', quantity: 2 },
    ] } };
    const reconciled = reconcileFiscalNoteDuplicates(project, { userName: 'Proprietário' });
    expect(reconciled.canceledNoteIds).toEqual(['mais-nova']);
    expect(reconciled.project.warehouse!.fiscalNotes!.find(entry => entry.id === 'mais-antiga')?.status).toBe('aprovada');
    expect(reconciled.project.warehouse!.fiscalNotes!.find(entry => entry.id === 'mais-nova')?.status).toBe('cancelada');
    expect(reconciled.project.auditLogs?.at(-1)).toMatchObject({ entityId: 'mais-nova', action: 'rejected' });
  });

  it('registra pendência auditável se uma duplicidade tiver consumo posterior', () => {
    const older = note({ id: 'mais-antiga', status: 'aprovada', invoiceNumber: '000.004.169', totalAmount: 243.8, createdAt: '2026-08-21T10:55:00.000Z' });
    const newer = note({ id: 'mais-nova', status: 'aprovada', invoiceNumber: '4169', totalAmount: 243.8, createdAt: '2026-09-07T09:41:00.000Z' });
    const project = { ...baseProject(), warehouse: { ...emptyWarehouse(), fiscalNotes: [older, newer], movements: [
      { id: 'entrada-antiga', type: 'entrada' as const, date: '2026-08-21', createdAt: older.createdAt, fiscalNoteId: older.id, itemKey: 'nf-antiga', itemDescription: 'Cimento CP II', itemUnit: 'SC', quantity: 2 },
      { id: 'entrada-nova', type: 'entrada' as const, date: '2026-09-07', createdAt: newer.createdAt, fiscalNoteId: newer.id, itemKey: 'nf-nova', itemDescription: 'Cimento CP II', itemUnit: 'SC', quantity: 2 },
      { id: 'consumo', type: 'retirada' as const, date: '2026-09-08', createdAt: '2026-09-08T10:00:00.000Z', itemKey: 'nf-nova', itemDescription: 'Cimento CP II', itemUnit: 'SC', quantity: 1 },
    ] } };
    const reconciled = reconcileFiscalNoteDuplicates(project, { userName: 'Proprietário' });
    expect(reconciled.pendingNoteIds).toEqual(['mais-nova']);
    expect(reconciled.project.warehouse!.fiscalNotes!.find(entry => entry.id === 'mais-nova')?.status).toBe('aprovada');
    expect(reconciled.project.auditLogs?.at(-1)?.title).toMatch(/pendente/i);
  });

  it('permite ao proprietário substituir uma entrada sem consumo posterior e recalcula o saldo', () => {
    const original = note({ status: 'aprovada' });
    const project = approveFiscalNote(withNote(original), original.id);
    const updated = replacePostedFiscalNote(project, original.id, note({ status: 'aprovada', totalAmount: 150, items: [{ ...original.items[0], quantity: 3, unitPrice: 50, totalPrice: 150 }] }));
    expect(updated.warehouse!.fiscalNotes[0]).toMatchObject({ status: 'aprovada', totalAmount: 150 });
    expect(updated.warehouse!.movements.filter(movement => movement.type === 'entrada')).toHaveLength(1);
    expect(computeWarehouseRows(updated, { includeManual: true })[0].balance).toBe(3);
  });

  it('impede excluir fisicamente uma entrada já vinculada a retirada posterior', () => {
    const original = note({ status: 'aprovada' });
    const project = approveFiscalNote(withNote(original), original.id);
    const itemKey = project.warehouse!.fiscalNotes![0].items[0].itemKey ?? 'warehouse-nf|nf-1|cimento';
    project.warehouse!.movements.push({ id: 'mov-entry-1', fiscalNoteId: original.id, createdAt: '2026-12-17T10:00:00.000Z', type: 'entrada', date: '2026-12-17', itemKey, itemDescription: 'Cimento CP II', itemUnit: 'SC', quantity: 2 });
    project.warehouse!.requisitions.push({ id: 'ret-1', number: 'RET-001', date: '2026-12-18', status: 'entregue', createdAt: '2026-12-18T10:00:00.000Z', items: [{ itemKey, description: 'Cimento CP II', unit: 'SC', quantity: 1 }] });
    project.warehouse!.movements.push({ id: 'mov-ret-1', createdAt: '2026-12-18T10:00:00.000Z', type: 'retirada', date: '2026-12-18', itemKey, itemDescription: 'Cimento CP II', itemUnit: 'SC', quantity: 1 });
    expect(() => hardDeleteFiscalNote(project, original.id)).toThrow(/retirada|requisição/i);
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

  it('sugere balde, caixa e saco com conteúdo em peças, mas ignora medidas e códigos', () => {
    expect(suggestFiscalItemStockConversion('BUCHA UX10A BALDE VERMELHO 600')).toMatchObject({ packaging: 'balde', contentPerPackage: 600, stockUnit: 'PC' });
    expect(suggestFiscalItemStockConversion('PARAFUSO CAIXA 100 UN')).toMatchObject({ packaging: 'caixa', contentPerPackage: 100 });
    expect(suggestFiscalItemStockConversion('Parafuso Chipboard 6,0x60 Flangeado Phillips Caixa 500pcs')).toMatchObject({ packaging: 'caixa', contentPerPackage: 500, stockUnit: 'PC' });
    expect(suggestFiscalItemStockConversion('PARAFUSO PONTA AGULHA (EMB C/ 1000PCS)')).toMatchObject({ packaging: 'caixa', contentPerPackage: 1000, stockUnit: 'PC' });
    expect(suggestFiscalItemStockConversion('FIXADOR SACO 500')).toMatchObject({ packaging: 'saco', contentPerPackage: 500 });
    expect(suggestFiscalItemStockConversion('CIMENTO SACO 50 KG')).toBeUndefined();
    expect(suggestFiscalItemStockConversion('BROCA 6X110 SC30')).toBeUndefined();
  });

  it('exige confirmação da embalagem e lança duas embalagens como peças', () => {
    const item = applyFiscalItemStockConversionSuggestion({
      ...note().items[0], description: 'BUCHA UX10A BALDE VERMELHO 600', quantity: 2, unit: 'BD', unitPrice: 100, totalPrice: 200,
    });
    expect(item).toMatchObject({ stockQuantity: 1200, stockUnit: 'PC', conversionFactor: 600, stockConversionStatus: 'suggested' });
    const pending = note({ items: [item] });
    expect(() => approveFiscalNote(withNote(pending), pending.id)).toThrow(/confirme a conversão/i);
    const confirmed = { ...item, stockConversionStatus: 'confirmed' as const };
    const posted = approveFiscalNote(withNote(note({ items: [confirmed] })), 'nf-1');
    expect(posted.warehouse!.movements[0]).toMatchObject({ quantity: 1200, itemUnit: 'PC', unitPrice: 0.08 });
  });

  it('preserva a conversão confirmada quando a quantidade fiscal é alterada', () => {
    const suggested = applyFiscalItemStockConversionSuggestion({ ...note().items[0], description: 'BUCHA BALDE 600', quantity: 1, unit: 'BD' });
    const confirmed = { ...suggested, stockConversionStatus: 'confirmed' as const };
    const adjusted = { ...confirmed, quantity: 2, stockQuantity: 2 * fiscalItemConversionFactor(confirmed) };
    expect(adjusted).toMatchObject({ quantity: 2, stockQuantity: 1200, conversionFactor: 600, stockConversionStatus: 'confirmed' });
  });

  it('revisa e corrige embalagem histórica apenas sem movimentação posterior', () => {
    const legacy = note({ status: 'a_conferir', items: [{ ...note().items[0], description: 'BUCHA BALDE 600', quantity: 1, unit: 'BD', itemKey: 'warehouse-nf|legacy' }] });
    const posted = approveFiscalNote(withNote(legacy), legacy.id);
    const reviews = reviewFiscalNotePackagingConversions(posted);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].blockers).toEqual([]);
    expect(reviews[0]).toMatchObject({ suggestedStockQuantity: 600, suggestedStockUnit: 'PC', canCorrect: true });
    const corrected = confirmFiscalNotePackagingConversion(posted, legacy.id, legacy.items[0].id, { userName: 'Proprietário' });
    expect(corrected.warehouse!.fiscalNotes[0].items[0]).toMatchObject({ stockQuantity: 600, stockUnit: 'PC', stockConversionStatus: 'confirmed' });
    expect(corrected.warehouse!.movements[0]).toMatchObject({ quantity: 600, itemUnit: 'PC' });
    expect(fiscalItemStockConversionStatus(corrected.warehouse!.fiscalNotes[0].items[0])).toBe('confirmed');
  });

  it('permite ao proprietário confirmar a conversão histórica de duas caixas de 500 como mil peças', () => {
    const legacy = note({ status: 'a_conferir', items: [{ ...note().items[0], description: 'PARAFUSO CHIPBOARD CAIXA 500PCS', quantity: 2, unit: 'UN', itemKey: 'warehouse-nf|caixa-500' }] });
    const posted = approveFiscalNote(withNote(legacy), legacy.id);
    const review = reviewFiscalNotePackagingConversions(posted)[0];
    expect(review).toMatchObject({ fiscalQuantity: 2, suggestedStockQuantity: 1000, suggestedStockUnit: 'PC', canCorrect: true });
    const corrected = confirmFiscalNotePackagingConversion(posted, legacy.id, legacy.items[0].id, { userName: 'Proprietário' }, 'PC', 500);
    expect(corrected.warehouse!.fiscalNotes[0].items[0]).toMatchObject({ quantity: 2, unit: 'UN', stockQuantity: 1000, stockUnit: 'PC', conversionFactor: 500, stockConversionStatus: 'confirmed' });
    expect(corrected.warehouse!.movements[0]).toMatchObject({ quantity: 1000, itemUnit: 'PC' });
  });

  it('reconcilia uma conversão já confirmada cuja entrada antiga ainda está em caixas', () => {
    const legacy = note({ status: 'a_conferir', items: [{ ...note().items[0], description: 'PARAFUSO (EMB C/1000PCS)', quantity: 2, unit: 'CX', itemKey: 'warehouse-nf|caixa-confirmada' }] });
    const posted = approveFiscalNote(withNote(legacy), legacy.id);
    posted.warehouse!.fiscalNotes[0].items[0] = {
      ...posted.warehouse!.fiscalNotes[0].items[0], stockQuantity: 2000, stockUnit: 'PC', conversionFactor: 1000, stockConversionStatus: 'confirmed',
    };
    const review = reviewFiscalNotePackagingConversions(posted)[0];
    expect(review).toMatchObject({ currentStockQuantity: 2, suggestedStockQuantity: 2000, suggestedStockUnit: 'PC', canCorrect: true });
    const corrected = confirmFiscalNotePackagingConversion(posted, legacy.id, legacy.items[0].id);
    expect(corrected.warehouse!.movements[0]).toMatchObject({ quantity: 2000, itemUnit: 'PC' });
  });

  it('converte retiradas históricas na unidade antiga junto com a entrada', () => {
    const legacy = note({ status: 'a_conferir', items: [{ ...note().items[0], description: 'BUCHA CAIXA 100', quantity: 1, unit: 'CX' }] });
    const posted = approveFiscalNote(withNote(legacy), legacy.id);
    const entry = posted.warehouse!.movements[0];
    posted.warehouse!.movements.push({
      id: 'withdrawal-after-entry', type: 'retirada', date: '2026-09-08', createdAt: new Date(Date.parse(entry.createdAt) + 1000).toISOString(),
      itemKey: entry.itemKey, itemDescription: entry.itemDescription, itemUnit: entry.itemUnit, quantity: 0.1,
    });
    const review = reviewFiscalNotePackagingConversions(posted)[0];
    expect(review).toMatchObject({ canCorrect: true, dependentMovementCount: 1 });
    const corrected = confirmFiscalNotePackagingConversion(posted, legacy.id, legacy.items[0].id);
    const withdrawal = corrected.warehouse!.movements.find(movement => movement.id === 'withdrawal-after-entry')!;
    expect(withdrawal).toMatchObject({ quantity: 10, itemUnit: 'PC' });
    expect(withdrawal.notes).toMatch(/Conversão auditada/i);
  });

  it('continua bloqueando conversão histórica quando a movimentação posterior já está em outra unidade', () => {
    const legacy = note({ status: 'a_conferir', items: [{ ...note().items[0], description: 'BUCHA CAIXA 100', quantity: 1, unit: 'CX' }] });
    const posted = approveFiscalNote(withNote(legacy), legacy.id);
    const entry = posted.warehouse!.movements[0];
    posted.warehouse!.movements.push({
      id: 'withdrawal-pc', type: 'retirada', date: '2026-09-08', createdAt: new Date(Date.parse(entry.createdAt) + 1000).toISOString(),
      itemKey: entry.itemKey, itemDescription: entry.itemDescription, itemUnit: 'PC', quantity: 10,
    });
    const review = reviewFiscalNotePackagingConversions(posted)[0];
    expect(review.canCorrect).toBe(false);
    expect(review.blockers.join(' ')).toMatch(/outra unidade/i);
    expect(() => confirmFiscalNotePackagingConversion(posted, legacy.id, legacy.items[0].id)).toThrow(/outra unidade/i);
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

  it('soma frete e ICMS ao subtotal e dilui exatamente o custo entre os materiais', () => {
    const totals = [1208, 945.12, 2090.2, 1024.8, 999.18];
    const items = totals.map((totalPrice, index) => ({ ...note().items[0], id: `item-${index}`, totalPrice }));
    const costNote = { items, totalAmount: 6567.3, freightAmount: 300, icmsAmount: 3000 };
    const globalTotals = items.map(item => fiscalItemGlobalTotal(item, costNote));
    expect(globalTotals.reduce((sum, value) => sum + value, 0)).toBeCloseTo(9867.3, 2);
    expect(fiscalNoteAllocatedExtras(costNote).reduce((sum, value) => sum + value, 0)).toBe(3600);
  });

  it('classifica pendência interestadual e aceita confirmação sem custos adicionais', () => {
    expect(fiscalNoteCostReviewStatus(note())).toBe('unknown_origin');
    expect(fiscalNoteCostReviewStatus(note({ supplierState: 'RO', destinationState: 'RO' }))).toBe('not_required');
    expect(fiscalNoteCostReviewStatus(note({ supplierState: 'SP', destinationState: 'RO' }))).toBe('pending');
    expect(fiscalNoteCostReviewStatus(note({ supplierState: 'RO', destinationState: undefined }))).toBe('not_required');
    expect(fiscalNoteCostReviewStatus(note({ supplierState: 'SP', destinationState: undefined }))).toBe('pending');
    expect(fiscalNoteCostReviewStatus(note({ supplierState: 'SP', destinationState: 'RO', freightAmount: 0, icmsAmount: 0, costReviewStatus: 'confirmed', costReviewedAt: '2026-08-18T10:00:00.000Z' }))).toBe('confirmed');
    expect(fiscalNoteCostReviewStatus(note({ supplierState: 'SP', destinationState: 'RO', costReviewStatus: 'confirmed', costReviewedAt: '2026-08-18T10:00:00.000Z' }))).toBe('confirmed');
  });

  it('confirma somente o ICMS/DIFAL sem exigir frete em zero', () => {
    const original = note({ supplierState: 'SP', destinationState: 'RO' });
    const project = approveFiscalNote(withNote(original), original.id);
    const revised = reviewPostedFiscalNoteCosts(project, original.id, {
      supplierState: 'SP', destinationState: 'RO', icmsAmount: 12.5, confirmCosts: true,
    });
    expect(revised.warehouse!.fiscalNotes![0]).toMatchObject({ costReviewStatus: 'confirmed', icmsAmount: 12.5 });
    expect(revised.warehouse!.fiscalNotes![0].freightAmount).toBeUndefined();
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
