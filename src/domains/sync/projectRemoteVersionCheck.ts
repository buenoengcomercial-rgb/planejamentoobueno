import type { SaveStatus } from '@/components/SaveStatusIndicator';
import type { Project } from '@/types/project';
import type { ProjectCollectionKey } from '@/lib/projectDataScope';
import {
  confirmCloudProjectRecord,
  discardCloudProjectRecord,
  getCloudProjectVersion,
  loadCloudProjectRecord,
  type CloudProjectVersion,
} from '@/lib/cloudProjects';
import { projectHasLocalChanges, resolveRemoteVersionAction } from '@/lib/cloudProjectDraftCore';
import { reconcileRemoteProjectSnapshot } from './remoteProjectReconciliation';

interface Ref<T> { current: T }

interface RemoteVersionCheckOptions {
  organizationId: string | null;
  collections: readonly ProjectCollectionKey[];
  refs: {
    project: Ref<Project | null>;
    initialized: Ref<boolean>;
    pendingDailyReportSaves: Ref<number>;
    productionCaptureBusy: Ref<boolean>;
    checkInFlight: Ref<boolean>;
    conflictDetected: Ref<boolean>;
    saveTimer: Ref<number | null>;
    inFlightSave: Ref<Promise<void> | null>;
    partialSync: Ref<{ projectId: string } | null>;
    activeDataScopeKey: Ref<string>;
    pendingRealtimeCollections: Ref<Map<string, Set<ProjectCollectionKey>>>;
    remoteDirtyCollections: Ref<Map<string, Set<ProjectCollectionKey>>>;
    savedProjectJson: Ref<string | null>;
    projectUpdatedAt: Ref<string | null>;
    warehouseVersion: Ref<number | null>;
    observedWarehouseVersion: Ref<number | null>;
    skipNextAutoSave: Ref<boolean>;
  };
  refreshWarehouse: (project: Project, version: CloudProjectVersion) => Promise<Project | null>;
  refreshCollections: (
    project: Project, collections: readonly ProjectCollectionKey[], version: CloudProjectVersion,
  ) => Promise<Project | null>;
  hasLocalCollectionConflict: (projectId: string, collections: readonly ProjectCollectionKey[]) => boolean;
  markRemoteCollections: (projectId: string, collections: readonly ProjectCollectionKey[]) => void;
  clearRemoteCollections: (projectId: string, collections: readonly ProjectCollectionKey[]) => void;
  setSaveStatus: (status: SaveStatus) => void;
  setLastRemoteCheckAt: (value: string) => void;
  setProjectUpdatedAt: (value: string) => void;
  setLastCloudConfirmedAt: (value: string) => void;
  setProject: (project: Project) => void;
}

/** Read-only version check; only the active domain is hydrated when needed. */
export async function checkProjectRemoteVersion({
  organizationId, collections, refs, refreshWarehouse, refreshCollections,
  hasLocalCollectionConflict, markRemoteCollections, clearRemoteCollections,
  setSaveStatus, setLastRemoteCheckAt, setProjectUpdatedAt,
  setLastCloudConfirmedAt, setProject,
}: RemoteVersionCheckOptions): Promise<void> {
  const current = refs.project.current;
  if (!current || !organizationId || !refs.initialized.current || document.visibilityState !== 'visible') return;
  if (refs.pendingDailyReportSaves.current > 0) return;
  if (!navigator.onLine) {
    setSaveStatus('offline');
    return;
  }
  if (refs.productionCaptureBusy.current || refs.checkInFlight.current || refs.conflictDetected.current
    || refs.saveTimer.current || refs.inFlightSave.current) return;

  refs.checkInFlight.current = true;
  const dataScopeAtRequest = refs.activeDataScopeKey.current;
  try {
    if (refs.partialSync.current?.projectId === current.id) {
      // A partial write needs an explicit retry, never a new general write from polling.
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
      return;
    }
    const remoteVersion = await getCloudProjectVersion(current.id);
    if (!remoteVersion) return;
    const currentAfterVersionCheck = refs.project.current;
    if (!currentAfterVersionCheck
      || currentAfterVersionCheck.id !== current.id
      || refs.activeDataScopeKey.current !== dataScopeAtRequest
      || refs.conflictDetected.current || refs.saveTimer.current
      || refs.inFlightSave.current || refs.productionCaptureBusy.current) return;
    setLastRemoteCheckAt(new Date().toISOString());
    if (await refreshWarehouse(currentAfterVersionCheck, remoteVersion)) return;
    const knownRemoteCollections = [
      ...(refs.pendingRealtimeCollections.current.get(current.id) ?? []),
      ...(refs.remoteDirtyCollections.current.get(current.id) ?? []),
    ];
    if (await refreshCollections(currentAfterVersionCheck, knownRemoteCollections, remoteVersion)) return;
    const hasLocalChanges = projectHasLocalChanges(currentAfterVersionCheck, refs.savedProjectJson.current);
    const action = resolveRemoteVersionAction(remoteVersion.updatedAt, refs.projectUpdatedAt.current, hasLocalChanges);
    if (action === 'current') {
      refs.warehouseVersion.current = remoteVersion.warehouseVersion;
      refs.observedWarehouseVersion.current = remoteVersion.warehouseVersion;
      if (!hasLocalChanges) setSaveStatus('saved');
      return;
    }
    if (action === 'conflict') {
      // An unclassified change must not replace a locally edited collection.
      markRemoteCollections(current.id, collections);
      return;
    }

    setSaveStatus('updating');
    const record = await loadCloudProjectRecord(current.id, {
      collections, strict: true, deferSnapshot: true,
    });
    if (!record) throw new Error('A obra não foi encontrada na nuvem.');
    const latestLocal = refs.project.current;
    if (refs.productionCaptureBusy.current || !latestLocal || latestLocal.id !== current.id
      || refs.activeDataScopeKey.current !== dataScopeAtRequest) {
      discardCloudProjectRecord(record);
      return;
    }
    if (hasLocalCollectionConflict(current.id, collections)) {
      discardCloudProjectRecord(record);
      markRemoteCollections(current.id, collections);
      return;
    }
    confirmCloudProjectRecord(record);
    const reconciled = reconcileRemoteProjectSnapshot({
      local: latestLocal,
      remote: record.project,
      savedProjectJson: refs.savedProjectJson.current,
      collections,
    });
    refs.savedProjectJson.current = reconciled.confirmedBaselineJson;
    refs.projectUpdatedAt.current = record.updatedAt;
    refs.warehouseVersion.current = record.warehouseVersion;
    refs.observedWarehouseVersion.current = record.warehouseVersion;
    setProjectUpdatedAt(record.updatedAt);
    if (!reconciled.hasPendingLocalChanges) setLastCloudConfirmedAt(record.updatedAt);
    clearRemoteCollections(current.id, collections);
    refs.skipNextAutoSave.current = !reconciled.hasPendingLocalChanges;
    refs.project.current = reconciled.project;
    setProject(reconciled.project);
    setSaveStatus(reconciled.hasPendingLocalChanges ? 'saving' : 'saved');
  } catch (error) {
    console.warn('Falha ao conferir a versão da obra na nuvem.', error);
    setSaveStatus(navigator.onLine ? 'error' : 'offline');
  } finally {
    refs.checkInFlight.current = false;
  }
}
