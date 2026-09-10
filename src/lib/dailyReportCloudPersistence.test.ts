import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DailyReport } from '@/types/project';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from } }));
import { DailyReportLockedError, DailyReportPermissionError, saveOpenDailyReport } from './dailyReportCloudSync';

const base: DailyReport = { id: 'dr-test', date: '2026-09-10', createdAt: 't0', updatedAt: 't0', attachments: [], teamsPresent: [], equipment: [], observations: 'Original' };
const local = { ...base, observations: 'Texto novo' };
const row = (data = base, version = 'v1') => ({ id: data.id, data, updated_at: version });
const response = (data: unknown, error: unknown = null) => ({ data, error });
function mockResponses(...results: ReturnType<typeof response>[]) {
  const writes: string[] = [];
  from.mockImplementation((table: string) => {
    expect(table).toBe('daily_reports');
    const result = results.shift();
    if (!result) throw new Error('Unexpected request');
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query),
      insert: vi.fn(() => { writes.push('insert'); return query; }),
      update: vi.fn(() => { writes.push('update'); return query; }),
      delete: vi.fn(() => { writes.push('delete'); return query; }),
      maybeSingle: vi.fn(async () => result),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return query;
  });
  return writes;
}
beforeEach(() => { from.mockReset(); });

describe('salvamento realista do Diário normalizado', () => {
  it('identifica 403/RLS ao criar sem repetir como concorrência', async () => {
    const writes = mockResponses(response(null), response(null, { code: '42501', message: 'new row violates row-level security policy' }));
    await expect(saveOpenDailyReport('project', base, local)).rejects.toBeInstanceOf(DailyReportPermissionError);
    expect(writes).toEqual(['insert']);
    expect(from).toHaveBeenCalledTimes(2);
  });
  it('identifica UPDATE sem linha afetada e versão inalterada como falta de permissão', async () => {
    const writes = mockResponses(response(row()), response(null), response(row()));
    await expect(saveOpenDailyReport('project', base, local)).rejects.toBeInstanceOf(DailyReportPermissionError);
    expect(writes).toEqual(['update']);
  });
  it('repete apenas quando a versão realmente mudou, preservando o campo remoto', async () => {
    const remote = { ...base, impediments: 'Impedimento de outro usuário' };
    const saved = { ...local, impediments: remote.impediments };
    const writes = mockResponses(response(row()), response(null), response(row(remote, 'v2')), response({ data: saved }));
    await expect(saveOpenDailyReport('project', base, local)).resolves.toEqual({ report: saved, conflicts: [] });
    expect(writes).toEqual(['update', 'update']);
  });
  it('confirma o dado devolvido pelo servidor depois de criar', async () => {
    const writes = mockResponses(response(null), response({ data: local }));
    await expect(saveOpenDailyReport('project', base, local)).resolves.toEqual({ report: local, conflicts: [] });
    expect(writes).toEqual(['insert']);
  });
  it('não tenta atualizar um Diário concluído', async () => {
    const writes = mockResponses(response(row({ ...base, concludedAt: '2026-09-10T12:00:00Z' })));
    await expect(saveOpenDailyReport('project', base, local)).rejects.toBeInstanceOf(DailyReportLockedError);
    expect(writes).toEqual([]);
  });
});
