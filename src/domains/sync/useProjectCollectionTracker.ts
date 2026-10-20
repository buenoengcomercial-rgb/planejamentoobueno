import { useCallback, useRef, useState } from 'react';
import type { Project } from '@/types/project';
import { getChangedProjectCollections, hasProjectMetadataChanges } from '@/lib/projectSync';
import { normalizeProjectCollections, projectAreasForCollections, type ProjectCollectionKey } from '@/lib/projectDataScope';

/** Tracks dirty domains without making an unrelated area's changes a local conflict. */
export function useProjectCollectionTracker() {
  const [pendingRemoteAreas, setPendingRemoteAreas] = useState<string[]>([]);
  const [remoteDirtyRevision, setRemoteDirtyRevision] = useState(0);
  const remoteDirtyCollectionsRef = useRef<Map<string, Set<ProjectCollectionKey>>>(new Map());
  const backgroundRefreshingCollectionsRef = useRef<Map<string, Set<ProjectCollectionKey>>>(new Map());
  const pendingRealtimeCollectionsRef = useRef<Map<string, Set<ProjectCollectionKey>>>(new Map());
  const localDirtyCollectionsRef = useRef<Map<string, Set<ProjectCollectionKey>>>(new Map());
  const localMetadataDirtyRef = useRef<Set<string>>(new Set());

  const refreshPendingRemoteAreas = useCallback((projectId: string) => {
    const dirty = [...(remoteDirtyCollectionsRef.current.get(projectId) ?? [])];
    setPendingRemoteAreas(projectAreasForCollections(dirty));
  }, []);
  const notifyRemoteDirtyChange = useCallback(() => setRemoteDirtyRevision(revision => revision + 1), []);

  const markRemoteCollections = useCallback((projectId: string, collections: readonly ProjectCollectionKey[]) => {
    const normalized = normalizeProjectCollections(collections);
    if (normalized.length === 0) return;
    const dirty = remoteDirtyCollectionsRef.current.get(projectId) ?? new Set<ProjectCollectionKey>();
    normalized.forEach(collection => dirty.add(collection));
    remoteDirtyCollectionsRef.current.set(projectId, dirty);
    refreshPendingRemoteAreas(projectId);
    notifyRemoteDirtyChange();
  }, [notifyRemoteDirtyChange, refreshPendingRemoteAreas]);

  const clearRemoteCollections = useCallback((projectId: string, collections: readonly ProjectCollectionKey[]) => {
    const dirty = remoteDirtyCollectionsRef.current.get(projectId);
    if (!dirty) return;
    normalizeProjectCollections(collections).forEach(collection => dirty.delete(collection));
    if (dirty.size === 0) remoteDirtyCollectionsRef.current.delete(projectId);
    refreshPendingRemoteAreas(projectId);
    notifyRemoteDirtyChange();
  }, [notifyRemoteDirtyChange, refreshPendingRemoteAreas]);

  const clearPendingRealtimeCollections = useCallback((projectId: string, collections: readonly ProjectCollectionKey[]) => {
    const pending = pendingRealtimeCollectionsRef.current.get(projectId);
    if (!pending) return;
    normalizeProjectCollections(collections).forEach(collection => pending.delete(collection));
    if (pending.size === 0) pendingRealtimeCollectionsRef.current.delete(projectId);
  }, []);

  const markLocalProjectChanges = useCallback((before: Project, after: Project) => {
    const changed = getChangedProjectCollections(before, after);
    if (changed.length > 0) {
      const dirty = localDirtyCollectionsRef.current.get(after.id) ?? new Set<ProjectCollectionKey>();
      changed.forEach(collection => dirty.add(collection));
      localDirtyCollectionsRef.current.set(after.id, dirty);
    }
    if (hasProjectMetadataChanges(before, after)) localMetadataDirtyRef.current.add(after.id);
  }, []);

  const clearLocalProjectCollections = useCallback((projectId: string, collections?: readonly ProjectCollectionKey[]) => {
    if (!collections) {
      localDirtyCollectionsRef.current.delete(projectId);
      localMetadataDirtyRef.current.delete(projectId);
      return;
    }
    const dirty = localDirtyCollectionsRef.current.get(projectId);
    if (!dirty) return;
    normalizeProjectCollections(collections).forEach(collection => dirty.delete(collection));
    if (dirty.size === 0) localDirtyCollectionsRef.current.delete(projectId);
  }, []);

  const hasLocalCollectionConflict = useCallback((projectId: string, collections: readonly ProjectCollectionKey[]) => {
    const local = localDirtyCollectionsRef.current.get(projectId);
    if (!local) return false;
    return normalizeProjectCollections(collections).some(collection => local.has(collection));
  }, []);

  const resetProjectScopes = useCallback((previousId: string | null, nextId: string | null) => {
    for (const id of [previousId, nextId]) {
      if (!id) continue;
      remoteDirtyCollectionsRef.current.delete(id);
      backgroundRefreshingCollectionsRef.current.delete(id);
      pendingRealtimeCollectionsRef.current.delete(id);
      localDirtyCollectionsRef.current.delete(id);
      localMetadataDirtyRef.current.delete(id);
    }
    setPendingRemoteAreas([]);
    notifyRemoteDirtyChange();
  }, [notifyRemoteDirtyChange]);

  return {
    pendingRemoteAreas, remoteDirtyRevision,
    remoteDirtyCollectionsRef, backgroundRefreshingCollectionsRef, pendingRealtimeCollectionsRef,
    localDirtyCollectionsRef, localMetadataDirtyRef,
    markRemoteCollections, clearRemoteCollections, clearPendingRealtimeCollections,
    markLocalProjectChanges, clearLocalProjectCollections, hasLocalCollectionConflict,
    resetProjectScopes, notifyRemoteDirtyChange,
  };
}
