import type { Project } from '@/types/project';
import { projectHasLocalChanges, serializeProject } from '@/lib/cloudProjectDraftCore';
import { mergeHydratedProjectCollections, mergeProjectMetadata, mergeProjectMetadataFields, mergeProjectRecordsThreeWay } from '@/lib/projectSync';
import {
  normalizeProjectCollections,
  projectCollectionsForRealtimeTable,
  type ProjectCollectionKey,
} from '@/lib/projectDataScope';

export function planRealtimeProjectRefresh(
  sources: readonly string[],
  activeCollections: readonly ProjectCollectionKey[],
) {
  const affectedCollections = normalizeProjectCollections(
    sources.flatMap(source => projectCollectionsForRealtimeTable(source)),
  );
  const metadataOnly = sources.includes('projects') && affectedCollections.length === 0;
  const requestCollections = affectedCollections.length > 0
    ? affectedCollections
    : metadataOnly ? [] : [...activeCollections];
  return {
    affectedCollections,
    metadataOnly,
    requestCollections,
    activeCollections: requestCollections.filter(collection => activeCollections.includes(collection)),
    inactiveCollections: requestCollections.filter(collection => !activeCollections.includes(collection)),
  };
}

interface ReconcileRemoteProjectSnapshotOptions {
  local: Project;
  remote: Project;
  savedProjectJson: string | null;
  collections: readonly ProjectCollectionKey[];
  metadataOnly?: boolean;
  includeMetadata?: boolean;
}

/** Rebase only hydrated collections against the last confirmed snapshot. */
export function reconcileRemoteProjectSnapshot({
  local, remote, savedProjectJson, collections, metadataOnly = false, includeMetadata = false,
}: ReconcileRemoteProjectSnapshotOptions) {
  let baseline: Project | null = null;
  try {
    if (savedProjectJson) baseline = JSON.parse(savedProjectJson) as Project;
  } catch { /* An unknown ancestor cannot prove that a merge is safe. */ }
  if (!baseline || baseline.id !== local.id || remote.id !== local.id) {
    return {
      project: local,
      confirmedBaselineJson: savedProjectJson,
      hasPendingLocalChanges: true,
      conflict: true,
    };
  }
  const metadataMerged = metadataOnly || includeMetadata
    ? mergeProjectMetadataFields(baseline, local, remote)
    : local;
  const project = metadataOnly || !metadataMerged
    ? metadataMerged
    : mergeProjectRecordsThreeWay(baseline, metadataMerged, remote, collections);
  if (!project) {
    return {
      project: local,
      confirmedBaselineJson: savedProjectJson,
      hasPendingLocalChanges: true,
      conflict: true,
    };
  }
  const confirmedBaseline = metadataOnly
    ? mergeProjectMetadata(baseline, remote)
    : mergeHydratedProjectCollections(includeMetadata ? mergeProjectMetadata(baseline, remote) : baseline, remote, collections);
  const confirmedBaselineJson = serializeProject(confirmedBaseline);
  return {
    project,
    confirmedBaselineJson,
    hasPendingLocalChanges: projectHasLocalChanges(project, confirmedBaselineJson),
    conflict: false,
  };
}

/** A stored draft can be rebased only when its original cloud snapshot is available. */
export function rebaseStoredProjectDraft(
  baseline: Project,
  local: Project,
  remote: Project,
  collections: readonly ProjectCollectionKey[],
): Project | null {
  if (baseline.id !== local.id || baseline.id !== remote.id) return null;
  const metadata = mergeProjectMetadataFields(baseline, local, remote);
  return metadata && mergeProjectRecordsThreeWay(baseline, metadata, remote, collections);
}
