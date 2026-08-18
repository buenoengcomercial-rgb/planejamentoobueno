import { beforeEach, describe, expect, it } from 'vitest';
import type { Equipment, Project, WarehouseFiscalNote } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import {
  PROJECT_DRAFT_VERSION,
  inspectProjectDraft,
  projectDraftKey,
  projectHasLocalChanges,
  resolveRemoteVersionAction,
  restoreWarehouseFromDraft,
  summarizeWarehouseRecovery,
  writeProjectDraft,
  sanitizeProjectDraft,
} from './cloudProjectDrafts';

function project(id = 'project-sync'): Project {
  return {
    id,
    name: 'CPA OBRA',
    startDate: '2026-08-01',
    endDate: '2027-08-01',
    phases: [],
    totalBudget: 0,
    warehouse: emptyWarehouse(),
  };
}

function note(id: string, supplier: string, number: string, status: WarehouseFiscalNote['status'] = 'aprovada'): WarehouseFiscalNote {
  return {
    id,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
    status,
    origin: 'upload',
    sourceFileName: `${number}.pdf`,
    supplierName: supplier,
    supplierCnpj: '18.787.482/0001-37',
    invoiceNumber: number,
    totalAmount: 100,
    items: [],
    createdBy: { userName: 'Kennedy' },
  };
}

beforeEach(() => localStorage.clear());

describe('rascunho local seguro', () => {
  it('não recupera automaticamente rascunho legado mesmo quando o relógio local é mais recente', () => {
    const cloud = project();
    const legacy = { ...project(), name: 'Cópia antiga' };
    localStorage.setItem(projectDraftKey(cloud.id), JSON.stringify({
      version: 1,
      baseUpdatedAt: '2026-08-18T10:00:00.000Z',
      localDraftUpdatedAt: '2099-01-01T00:00:00.000Z',
      project: legacy,
    }));
    expect(inspectProjectDraft(cloud, '2026-08-18T12:00:00.000Z')).toMatchObject({
      kind: 'candidate',
      reason: 'legacy',
    });
  });

  it('recupera automaticamente apenas a versão atual com a mesma base e diferença real', () => {
    const cloud = project();
    const local = { ...cloud, name: 'Alteração ainda não salva' };
    const draft = writeProjectDraft(local, '2026-08-18T12:00:00.000Z');
    expect(draft?.version).toBe(PROJECT_DRAFT_VERSION);
    expect(inspectProjectDraft(cloud, '2026-08-18T12:00:00.000Z').kind).toBe('recoverable');
  });

  it('descarta silenciosamente um rascunho idêntico e não depende do horário do aparelho', () => {
    const cloud = project();
    writeProjectDraft(cloud, '2026-08-18T12:00:00.000Z');
    expect(inspectProjectDraft(cloud, '2026-08-18T12:00:00.000Z').kind).toBe('identical');
  });

  it('nunca grava arquivos base64 no rascunho e não interrompe a edição se a cota acabar', () => {
    const local = project();
    local.warehouse!.fiscalNotes = [note('nf-local', 'Fornecedor', '10')];
    local.warehouse!.fiscalNotes[0].attachment = {
      id: 'att-local', name: 'nota.pdf', uploadedAt: '2026-08-18T10:00:00.000Z', dataUrl: 'data:application/pdf;base64,AAAA',
    };
    const draft = writeProjectDraft(local, '2026-08-18T12:00:00.000Z');
    expect(draft?.project.warehouse?.fiscalNotes[0].attachment?.dataUrl).toBeUndefined();

    const fullStorage = { setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); } } as unknown as Storage;
    expect(() => writeProjectDraft(local, null, fullStorage)).not.toThrow();
    expect(writeProjectDraft(local, null, fullStorage)).toBeNull();
    expect(JSON.stringify(sanitizeProjectDraft(local))).not.toContain('data:application/pdf');
  });

  it('separa atualização segura de conflito remoto', () => {
    expect(resolveRemoteVersionAction('v2', 'v1', false)).toBe('reload');
    expect(resolveRemoteVersionAction('v2', 'v1', true)).toBe('conflict');
    expect(resolveRemoteVersionAction('v1', 'v1', true)).toBe('current');
    expect(projectHasLocalChanges(project(), JSON.stringify(project()), false)).toBe(false);
  });
});

describe('recuperação do Almoxarifado', () => {
  it('usa a cópia do Kennedy, remove nota duplicada e preserva equipamentos e módulos externos', () => {
    const cloud = project();
    const equipment: Equipment = {
      id: 'equipment-1',
      internalCode: 'EQ-001',
      name: 'Furadeira',
      patrimony: 'PAT-1',
      status: 'em_manutencao',
      createdAt: '2026-08-01T00:00:00.000Z',
      photos: [{ id: 'photo-1', name: 'foto.jpg', uploadedAt: '2026-08-01T00:00:00.000Z', storagePath: 'eq/foto.jpg' }],
    };
    cloud.warehouse!.equipments = [equipment];
    cloud.warehouse!.fiscalNotes = [note('old-test', 'Fornecedor antigo', '999')];
    cloud.managementRoutine = { roles: [], weeklyPlans: [], weeklyChecklist: [], correctiveActions: [], restrictions: [], lessonsLearned: [], meetings: [] } as Project['managementRoutine'];

    const mobile = project();
    const kennedyNote = note('kennedy-1', 'PL INDUSTRIA', '000106809');
    const duplicate = { ...kennedyNote, id: 'kennedy-duplicate', updatedAt: '2026-08-18T09:00:00.000Z' };
    mobile.warehouse!.fiscalNotes = [kennedyNote, duplicate, note('kennedy-archived', 'B LUX', '002', 'rejeitada')];
    mobile.warehouse!.items = [{ key: 'kennedy-item', description: 'Material novo', unit: 'UN', purchasedQuantity: 4 }];
    mobile.warehouse!.movements = [
      { id: 'movement-1', type: 'entrada', date: '2026-08-18', createdAt: '2026-08-18T10:00:00.000Z', itemKey: 'kennedy-item', itemDescription: 'Material novo', itemUnit: 'UN', quantity: 2, fiscalNoteId: 'kennedy-1' },
      { id: 'movement-duplicate', type: 'entrada', date: '2026-08-18', createdAt: '2026-08-18T09:00:00.000Z', itemKey: 'kennedy-item', itemDescription: 'Material novo', itemUnit: 'UN', quantity: 2, fiscalNoteId: 'kennedy-duplicate' },
    ];

    const restored = restoreWarehouseFromDraft(cloud, mobile, { userName: 'Kelper' });
    expect(restored.warehouse!.fiscalNotes.map(entry => entry.id)).toEqual(['kennedy-1', 'kennedy-archived']);
    expect(restored.warehouse!.movements.map(entry => entry.id)).toEqual(['movement-1']);
    expect(restored.warehouse!.items[0].purchasedQuantity).toBe(2);
    expect(restored.warehouse!.equipments).toEqual([equipment]);
    expect(restored.managementRoutine).toEqual(cloud.managementRoutine);
    expect(summarizeWarehouseRecovery(restored)).toMatchObject({ postedNotes: 1, archivedNotes: 1, equipments: 1 });
    expect(restored.auditLogs?.at(-1)).toMatchObject({
      action: 'imported',
      title: 'Almoxarifado recuperado de uma cópia local',
      userName: 'Kelper',
    });
  });

  it('recria a entrada congelada quando uma nota lançada chegou sem movimento', () => {
    const cloud = project();
    const mobile = project();
    const posted = note('kennedy-1', 'PL INDUSTRIA', '000106809');
    posted.items = [{
      id: 'item-1',
      itemKey: 'material-1',
      description: 'Tubo de aço',
      unit: 'UN',
      quantity: 3,
      unitPrice: 25,
      totalPrice: 75,
    }];
    mobile.warehouse!.fiscalNotes = [posted];
    mobile.warehouse!.items = [{ key: 'material-1', description: 'Tubo de aço', unit: 'UN', purchasedQuantity: 3 }];

    const restored = restoreWarehouseFromDraft(cloud, mobile, { userName: 'Kelper' });
    expect(restored.warehouse!.fiscalNotes).toHaveLength(1);
    expect(restored.warehouse!.movements).toEqual([expect.objectContaining({
      id: 'recovered-kennedy-1-item-1',
      fiscalNoteId: 'kennedy-1',
      itemKey: 'material-1',
      quantity: 3,
      type: 'entrada',
    })]);
  });
});
