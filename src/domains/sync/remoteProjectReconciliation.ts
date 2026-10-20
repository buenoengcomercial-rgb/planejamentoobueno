import type { Project } from '@/types/project';
import { projectHasLocalChanges, serializeProject } from '@/lib/cloudProjectDraftCore';
import { mergeHydratedProjectCollections, mergeProjectMetadata } from '@/lib/projectSync';
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
}

/** Update only the requested domain in both the visible project and save baseline. */
export function reconcileRemoteProjectSnapshot({
  local, remote, savedProjectJson, collections, metadataOnly = false,
}: ReconcileRemoteProjectSnapshotOptions) {
  const merge = (base: Project) => metadataOnly
    ? mergeProjectMetadata(base, remote)
    : mergeHydratedProjectCollections(base, remote, collections);
  const project = merge(local);
  let confirmedBaseline = project;
  let baselineKnown = false;
  if (savedProjectJson) {
    try {
      confirmedBaseline = merge(JSON.parse(savedProjectJson) as Project);
      baselineKnown = true;
    } catch {
      // A missing or invalid baseline cannot confirm a local edit.
    }
  }
  const confirmedBaselineJson = serializeProject(confirmedBaseline);
  return {
    project,
    confirmedBaselineJson,
    hasPendingLocalChanges: !baselineKnown || projectHasLocalChanges(project, confirmedBaselineJson),
  };
}
