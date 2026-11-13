import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { projectDraftKey } from '@/lib/cloudProjectDraftCore';
import { supportsIndexedDbDrafts, writeIndexedDbProjectDraft } from '@/lib/cloudDraftIndexedDb';
import { useProtectedProjectDrafts } from './useProtectedProjectDrafts';

vi.mock('@/lib/cloudDraftIndexedDb', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/cloudDraftIndexedDb')>();
  return {
    ...actual,
    supportsIndexedDbDrafts: vi.fn(actual.supportsIndexedDbDrafts),
    writeIndexedDbProjectDraft: vi.fn(actual.writeIndexedDbProjectDraft),
  };
});

function project(id: string): Project {
  return { id, name: `Obra ${id}`, startDate: '2026-10-01', endDate: '2026-10-31', phases: [], totalBudget: 0 };
}

function setup(confirmedProject?: Project) {
  const partialSyncPendingRef = { current: null as {
    projectId: string; loadedCollections: []; project: Project; draftProtected: boolean;
  } | null };
  const setPartialSyncIssue = vi.fn();
  const setSaveStatus = vi.fn();
  const hook = renderHook(() => useProtectedProjectDrafts({
    partialSyncPendingRef, conflictDetectedRef: { current: false },
    rawProjectRef: { current: null }, setPartialSyncIssue, setSaveStatus,
    savedProjectJsonRef: { current: confirmedProject ? JSON.stringify(confirmedProject) : null },
    projectUpdatedAtRef: { current: confirmedProject ? 'v1' : null },
  }));
  return { ...hook, partialSyncPendingRef, setPartialSyncIssue, setSaveStatus };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.mocked(supportsIndexedDbDrafts).mockReturnValue(false);
  vi.mocked(writeIndexedDbProjectDraft).mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('rascunhos protegidos da obra', () => {
  it('guarda a versão confirmada para mesclar após recarregar em outro aparelho', () => {
    const baseline = project('obra-0');
    const { result } = setup(baseline);
    act(() => result.current.writeProtectedProjectDraft({ ...baseline, name: 'Edição local' }, 'v1'));
    const stored = JSON.parse(localStorage.getItem(projectDraftKey(baseline.id)) ?? '{}');
    expect(stored.baseProject.name).toBe(baseline.name);
    expect(stored.project.name).toBe('Edição local');
  });

  it('salva imediatamente o rascunho anterior ao trocar de obra e agenda o novo', () => {
    const { result } = setup();
    act(() => result.current.scheduleProjectDraft(project('obra-1'), 'v1'));
    expect(localStorage.getItem(projectDraftKey('obra-1'))).toBeNull();

    act(() => result.current.scheduleProjectDraft(project('obra-2'), 'v2'));
    expect(JSON.parse(localStorage.getItem(projectDraftKey('obra-1')) ?? '{}')).toMatchObject({
      baseUpdatedAt: 'v1', project: { id: 'obra-1' },
    });
    expect(localStorage.getItem(projectDraftKey('obra-2'))).toBeNull();

    act(() => vi.advanceTimersByTime(900));
    expect(JSON.parse(localStorage.getItem(projectDraftKey('obra-2')) ?? '{}')).toMatchObject({
      baseUpdatedAt: 'v2', project: { id: 'obra-2' },
    });
  });

  it('não recria um rascunho descartado quando o temporizador vencer', () => {
    const { result } = setup();
    act(() => {
      result.current.scheduleProjectDraft(project('obra-3'), 'v3');
      result.current.discardProjectDraft('obra-3');
      vi.advanceTimersByTime(900);
    });
    expect(localStorage.getItem(projectDraftKey('obra-3'))).toBeNull();
    expect(result.current.pendingDraftRef.current).toBeNull();
  });

  it('marca a sincronização parcial como protegida somente após gravar a cópia local', () => {
    const { result, partialSyncPendingRef, setPartialSyncIssue } = setup();
    const candidate = project('obra-4');
    partialSyncPendingRef.current = {
      projectId: candidate.id, loadedCollections: [], project: candidate, draftProtected: false,
    };
    act(() => { result.current.writeProtectedProjectDraft(candidate, 'v4'); });
    expect(JSON.parse(localStorage.getItem(projectDraftKey(candidate.id)) ?? '{}')).toMatchObject({
      pendingNormalizedSync: true, baseUpdatedAt: 'v4',
    });
    expect(partialSyncPendingRef.current?.draftProtected).toBe(true);
    expect(setPartialSyncIssue).toHaveBeenCalledWith({ projectId: candidate.id, draftProtected: true });
  });

  it('não recria a cópia local quando a purga invalida uma escrita IndexedDB em voo', async () => {
    vi.mocked(supportsIndexedDbDrafts).mockReturnValue(true);
    let finishWrite!: (draft: null) => void;
    vi.mocked(writeIndexedDbProjectDraft).mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    const { result } = setup();
    const local = project('obra-6');
    act(() => result.current.scheduleProjectDraft(local, 'v6'));
    act(() => vi.advanceTimersByTime(900));
    expect(writeIndexedDbProjectDraft).toHaveBeenCalledOnce();

    await act(async () => {
      const purging = result.current.discardProjectDraft(local.id);
      finishWrite(null);
      await purging;
    });

    expect(localStorage.getItem(projectDraftKey(local.id))).toBeNull();
    expect(writeIndexedDbProjectDraft).toHaveBeenCalledOnce();
  });

  it('usa cópia local quando o envio agendado ao IndexedDB falha', async () => {
    vi.mocked(supportsIndexedDbDrafts).mockReturnValue(true);
    vi.mocked(writeIndexedDbProjectDraft).mockResolvedValue(null);
    const { result } = setup();
    act(() => result.current.scheduleProjectDraft(project('obra-5'), 'v5'));

    await act(async () => {
      vi.advanceTimersByTime(900);
      await Promise.resolve();
    });
    expect(writeIndexedDbProjectDraft).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(projectDraftKey('obra-5')) ?? '{}')).toMatchObject({
      baseUpdatedAt: 'v5', project: { id: 'obra-5' },
    });
  });
});
