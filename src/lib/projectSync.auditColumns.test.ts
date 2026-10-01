import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { clearCloudSnapshot, setCloudSnapshot, syncCollectionsToCloud } from '@/lib/projectSync';

const upsert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from } }));

const base = { id: 'project-audit', name: 'Obra', phases: [], auditLogs: [] } as Project;
afterEach(() => { clearCloudSnapshot(base.id); upsert.mockClear(); from.mockClear(); });

describe('auditoria no fluxo de compatibilidade', () => {
  it('não envia created_by para audit_logs, que possui user_id', async () => {
    setCloudSnapshot(base.id, base);
    const next = { ...base, auditLogs: [{ id: 'audit-1', entityType: 'measurement',
      entityId: 'measurement-1', action: 'updated', at: '2026-09-30T23:00:00Z',
      title: 'Medição corrigida', userId: 'user-1' }] } as Project;
    await syncCollectionsToCloud(next, 'user-1');
    expect(from).toHaveBeenCalledWith('audit_logs');
    expect(upsert).toHaveBeenCalledWith([expect.objectContaining({
      id: 'audit-1', user_id: 'user-1',
    })], { onConflict: 'id' });
    expect(upsert.mock.calls[0][0][0]).not.toHaveProperty('created_by');
  });
});
