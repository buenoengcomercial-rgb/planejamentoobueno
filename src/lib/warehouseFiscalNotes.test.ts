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

  it('arquiva pedido sem criar item, saldo ou movimento', () => {
    const project = withNote(note({ id: 'pedido-915', documentType: 'pedido_venda', invoiceNumber: '915' }));
    const archived = archiveFiscalNote(project, 'pedido-915', 'comprovante', 'operador@teste');
    expect(archived.warehouse!.fiscalNotes[0]).toMatchObject({ status: 'rejeitada', archiveReason: 'comprovante' });
    expect(archived.warehouse!.items).toHaveLength(0);
    expect(archived.warehouse!.movements).toHaveLength(0);
    expect(() => approveFiscalNote(project, 'pedido-915')).toThrow(/Somente NF-e/);
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
});
