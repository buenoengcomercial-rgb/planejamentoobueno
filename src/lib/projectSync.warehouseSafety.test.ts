import { describe, expect, it } from 'vitest';
import {
  clearCloudSnapshot,
  hydrateAuditLogRow,
  normalizedDeletePolicy,
  ProjectSnapshotUnavailableError,
  syncCollectionsToCloud,
} from '@/lib/projectSync';
import type { Project } from '@/types/project';

describe('proteção contra exclusão por snapshot desatualizado', () => {
  it('nunca interpreta ausência local como exclusão de requisição, Diário ou auditoria', () => {
    expect(normalizedDeletePolicy('warehouse_requisitions', {})).toBe(false);
    expect(normalizedDeletePolicy('daily_reports', {})).toBe(false);
    expect(normalizedDeletePolicy('audit_logs', {})).toBe(false);
  });

  it('protege movimentos de retirada e devolução, preservando ajustes administrativos independentes', () => {
    expect(normalizedDeletePolicy('warehouse_movements', { originType: 'withdrawal' })).toBe(false);
    expect(normalizedDeletePolicy('warehouse_movements', { originType: 'return' })).toBe(false);
    expect(normalizedDeletePolicy('warehouse_movements', { originType: 'inventory' })).toBe(true);
  });

  it('restaura no JSON o identificador oficial da linha de auditoria', () => {
    expect(hydrateAuditLogRow({
      id: 'audit-official-id',
      data: { title: 'Registro legado', id: 'identificador-incorreto' },
    })).toMatchObject({ id: 'audit-official-id', title: 'Registro legado' });
  });

  it('falha fechado quando não existe fotografia das coleções carregadas', async () => {
    const project = {
      id: 'obra-parcial',
      name: 'Obra parcial',
      phases: [],
      totalBudget: 0,
    } as Project;
    clearCloudSnapshot(project.id);

    await expect(syncCollectionsToCloud(project)).rejects.toBeInstanceOf(ProjectSnapshotUnavailableError);
  });
});
