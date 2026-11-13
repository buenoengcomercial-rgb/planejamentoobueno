import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { applyProjectOperation } from '@/lib/projectOperations';
import { projectAutoSaveDelay, useProjectAutoSave } from './useProjectAutoSave';

describe('tempo de espera do autosave', () => {
  it('antecipa apenas alterações originadas no Cronograma do Aditivo', () => {
    const base = { id: 'project-1', name: 'Obra', additives: [{ id: 'add-1', name: 'Aditivo' }] } as Project;
    const edited = applyProjectOperation('additiveSchedule', base, base, {
      ...base, additives: [{ ...base.additives![0], scheduleDraft: { plannedTasks: [] } }],
    } as Project);
    expect(projectAutoSaveDelay(edited)).toBe(700);
    expect(projectAutoSaveDelay(base)).toBe(1200);
  });
});

const ref = <T,>(current: T) => ({ current });
const project = { id: 'obra', name: 'Primeira edição' } as Project;

function setup() {
  vi.useFakeTimers();
  const options: Parameters<typeof useProjectAutoSave>[0] = {
    project, userId: 'user', organizationId: 'org', canPersist: true,
    recoveredDraftRevision: 0, retryTick: 0, initialLoadRef: ref(true),
    pendingDailyReportSavesRef: ref(0), dailyReportSaveQueueRef: ref(Promise.resolve()),
    inFlightSaveRef: ref(null), conflictDetectedRef: ref(false),
    skipNextAutoSaveRef: ref(false), partialSyncPendingRef: ref(null),
    saveTimerRef: ref(null), saveRetryTimerRef: ref(null), saveRetryAttemptRef: ref(0),
    saveRetryProjectJsonRef: ref(null), lastSavedProjectJsonRef: ref(null),
    rawProjectRef: ref(project), setSaveStatus: vi.fn(), setRetryTick: vi.fn(),
    persistProject: vi.fn(async () => undefined), handleCloudConflict: vi.fn(),
  };
  return options;
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('inicia a gravação geral após 1200 ms', async () => {
  const options = setup();
  renderHook(() => useProjectAutoSave(options));
  await act(() => vi.advanceTimersByTimeAsync(1199));
  expect(options.persistProject).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(options.persistProject).toHaveBeenCalledExactlyOnceWith(project, 'org');
});

it('aguarda o Diário e a gravação em andamento antes de enviar só a última edição', async () => {
  const options = setup();
  let finishDiary!: () => void;
  let finishSave!: () => void;
  options.pendingDailyReportSavesRef.current = 1;
  options.dailyReportSaveQueueRef.current = new Promise<void>(resolve => { finishDiary = resolve; });
  options.inFlightSaveRef.current = new Promise<void>(resolve => { finishSave = resolve; });
  const hook = renderHook(({ project }) => useProjectAutoSave({ ...options, project }), { initialProps: { project } });
  await act(() => vi.advanceTimersByTimeAsync(1200));

  const latest = { ...project, name: 'Última edição' };
  options.rawProjectRef.current = latest;
  hook.rerender({ project: latest });
  await act(() => vi.advanceTimersByTimeAsync(1200));
  expect(options.persistProject).not.toHaveBeenCalled();

  await act(async () => { options.pendingDailyReportSavesRef.current = 0; finishDiary(); });
  expect(options.persistProject).not.toHaveBeenCalled();
  await act(async () => { options.inFlightSaveRef.current = null; finishSave(); });
  expect(options.persistProject).toHaveBeenCalledExactlyOnceWith(latest, 'org');
});
