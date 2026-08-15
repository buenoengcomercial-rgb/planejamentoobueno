import { describe, expect, it } from 'vitest';
import type { Project, WarehouseFiscalNote } from '@/types/project';
import {
  approveFiscalNote,
  archiveFiscalNote,
  cancelFiscalNote,
  checkFiscalNoteCancellation,
  classifyFiscalDocumentText,
  computeWarehouseRows,
  emptyWarehouse,
  ensureWarehouse,
  findFiscalNoteDuplicate,
  isStockFiscalDocument,
  reconcileFiscalNoteDrafts,
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

  it('reconcilia rascunhos completos uma única vez e preserva incompletos e duplicados', () => {
    const project = baseProject();
    const existing = note({ id: 'existing', status: 'aprovada' });
    const ready = note({ id: 'ready', invoiceNumber: '101' });
    const duplicate = note({ id: 'duplicate' });
    const incomplete = note({ id: 'incomplete', invoiceNumber: '102', items: [] });
    project.warehouse!.fiscalNotes = [existing, ready, duplicate, incomplete];
    const first = reconcileFiscalNoteDrafts(project, 'operador@teste');
    expect(first.postedIds).toEqual(['ready']);
    expect(first.duplicateIds).toEqual(['duplicate']);
    expect(first.incompleteIds).toEqual(['incomplete']);
    const second = reconcileFiscalNoteDrafts(first.project, 'operador@teste');
    expect(second.postedIds).toHaveLength(0);
    expect(first.project.warehouse!.movements.filter(movement => movement.fiscalNoteId === 'ready')).toHaveLength(1);
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
});
