import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppView, DailyReport, Project } from '@/types/project';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { useDailyReportRealtime } from './useDailyReportRealtime';

const sync = vi.hoisted(() => ({ missing: vi.fn(), confirm: vi.fn() }));
vi.mock('@/lib/projectSync', () => ({
  getMissingProjectCollections: sync.missing,
  confirmProjectCollectionsSnapshot: sync.confirm,
}));

const project = (id = 'obra-1', observation = 'Original'): Project => ({
  id, name: 'Obra', startDate: '2026-10-01', endDate: '2026-12-01', phases: [], totalBudget: 0,
  dailyReports: [{ id: 'diario-1', date: '2026-10-20', observations: observation }],
} as Project);

function setup(activeView: AppView = 'dailyReport') {
  const current = project();
  const refs = {
    project: { current: current as Project | null },
    conflictDetected: { current: false },
    pendingSaves: { current: 0 },
    saveTimer: { current: null as number | null },
    inFlightSave: { current: null as Promise<void> | null },
    skipNextAutoSave: { current: false },
    savedProjectJson: { current: serializeProject(current) as string | null },
  };
  const actions = {
    markRemoteCollections: vi.fn(), mergeIntoPartialSync: vi.fn(),
    setProject: vi.fn(), setRemoteUpdateAt: vi.fn(),
  };
  const options = { projectId: current.id, activeView, ...refs, ...actions };
  const hook = renderHook(({ currentOptions }) => useDailyReportRealtime(currentOptions), {
    initialProps: { currentOptions: options },
  });
  return { refs, actions, options, hook };
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('recepção em tempo real do Diário', () => {
  it('marca apenas o Diário ao receber evento enquanto outra aba está aberta', () => {
    const { refs, actions, hook } = setup('measurement');
    act(() => hook.result.current({ id: 'diario-1', date: '2026-10-20', observations: 'Remoto' } as DailyReport));
    expect(actions.markRemoteCollections).toHaveBeenCalledWith('obra-1', ['dailyReports']);
    expect(actions.setProject).not.toHaveBeenCalled();
    expect(refs.project.current?.dailyReports?.[0]?.observations).toBe('Original');
    hook.unmount();
  });

  it('espera gravação local, então aplica somente o registro confirmado sem iniciar autosave', () => {
    vi.useFakeTimers();
    sync.missing.mockReturnValue([]);
    const { refs, actions, hook } = setup();
    refs.pendingSaves.current = 1;
    act(() => hook.result.current({ id: 'diario-1', date: '2026-10-20', observations: 'Remoto' } as DailyReport));
    expect(actions.setProject).not.toHaveBeenCalled();
    refs.pendingSaves.current = 0;
    act(() => vi.advanceTimersByTime(1200));
    expect(refs.project.current?.dailyReports?.[0]?.observations).toBe('Remoto');
    expect(JSON.parse(refs.savedProjectJson.current!).dailyReports[0].observations).toBe('Remoto');
    expect(refs.skipNextAutoSave.current).toBe(true);
    expect(sync.confirm).toHaveBeenCalledWith(refs.project.current, ['dailyReports']);
    expect(actions.setProject).toHaveBeenCalledOnce();
    hook.unmount();
  });

  it('descarta evento agendado ao mudar de obra', () => {
    vi.useFakeTimers();
    const { refs, actions, options, hook } = setup();
    refs.pendingSaves.current = 1;
    act(() => hook.result.current({ id: 'diario-1', date: '2026-10-20', observations: 'Remoto' } as DailyReport));
    refs.project.current = project('obra-2');
    hook.rerender({ currentOptions: { ...options, projectId: 'obra-2' } });
    refs.pendingSaves.current = 0;
    act(() => vi.advanceTimersByTime(1200));
    expect(actions.setProject).not.toHaveBeenCalled();
    expect(refs.project.current?.dailyReports?.[0]?.observations).toBe('Original');
    hook.unmount();
  });
});
