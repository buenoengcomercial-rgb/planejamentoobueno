// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudMeasurementRepository } from './measurementCloudRepository';
const mocks = vi.hoisted(() => ({ from: vi.fn(), channel: vi.fn(), removeChannel: vi.fn(async () => undefined), maybeSingle: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: mocks }));
vi.mock('./measurementWorkspaceStore', () => ({ measurementRepository: () => ({}) }));
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());
describe('canal de revisão da Medição', () => {
  it('consulta somente a revisão e rejeita falta de acesso ou resposta incompleta', async () => {
    const select = vi.fn().mockReturnThis(), eq = vi.fn().mockReturnThis();
    mocks.from.mockReturnValue({ select, eq, maybeSingle: mocks.maybeSingle });
    const repo = cloudMeasurementRepository({ userId: 'u', projectId: 'p' });
    mocks.maybeSingle.mockResolvedValueOnce({ data: { revision: 12 }, error: null });
    expect(await repo.remoteRevision!()).toBe(12);
    expect(select).toHaveBeenCalledWith('revision'); expect(eq).toHaveBeenCalledWith('project_id', 'p');
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'Sem acesso' } });
    await expect(repo.remoteRevision!()).rejects.toThrow('conferir');
  });
  it('filtra por obra, não publica quantitativos e remove o canal ao sair', async () => {
    let event!: (payload: { new: { project_id: string; revision: number } }) => void;
    let state!: (value: string) => void;
    const channel = { on: vi.fn((_kind, _filter, handler) => { event = handler; return channel; }), subscribe: vi.fn(handler => { state = handler; return channel; }) };
    mocks.channel.mockReturnValue(channel);
    const notice = vi.fn(), connection = vi.fn();
    const stop = cloudMeasurementRepository({ userId: 'u', projectId: 'p' }).watch!(notice, connection);
    expect(channel.on.mock.calls[0].slice(0, 2)).toEqual(['postgres_changes', { event: '*', schema: 'public', table: 'measurement_workspace_versions', filter: 'project_id=eq.p' }]);
    state('SUBSCRIBED'); expect(connection).toHaveBeenLastCalledWith(true);
    event({ new: { project_id: 'other', revision: 4 } }); expect(notice).not.toHaveBeenCalled();
    event({ new: { project_id: 'p', revision: 4 } }); expect(notice).toHaveBeenCalledWith(4);
    state('CHANNEL_ERROR'); expect(connection).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(3000); expect(mocks.channel).toHaveBeenCalledTimes(2);
    stop(); event({ new: { project_id: 'p', revision: 5 } }); expect(notice).toHaveBeenCalledOnce();
    expect(mocks.removeChannel).toHaveBeenCalledTimes(2);
  });
});
