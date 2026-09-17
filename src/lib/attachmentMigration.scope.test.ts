import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { ATTACHMENT_OPTIMIZATION_VERSION } from './attachmentOptimizationVersion';
import { attachmentMigrationScope, collectUnoptimizedAttachments, markAttachmentCleanupPending } from './attachmentMigration';

function project(): Project {
  return {
    id: 'project-1',
    name: 'Obra de teste',
    phases: [],
    totalBudget: 0,
    dailyReports: [],
    warehouse: {
      items: [],
      movements: [],
      requisitions: [],
      custodyTerms: [],
      fiscalNotes: [],
      equipments: [],
    },
  } as Project;
}

describe('escopo da manutenção de anexos', () => {
  it('identifica uma retirada isolada sem permitir alteração de outra coleção', () => {
    const before = project();
    before.warehouse!.requisitions = [{ id: 'req-1', number: 'REQ-1', date: '2026-09-17', items: [], attachments: [{ id: 'file-1', name: 'foto.jpg', storagePath: 'old.jpg' }] }] as Project['warehouse']['requisitions'];
    const after = structuredClone(before);
    after.warehouse!.requisitions[0].attachments![0] = {
      ...after.warehouse!.requisitions[0].attachments![0],
      storagePath: 'optimized.jpg',
      optimizedAt: '2026-09-17T10:00:00.000Z',
      optimizationVersion: ATTACHMENT_OPTIMIZATION_VERSION,
    };

    const scope = attachmentMigrationScope(before, after);

    expect(scope.kind).toBe('requisition');
  });

  it('identifica anexos de cautela e equipamentos pelas coleções próprias', () => {
    const custodyBefore = project();
    custodyBefore.warehouse!.custodyTerms = [{ id: 'term-1', number: 'TC-1', issuedAt: '2026-09-17', chapterId: 'c-1', chapterName: 'Capítulo', workerName: 'Equipe', signatureReceiver: 'assinatura', equipments: [], attachments: [{ id: 'file-1', name: 'foto.jpg', storagePath: 'old.jpg' }] }] as Project['warehouse']['custodyTerms'];
    const custodyAfter = structuredClone(custodyBefore);
    custodyAfter.warehouse!.custodyTerms[0].attachments![0] = { ...custodyAfter.warehouse!.custodyTerms[0].attachments![0], storagePath: 'optimized.jpg' };
    expect(attachmentMigrationScope(custodyBefore, custodyAfter).kind).toBe('custody');

    const equipmentBefore = project();
    equipmentBefore.warehouse!.equipments = [{ id: 'equipment-1', name: 'Furadeira', photos: [{ id: 'file-2', name: 'foto.jpg', storagePath: 'old.jpg' }] }] as Project['warehouse']['equipments'];
    const equipmentAfter = structuredClone(equipmentBefore);
    equipmentAfter.warehouse!.equipments[0].photos![0] = { ...equipmentAfter.warehouse!.equipments[0].photos![0], storagePath: 'optimized.jpg' };
    expect(attachmentMigrationScope(equipmentBefore, equipmentAfter)).toEqual({ kind: 'warehouse-state', domain: 'catalog' });
  });

  it('não reinsere anexos novos já avaliados na fila de legado', () => {
    const current = project();
    current.warehouse!.equipments = [{
      id: 'equipment-1',
      name: 'Furadeira',
      photos: [{
        id: 'file-1',
        name: 'foto.jpg',
        mimeType: 'image/jpeg',
        storagePath: 'warehouse/equipment/file-1.jpg',
        optimizedAt: '2026-09-17T10:00:00.000Z',
        optimizationVersion: ATTACHMENT_OPTIMIZATION_VERSION,
      }],
    }] as Project['warehouse']['equipments'];

    expect(collectUnoptimizedAttachments(current)).toEqual([]);
  });

  it('bloqueia uma tentativa que altere mais de uma coleção', () => {
    const before = project();
    before.warehouse!.requisitions = [{ id: 'req-1', number: 'REQ-1', date: '2026-09-17', items: [] }] as Project['warehouse']['requisitions'];
    const after = structuredClone(before);
    after.warehouse!.requisitions[0] = { ...after.warehouse!.requisitions[0], notes: 'mudou' };
    after.warehouse!.equipments = [{ id: 'equipment-1', name: 'Furadeira' }] as Project['warehouse']['equipments'];

    expect(() => attachmentMigrationScope(before, after)).toThrow('único anexo por vez');
  });

  it('bloqueia alteração incidental fora do anexo', () => {
    const before = project();
    before.warehouse!.requisitions = [{ id: 'req-1', number: 'REQ-1', date: '2026-09-17', items: [] }] as Project['warehouse']['requisitions'];
    const after = structuredClone(before);
    after.warehouse!.requisitions[0] = { ...after.warehouse!.requisitions[0], notes: 'foto atualizada' };
    after.name = 'Outra obra';

    expect(() => attachmentMigrationScope(before, after)).toThrow('fora da coleção dona');
  });

  it('registra pendência de limpeza sem alterar a coleção dona do anexo', () => {
    const before = project();
    before.warehouse!.requisitions = [{ id: 'req-1', number: 'REQ-1', date: '2026-09-17', items: [], attachments: [{ id: 'file-1', name: 'foto.jpg', storagePath: 'optimized.jpg' }] }] as Project['warehouse']['requisitions'];

    const after = markAttachmentCleanupPending(before, 'file-1', 'optimized.jpg', 'original.jpg');

    expect(attachmentMigrationScope(before, after).kind).toBe('requisition');
    expect(after.warehouse!.requisitions[0].attachments![0].cleanupPendingStoragePath).toBe('original.jpg');
  });
});
