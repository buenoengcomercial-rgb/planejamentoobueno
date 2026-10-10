import { beforeEach, vi } from 'vitest';
import { supabase } from '@/integrations/supabase/client';
import { loadMeasurementPeriodHeaders } from './measurementPeriodHeaders';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn() },
}));

beforeEach(() => vi.resetAllMocks());

describe('cabeçalhos de períodos da Medição', () => {
  it('lê apenas as datas explícitas e preserva o id legado sem interpretá-lo', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: [
        { id: 'draft:1:2026-08-24:2026-09-22', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'draft' },
        { id: 'second', number: 2, startDate: '2026-09-30', endDate: '2026-10-29', status: 'draft' },
      ],
      error: null,
    } as never);

    expect(await loadMeasurementPeriodHeaders('project-1')).toEqual([
      { id: 'draft:1:2026-08-24:2026-09-22', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'draft' },
      { id: 'second', number: 2, startDate: '2026-09-30', endDate: '2026-10-29', status: 'draft' },
    ]);
    expect(supabase.rpc).toHaveBeenCalledWith('list_measurement_period_headers', { p_project_id: 'project-1' });
  });

  it('distingue ausência da base de erro ou períodos incompletos', async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: null } as never)
      .mockResolvedValueOnce({ data: [{ id: 'first', number: 1, startDate: '2026-08-24', endDate: '2026-09-29' }, { id: 'second', number: 1, startDate: '2026-09-30', endDate: '2026-10-29' }], error: null } as never)
      .mockResolvedValueOnce({ data: null, error: { message: 'timeout' } } as never);

    expect(await loadMeasurementPeriodHeaders('project-1')).toBeNull();
    await expect(loadMeasurementPeriodHeaders('project-1')).rejects.toThrow('inconsistentes');
    await expect(loadMeasurementPeriodHeaders('project-1')).rejects.toThrow('timeout');
  });
});
