import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Project } from '@/types/project';
import type { SaveStatus } from '@/components/SaveStatusIndicator';
import { confirmCloudProjectRecord, discardCloudProjectRecord, getCloudProjectVersion, loadCloudProjectRecord } from '@/lib/cloudProjects';
import { projectHasLocalChanges, serializeProject } from '@/lib/cloudProjectDraftCore';
import { WAREHOUSE_REMOTE_SYNC_COLLECTIONS, type ProjectCollectionKey } from '@/lib/projectDataScope';
import { planRealtimeProjectRefresh, reconcileRemoteProjectSnapshot } from './remoteProjectReconciliation';

export interface ProjectRealtimeRefreshDeps {
  requiredProjectCollections: readonly ProjectCollectionKey[];
  rawProjectRef: MutableRefObject<Project | null>;
  initialLoadRef: MutableRefObject<boolean>;
  remoteCheckInFlightRef: MutableRefObject<boolean>;
  conflictDetectedRef: MutableRefObject<boolean>;
  partialSyncPendingRef: MutableRefObject<{ projectId: string } | null>;
  pendingDailyReportSavesRef: MutableRefObject<number>;
  productionCaptureBusyRef: MutableRefObject<boolean>;
  saveTimerRef: MutableRefObject<number | null>;
  inFlightSaveRef: MutableRefObject<Promise<void> | null>;
  realtimeRefreshTimerRef: MutableRefObject<number | null>;
  localMetadataDirtyRef: MutableRefObject<Set<string>>;
  currentProjectUpdatedAtRef: MutableRefObject<string | null>;
  currentWarehouseVersionRef: MutableRefObject<number | null>;
  lastObservedWarehouseVersionRef: MutableRefObject<number | null>;
  activeDataScopeKeyRef: MutableRefObject<string>;
  lastSavedProjectJsonRef: MutableRefObject<string | null>;
  skipNextAutoSaveRef: MutableRefObject<boolean>;
  refreshRemoteWarehouseInBackground: (project: Project) => Promise<Project | null>;
  refreshRemoteCollectionsInBackground: (project: Project, collections: readonly ProjectCollectionKey[]) => Promise<Project | null>;
  markRemoteCollections: (projectId: string, collections: readonly ProjectCollectionKey[]) => void;
  clearRemoteCollections: (projectId: string, collections: readonly ProjectCollectionKey[]) => void;
  hasLocalCollectionConflict: (projectId: string, collections: readonly ProjectCollectionKey[]) => boolean;
  setCurrentProjectUpdatedAt: Dispatch<SetStateAction<string | null>>;
  setLastCloudConfirmedAt: Dispatch<SetStateAction<string | null>>;
  setRemoteUpdateAt: Dispatch<SetStateAction<string | null>>;
  setRawProject: Dispatch<SetStateAction<Project | null>>;
  setSaveStatus: Dispatch<SetStateAction<SaveStatus>>;
}

/** Applies a realtime signal only to its affected collections and preserves in-progress local edits. */
export function useProjectRealtimeRefresh({
  requiredProjectCollections, rawProjectRef, initialLoadRef, remoteCheckInFlightRef,
  conflictDetectedRef, partialSyncPendingRef, pendingDailyReportSavesRef,
  productionCaptureBusyRef, saveTimerRef, inFlightSaveRef, realtimeRefreshTimerRef,
  localMetadataDirtyRef, currentProjectUpdatedAtRef, currentWarehouseVersionRef,
  lastObservedWarehouseVersionRef, activeDataScopeKeyRef, lastSavedProjectJsonRef,
  skipNextAutoSaveRef, refreshRemoteWarehouseInBackground,
  refreshRemoteCollectionsInBackground, markRemoteCollections, clearRemoteCollections,
  hasLocalCollectionConflict, setCurrentProjectUpdatedAt, setLastCloudConfirmedAt,
  setRemoteUpdateAt, setRawProject, setSaveStatus,
}: ProjectRealtimeRefreshDeps) {
  const refreshProjectFromRealtime = useCallback(async (sources: readonly string[] = []) => {
    const current = rawProjectRef.current;
    if (!current || !initialLoadRef.current || remoteCheckInFlightRef.current) return;
    if (conflictDetectedRef.current) {
      setSaveStatus('conflict');
      return;
    }
    if (partialSyncPendingRef.current?.projectId === current.id) {
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
      return;
    }
    if (pendingDailyReportSavesRef.current > 0) {
      if (realtimeRefreshTimerRef.current) window.clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = window.setTimeout(() => void refreshProjectFromRealtime(sources), 600);
      return;
    }
    if (productionCaptureBusyRef.current || saveTimerRef.current || inFlightSaveRef.current) {
      if (realtimeRefreshTimerRef.current) window.clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = window.setTimeout(() => void refreshProjectFromRealtime(sources), 1200);
      return;
    }

    const {
      affectedCollections, metadataOnly, requestCollections, activeCollections, inactiveCollections,
    } = planRealtimeProjectRefresh(sources, requiredProjectCollections);
    if (affectedCollections.some(collection => WAREHOUSE_REMOTE_SYNC_COLLECTIONS.includes(collection))) {
      if (await refreshRemoteWarehouseInBackground(current)) return;
    }
    if (await refreshRemoteCollectionsInBackground(current, affectedCollections)) return;
    // Sem tabela identificada, a consulta permanece limitada à área aberta.
    if (inactiveCollections.length > 0) markRemoteCollections(current.id, inactiveCollections);
    if ((metadataOnly && localMetadataDirtyRef.current.has(current.id))
      || (requestCollections.length > 0 && hasLocalCollectionConflict(current.id, requestCollections))) {
      markRemoteCollections(current.id, requestCollections);
      // A notification is not a rejected write. Keep the original expected
      // fields until the transaction can resolve this operation on the server.
      return;
    }

    // Outra aba recebeu alteração: atualize somente o marcador e a versão
    // otimista. Não faça download, não troque objetos locais e não mexa no UI.
    if (requestCollections.length > 0 && activeCollections.length === 0) {
      const remoteVersion = await getCloudProjectVersion(current.id).catch(() => null);
      if (remoteVersion && rawProjectRef.current?.id === current.id) {
        currentProjectUpdatedAtRef.current = remoteVersion.updatedAt;
        currentWarehouseVersionRef.current = remoteVersion.warehouseVersion;
        lastObservedWarehouseVersionRef.current = remoteVersion.warehouseVersion;
        setCurrentProjectUpdatedAt(remoteVersion.updatedAt);
        if (!projectHasLocalChanges(rawProjectRef.current, lastSavedProjectJsonRef.current)) {
          setLastCloudConfirmedAt(remoteVersion.updatedAt);
        }
      }
      return;
    }

    remoteCheckInFlightRef.current = true;
    try {
      const latestLocal = rawProjectRef.current;
      if (!latestLocal || latestLocal.id !== current.id) return;
      const localJsonAtRequest = serializeProject(latestLocal);
      const updatedAtAtRequest = currentProjectUpdatedAtRef.current;
      const dataScopeAtRequest = activeDataScopeKeyRef.current;

      const record = await loadCloudProjectRecord(current.id, {
        collections: requestCollections,
        strict: true,
        deferSnapshot: true,
      });
      if (!record) return;
      const localAfterRequest = rawProjectRef.current;
      if (productionCaptureBusyRef.current || !localAfterRequest || localAfterRequest.id !== current.id) {
        discardCloudProjectRecord(record);
        return;
      }
      const localChangedDuringRequest = serializeProject(localAfterRequest) !== localJsonAtRequest
        || currentProjectUpdatedAtRef.current !== updatedAtAtRequest
        || activeDataScopeKeyRef.current !== dataScopeAtRequest;
      if (localChangedDuringRequest && hasLocalCollectionConflict(current.id, requestCollections)) {
        discardCloudProjectRecord(record);
        markRemoteCollections(current.id, requestCollections);
        return;
      }
      confirmCloudProjectRecord(record);
      const reconciled = reconcileRemoteProjectSnapshot({
        local: localAfterRequest,
        remote: record.project,
        savedProjectJson: lastSavedProjectJsonRef.current,
        collections: requestCollections,
        metadataOnly,
      });
      lastSavedProjectJsonRef.current = reconciled.confirmedBaselineJson;
      currentProjectUpdatedAtRef.current = record.updatedAt;
      currentWarehouseVersionRef.current = record.warehouseVersion;
      lastObservedWarehouseVersionRef.current = record.warehouseVersion;
      setCurrentProjectUpdatedAt(record.updatedAt);
      if (!reconciled.hasPendingLocalChanges) setLastCloudConfirmedAt(record.updatedAt);
      clearRemoteCollections(current.id, requestCollections);
      setRemoteUpdateAt(new Date().toISOString());
      skipNextAutoSaveRef.current = !reconciled.hasPendingLocalChanges;
      rawProjectRef.current = reconciled.project;
      setRawProject(reconciled.project);
      setSaveStatus(reconciled.hasPendingLocalChanges ? 'saving' : 'saved');
    } catch (error) {
      console.warn('Falha ao aplicar atualização em tempo real.', error);
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
    } finally {
      remoteCheckInFlightRef.current = false;
    }
  }, [activeDataScopeKeyRef, clearRemoteCollections, conflictDetectedRef, currentProjectUpdatedAtRef, currentWarehouseVersionRef, hasLocalCollectionConflict, inFlightSaveRef, initialLoadRef, lastObservedWarehouseVersionRef, lastSavedProjectJsonRef, localMetadataDirtyRef, markRemoteCollections, partialSyncPendingRef, pendingDailyReportSavesRef, productionCaptureBusyRef, rawProjectRef, realtimeRefreshTimerRef, refreshRemoteCollectionsInBackground, refreshRemoteWarehouseInBackground, remoteCheckInFlightRef, requiredProjectCollections, saveTimerRef, setCurrentProjectUpdatedAt, setLastCloudConfirmedAt, setRawProject, setRemoteUpdateAt, setSaveStatus, skipNextAutoSaveRef]);

  return refreshProjectFromRealtime;
}
