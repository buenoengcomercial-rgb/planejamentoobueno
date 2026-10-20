import type { Project } from '@/types/project';
import { getCloudProjectVersion } from '@/lib/cloudProjects';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { repairProjectAnalyticLinks } from '@/lib/analyticLinks';
import {
  confirmHydratedProjectCollections,
  discardHydratedProjectCollections,
  getHydratedProjectCollections,
  getLoadedProjectCollections,
  getMissingProjectCollections,
  hydrateProjectFromCloud,
  mergeHydratedProjectCollections,
} from '@/lib/projectSync';
import { normalizeProjectCollections, type ProjectCollectionKey } from '@/lib/projectDataScope';

const PRODUCTION_COLLECTIONS: readonly ProjectCollectionKey[] = ['taskDailyLogs', 'eapChapters', 'tasks'];

export function planAreaHydration(
  projectId: string | null,
  required: readonly ProjectCollectionKey[],
  remoteDirty?: ReadonlySet<ProjectCollectionKey>,
  backgroundRefreshing?: ReadonlySet<ProjectCollectionKey>,
  localDirty?: ReadonlySet<ProjectCollectionKey>,
  missingOverride?: readonly ProjectCollectionKey[],
) {
  const missing = missingOverride ?? (projectId ? getMissingProjectCollections(projectId, required) : required);
  const stale = projectId ? required.filter(collection => remoteDirty?.has(collection)) : [];
  const productionDirty = PRODUCTION_COLLECTIONS.some(collection => localDirty?.has(collection));
  const collections = normalizeProjectCollections([...missing, ...stale]).filter(collection =>
    !backgroundRefreshing?.has(collection)
    && !localDirty?.has(collection)
    && !(productionDirty && PRODUCTION_COLLECTIONS.includes(collection)));
  return { missing, stale, collections, ready: !!projectId && missing.length === 0 };
}

type HydrationOptions = {
  projectId: string;
  collections: readonly ProjectCollectionKey[];
  source: Project;
  currentProject: () => Project | null;
  savedProjectJson: () => string | null;
  isCurrent: () => boolean;
};

export type AreaHydrationResult = {
  hydrated: Project;
  project: Project;
  savedProjectJson: string;
  repaired: boolean;
};

export async function hydrateAreaCollections(options: HydrationOptions): Promise<AreaHydrationResult | null> {
  const { projectId, collections, source } = options;
  const beforeLoad = await getCloudProjectVersion(projectId);
  if (!beforeLoad) throw new Error('A versão da obra não pôde ser conferida.');
  const hydrated = await hydrateProjectFromCloud(source, { collections: [...collections], strict: true });
  try {
    const afterLoad = await getCloudProjectVersion(projectId);
    if (!afterLoad || afterLoad.updatedAt !== beforeLoad.updatedAt) {
      throw new Error('A obra mudou durante o carregamento. Atualize a área antes de editar.');
    }
    if (!options.isCurrent()) {
      discardHydratedProjectCollections(hydrated);
      return null;
    }
    const latest = options.currentProject();
    if (!latest || latest.id !== projectId) {
      discardHydratedProjectCollections(hydrated);
      return null;
    }
    const cloudMerged = mergeHydratedProjectCollections(latest, hydrated, collections);
    let savedCloudMerged = cloudMerged;
    const savedJson = options.savedProjectJson();
    if (savedJson) {
      try {
        savedCloudMerged = mergeHydratedProjectCollections(JSON.parse(savedJson) as Project, hydrated, collections);
      } catch {
        savedCloudMerged = cloudMerged;
      }
    }

    // O reparo só pode usar as três coleções completas, inclusive quando a
    // última delas chega ao abrir outra área.
    const loaded = new Set([
      ...getLoadedProjectCollections(projectId),
      ...getHydratedProjectCollections(hydrated),
    ]);
    const canRepairAnalyticLinks = loaded.has('budgetItems')
      && loaded.has('analyticCompositions')
      && loaded.has('additives');
    const repair = canRepairAnalyticLinks
      ? repairProjectAnalyticLinks(cloudMerged)
      : { project: cloudMerged, changed: false };
    return {
      hydrated,
      project: repair.project,
      savedProjectJson: serializeProject(savedCloudMerged),
      repaired: repair.changed,
    };
  } catch (error) {
    discardHydratedProjectCollections(hydrated);
    throw error;
  }
}

export function confirmAreaHydration(result: AreaHydrationResult): void {
  confirmHydratedProjectCollections(result.hydrated);
}
