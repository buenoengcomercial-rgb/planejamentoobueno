import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { DailyReport, Project } from '@/types/project';
import { recoverDailyReportDraft, saveDailyReportEdits, type DailyReportSaveContext } from './dailyReportSaveController';

const mocks = vi.hoisted(() => ({
  protect: vi.fn(),
  clear: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
}));

vi.mock('@/lib/dailyReportDrafts', () => ({
  protectDailyReportDraft: mocks.protect,
  clearDailyReportDraft: mocks.clear,
}));
vi.mock('@/lib/dailyReportCloudSync', () => ({
  saveOpenDailyReport: mocks.save,
  loadOpenDailyReport: mocks.load,
}));
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const date = '2026-10-23';
const report = (notes: string): DailyReport => ({
  id: 'report-1', date, notes, teamsPresent: [], equipment: [], attachments: [],
  createdAt: date, updatedAt: date,
} as unknown as DailyReport);
const project = (entry: DailyReport): Project => ({ id: 'project-1', dailyReports: [entry] } as Project);

function context(current: Project): DailyReportSaveContext {
  const value = {
    actorId: 'actor-1',
    rawProjectRef: { current },
    dailyReportDraftsRef: { current: {} },
    dailyReportSaveQueueRef: { current: Promise.resolve() },
    pendingDailyReportSavesRef: { current: 0 },
    lastSavedProjectJsonRef: { current: JSON.stringify(current) },
    currentProjectUpdatedAtRef: { current: 'version-1' },
    conflictDetectedRef: { current: false },
    partialSyncPendingRef: { current: null },
    dailyReportRecoveryBusy: false,
    setDailyReportRecoveryBusy: vi.fn(),
    setDailyReportDrafts: vi.fn(),
    setDailyReportSaveErrors: vi.fn(),
    setSaveStatus: vi.fn(),
    setRawProject: vi.fn(),
    mergeConfirmedDailyReportIntoPartialSync: vi.fn(),
    clearLocalProjectCollections: vi.fn(),
    confirmDiscardPendingForm: vi.fn(),
  } as unknown as DailyReportSaveContext;
  value.setRawProject = vi.fn(update => {
    value.rawProjectRef.current = typeof update === 'function' ? update(value.rawProjectRef.current) : update;
  });
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.protect.mockResolvedValue(undefined);
  mocks.clear.mockResolvedValue(true);
  mocks.load.mockResolvedValue(report('cloud'));
});

describe('Diário: fila, rascunho e confirmação', () => {
  it('protege a revisão antes do envio e só remove a cópia confirmada', async () => {
    const before = project(report('before'));
    const after = project(report('after'));
    const scope = context(after);
    mocks.save.mockResolvedValue({ report: after.dailyReports[0], conflicts: [] });

    saveDailyReportEdits(before, after, scope);
    expect(mocks.protect).toHaveBeenCalledOnce();
    expect(scope.dailyReportDraftsRef.current[date]?.local).toEqual(after.dailyReports[0]);
    await scope.dailyReportSaveQueueRef.current;
    expect(mocks.save).toHaveBeenCalledWith(after.id, before.dailyReports[0], after.dailyReports[0]);
    expect(mocks.clear).toHaveBeenCalledWith(after.id, 'actor-1', date, expect.any(String));
    expect(scope.dailyReportDraftsRef.current[date]).toBeUndefined();
    expect(scope.clearLocalProjectCollections).toHaveBeenCalledWith(after.id, ['dailyReports']);
  });

  it('mantém a revisão mais recente quando a resposta anterior chega atrasada', async () => {
    const before = project(report('before'));
    const first = project(report('first'));
    const second = project(report('second'));
    const scope = context(second);
    mocks.save.mockResolvedValueOnce({ report: first.dailyReports[0], conflicts: [] })
      .mockResolvedValueOnce({ report: second.dailyReports[0], conflicts: [] });

    saveDailyReportEdits(before, first, scope);
    const firstRevision = scope.dailyReportDraftsRef.current[date].revision;
    saveDailyReportEdits(first, second, scope);
    const secondRevision = scope.dailyReportDraftsRef.current[date].revision;
    expect(secondRevision).not.toBe(firstRevision);
    await scope.dailyReportSaveQueueRef.current;
    expect(mocks.clear.mock.calls.map(call => call[3])).toEqual([firstRevision, secondRevision]);
    expect(scope.dailyReportDraftsRef.current[date]).toBeUndefined();
    expect(scope.rawProjectRef.current?.dailyReports[0]).toEqual(second.dailyReports[0]);
  });

  it('preserva o rascunho quando a gravação informa conflito', async () => {
    const before = project(report('before'));
    const after = project(report('after'));
    const scope = context(after);
    mocks.save.mockResolvedValue({ report: before.dailyReports[0], conflicts: ['notes'] });

    saveDailyReportEdits(before, after, scope);
    await scope.dailyReportSaveQueueRef.current;
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(scope.dailyReportDraftsRef.current[date]?.local).toEqual(after.dailyReports[0]);
  });

  it('mantém a cópia local após falha da nuvem e não confirma o valor digitado', async () => {
    const before = project(report('before'));
    const after = project(report('after'));
    const scope = context(after);
    mocks.save.mockRejectedValue(new Error('Failed to fetch'));

    saveDailyReportEdits(before, after, scope);
    await expect(scope.dailyReportSaveQueueRef.current).rejects.toThrow('Failed to fetch');
    await waitFor(() => expect(scope.pendingDailyReportSavesRef.current).toBe(0));
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(scope.dailyReportDraftsRef.current[date]?.local).toEqual(after.dailyReports[0]);
    expect(scope.setDailyReportSaveErrors).toHaveBeenCalled();
  });

  it('não descarta rascunho sem a confirmação explícita do usuário', async () => {
    const before = project(report('before'));
    const scope = context(before);
    scope.dailyReportDraftsRef.current[date] = {
      revision: 'revision-1', base: before.dailyReports[0], local: report('local'),
    };

    await recoverDailyReportDraft(date, true, scope);
    expect(scope.confirmDiscardPendingForm).toHaveBeenCalledOnce();
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(scope.dailyReportDraftsRef.current[date]).toBeDefined();
  });
});
