import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { projectAreasForCollections } from '@/lib/projectDataScope';
import { useProjectCollectionTracker } from './useProjectCollectionTracker';

const project = (id: string, name = 'Obra'): Project => ({
  id, name, startDate: '2026-10-20', endDate: '2027-10-20', phases: [], totalBudget: 0,
});

describe('controle das coleções por obra', () => {
  it('sinaliza apenas a área remota alterada e remove o aviso depois da conciliação', () => {
    const { result } = renderHook(useProjectCollectionTracker);
    act(() => result.current.markRemoteCollections('obra-a', ['warehouseMovements']));
    expect(result.current.pendingRemoteAreas).toEqual(projectAreasForCollections(['warehouseMovements']));
    expect(result.current.remoteDirtyCollectionsRef.current.get('obra-a')).toEqual(new Set(['warehouseMovements']));
    expect(result.current.hasLocalCollectionConflict('obra-a', ['tasks'])).toBe(false);

    act(() => result.current.clearRemoteCollections('obra-a', ['warehouseMovements']));
    expect(result.current.pendingRemoteAreas).toEqual([]);
    expect(result.current.remoteDirtyCollectionsRef.current.has('obra-a')).toBe(false);
  });

  it('não confunde alteração de metadados com conflito nas tarefas', () => {
    const { result } = renderHook(useProjectCollectionTracker);
    act(() => result.current.markLocalProjectChanges(project('obra-a'), project('obra-a', 'Outro nome')));
    expect(result.current.localMetadataDirtyRef.current.has('obra-a')).toBe(true);
    expect(result.current.hasLocalCollectionConflict('obra-a', ['tasks'])).toBe(false);
    act(() => result.current.clearLocalProjectCollections('obra-a'));
    expect(result.current.localMetadataDirtyRef.current.has('obra-a')).toBe(false);
  });

  it('preserva o conflito da própria área até a confirmação de seu grupo de coleções', () => {
    const { result } = renderHook(useProjectCollectionTracker);
    result.current.localDirtyCollectionsRef.current.set('obra-a', new Set(['tasks']));
    expect(result.current.hasLocalCollectionConflict('obra-a', ['eapChapters'])).toBe(true);
    expect(result.current.hasLocalCollectionConflict('obra-a', ['warehouseMovements'])).toBe(false);
    act(() => result.current.clearLocalProjectCollections('obra-a', ['eapChapters']));
    expect(result.current.hasLocalCollectionConflict('obra-a', ['tasks'])).toBe(false);
  });

  it('limpa apenas as obras da troca, incluindo eventos e cargas antigas', () => {
    const { result } = renderHook(useProjectCollectionTracker);
    act(() => {
      result.current.markRemoteCollections('antiga', ['tasks']);
      result.current.markRemoteCollections('nova', ['warehouseMovements']);
      result.current.markRemoteCollections('terceira', ['dailyReports']);
      result.current.pendingRealtimeCollectionsRef.current.set('antiga', new Set(['tasks']));
      result.current.backgroundRefreshingCollectionsRef.current.set('nova', new Set(['warehouseMovements']));
      result.current.localDirtyCollectionsRef.current.set('antiga', new Set(['tasks']));
    });
    act(() => result.current.resetProjectScopes('antiga', 'nova'));
    expect(result.current.remoteDirtyCollectionsRef.current.has('antiga')).toBe(false);
    expect(result.current.remoteDirtyCollectionsRef.current.has('nova')).toBe(false);
    expect(result.current.remoteDirtyCollectionsRef.current.has('terceira')).toBe(true);
    expect(result.current.pendingRealtimeCollectionsRef.current.has('antiga')).toBe(false);
    expect(result.current.backgroundRefreshingCollectionsRef.current.has('nova')).toBe(false);
    expect(result.current.localDirtyCollectionsRef.current.has('antiga')).toBe(false);
    expect(result.current.pendingRemoteAreas).toEqual([]);
  });
});
