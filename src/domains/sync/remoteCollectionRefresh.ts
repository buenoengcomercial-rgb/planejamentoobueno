import type { Project } from '@/types/project';
import {
  confirmCloudProjectRecord, discardCloudProjectRecord, getCloudProjectVersion,
  loadCloudProjectRecord, type CloudProjectRecord, type CloudProjectVersion,
} from '@/lib/cloudProjects';
import { projectHasLocalChanges, serializeProject } from '@/lib/cloudProjectDraftCore';
import {
  getLoadedProjectCollections, hasProjectMetadataChanges,
  mergeHydratedProjectCollections, mergeProjectMetadata, mergeProjectMetadataFields,
  mergeProjectRecordsThreeWay,
} from '@/lib/projectSync';
import {
  WAREHOUSE_REMOTE_SYNC_COLLECTIONS, hasRemoteWarehouseVersionAdvance,
  normalizeProjectCollections, type ProjectCollectionKey,
} from '@/lib/projectDataScope';

export interface RemoteCollectionRefreshContext {
  currentProject: () => Project | null;
  isBlocked: () => boolean;
  savedProjectJson: () => string | null;
  backgroundRefreshing: Map<string, Set<ProjectCollectionKey>>;
  markRemoteCollections: (projectId: string, collections: readonly ProjectCollectionKey[]) => void;
  clearRemoteCollections: (projectId: string, collections: readonly ProjectCollectionKey[]) => void;
  clearPendingRealtimeCollections: (projectId: string, collections: readonly ProjectCollectionKey[]) => void;
  hasLocalCollectionConflict: (projectId: string, collections: readonly ProjectCollectionKey[]) => boolean;
  notifyRemoteDirtyChange: () => void;
  apply: (result: {
    record: CloudProjectRecord;
    project: Project;
    confirmedBaselineJson: string;
    hasPendingLocalChanges: boolean;
  }) => void;
}

/** Read and rebase only the collections named by a remote signal. */
export async function refreshRemoteProjectCollections(
  context: RemoteCollectionRefreshContext,
  projectToRebase: Project,
  collections: readonly ProjectCollectionKey[],
  knownRemoteVersion?: CloudProjectVersion,
): Promise<Project | null> {
  const current = context.currentProject();
  if (context.isBlocked() || !current || current.id !== projectToRebase.id) return null;

  const requestedCollections = normalizeProjectCollections(collections).filter(collection =>
    collection !== 'auditLogs' || getLoadedProjectCollections(current.id).includes('auditLogs'));
  if (requestedCollections.length === 0) return null;

  let remoteVersion = knownRemoteVersion;
  try {
    remoteVersion ??= await getCloudProjectVersion(current.id) ?? undefined;
  } catch (error) {
    console.warn('Não foi possível conferir a versão remota da área alterada.', error);
    return null;
  }
  if (!remoteVersion) return null;

  const refreshing = context.backgroundRefreshing.get(current.id) ?? new Set<ProjectCollectionKey>();
  requestedCollections.forEach(collection => refreshing.add(collection));
  context.backgroundRefreshing.set(current.id, refreshing);
  context.markRemoteCollections(current.id, requestedCollections);
  try {
    let record: CloudProjectRecord;
    try {
      record = await loadCloudProjectRecord(current.id, {
        collections: requestedCollections, strict: true, deferSnapshot: true,
      });
    } catch (error) {
      console.warn('Não foi possível atualizar a área alterada em segundo plano.', error);
      return null;
    }
    if (!record) return null;

    const latest = context.currentProject();
    // An outdated response cannot replace a newly opened project or a newer version.
    if (context.isBlocked() || !latest || latest.id !== current.id
      || record.updatedAt !== remoteVersion.updatedAt) {
      discardCloudProjectRecord(record);
      return null;
    }

    const sameCollectionEdited = context.hasLocalCollectionConflict(current.id, requestedCollections);
    let savedBaseline: Project | null = null;
    const savedJson = context.savedProjectJson();
    if (savedJson) {
      try { savedBaseline = JSON.parse(savedJson) as Project; } catch { /* preserve conflict */ }
    }
    let rebasedCurrent = sameCollectionEdited
      ? savedBaseline && mergeProjectRecordsThreeWay(savedBaseline, latest, record.project, requestedCollections)
      : mergeHydratedProjectCollections(latest, record.project, requestedCollections);
    let rebasedForRetry = sameCollectionEdited
      ? savedBaseline && mergeProjectRecordsThreeWay(savedBaseline, projectToRebase, record.project, requestedCollections)
      : mergeHydratedProjectCollections(projectToRebase, record.project, requestedCollections);
    if (!rebasedCurrent || !rebasedForRetry) {
      discardCloudProjectRecord(record);
      return null;
    }
    const remoteMetadataChanged = savedBaseline && hasProjectMetadataChanges(savedBaseline, record.project);
    if (remoteMetadataChanged) {
      const currentMetadata = mergeProjectMetadataFields(savedBaseline, rebasedCurrent, record.project);
      const retryMetadata = mergeProjectMetadataFields(savedBaseline, rebasedForRetry, record.project);
      if (!currentMetadata || !retryMetadata) {
        discardCloudProjectRecord(record);
        return null;
      }
      rebasedCurrent = currentMetadata;
      rebasedForRetry = retryMetadata;
    }
    let rebasedSavedBaseline = rebasedCurrent;
    if (savedBaseline) {
      rebasedSavedBaseline = mergeHydratedProjectCollections(savedBaseline, record.project, requestedCollections);
      if (remoteMetadataChanged) rebasedSavedBaseline = mergeProjectMetadata(rebasedSavedBaseline, record.project);
    }

    const confirmedBaselineJson = serializeProject(rebasedSavedBaseline);
    confirmCloudProjectRecord(record);
    context.clearRemoteCollections(current.id, requestedCollections);
    context.clearPendingRealtimeCollections(current.id, requestedCollections);
    context.apply({
      record, project: rebasedCurrent, confirmedBaselineJson,
      hasPendingLocalChanges: projectHasLocalChanges(rebasedCurrent, confirmedBaselineJson),
    });
    return rebasedForRetry;
  } finally {
    const active = context.backgroundRefreshing.get(current.id);
    requestedCollections.forEach(collection => active?.delete(collection));
    if (active?.size === 0) context.backgroundRefreshing.delete(current.id);
    // A failed read remains dirty and can be retried without remounting the area.
    context.notifyRemoteDirtyChange();
  }
}

export async function refreshRemoteWarehouseCollections(
  context: RemoteCollectionRefreshContext,
  projectToRebase: Project,
  lastObservedWarehouseVersion: number | null,
  knownRemoteVersion?: CloudProjectVersion,
): Promise<Project | null> {
  let remoteVersion = knownRemoteVersion;
  try {
    remoteVersion ??= await getCloudProjectVersion(projectToRebase.id) ?? undefined;
  } catch (error) {
    console.warn('Não foi possível conferir a versão remota do Almoxarifado.', error);
    return null;
  }
  if (!remoteVersion || !hasRemoteWarehouseVersionAdvance(
    lastObservedWarehouseVersion, remoteVersion.warehouseVersion,
  )) return null;
  return refreshRemoteProjectCollections(context, projectToRebase, WAREHOUSE_REMOTE_SYNC_COLLECTIONS, remoteVersion);
}
