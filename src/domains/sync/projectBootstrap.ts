import type { AppView, Project } from '@/types/project';
import { canAccessAppView } from '@/lib/organizations';
import {
  createCloudProject,
  discardCloudProjectRecord,
  generateUniqueCloudName,
  getSampleSeed,
  loadStableCloudProjectRecord,
  type CloudProjectMeta,
  type CloudProjectRecord,
} from '@/lib/cloudProjects';
import { readStoredProjectDraft } from '@/lib/cloudProjectDraftCore';
import { preloadIndexedDbProjectDraft } from '@/lib/cloudDraftIndexedDb';
import { readAppUiSession } from '@/lib/appUiSession';
import { withReadDeadline } from '@/lib/readDeadline';
import { supabase } from '@/integrations/supabase/client';
import {
  PROJECT_COLLECTION_KEYS,
  projectCollectionsForView,
  readWarehouseTab,
  type ProjectCollectionKey,
  type WarehouseTab,
} from '@/lib/projectDataScope';

export function includePendingDraftCollections(
  projectId: string,
  requested: readonly ProjectCollectionKey[],
): ProjectCollectionKey[] {
  const stored = readStoredProjectDraft(projectId);
  if (!stored?.loadedCollections?.length) return [...requested];
  const pending = PROJECT_COLLECTION_KEYS.filter(key => key !== 'auditLogs' && stored.loadedCollections?.includes(key));
  return [...new Set([...requested, ...pending])];
}

export function selectInitialProject(
  list: readonly CloudProjectMeta[],
  routeProjectId: string | undefined,
  rememberedProjectId: string | undefined,
  initialView: AppView,
  role: Parameters<typeof canAccessAppView>[0] | undefined,
  fallbackView: AppView,
  canViewWarehousePanel: boolean,
): { projectId: string; view: AppView; warehouseTab: WarehouseTab } {
  const projectId = [routeProjectId, rememberedProjectId, list[0]?.id]
    .find(id => !!id && list.some(projectMeta => projectMeta.id === id));
  if (!projectId) throw new Error('Não há obras disponíveis para sua conta. Confira com a administração da empresa.');
  return {
    projectId,
    view: role && !canAccessAppView(role, initialView) ? fallbackView : initialView,
    warehouseTab: readWarehouseTab(projectId, canViewWarehousePanel, role === 'owner'),
  };
}

type BootstrapOptions = {
  orgId: string;
  creator: boolean;
  role: Parameters<typeof canAccessAppView>[0] | undefined;
  routeProjectId: string | undefined;
  initialView: AppView;
  fallbackView: AppView;
  canViewWarehousePanel: boolean;
  refreshCloudList: () => Promise<CloudProjectMeta[]>;
  isCancelled: () => boolean;
  onAreaSelected: (view: AppView, warehouseTab: WarehouseTab) => void;
};

type BootstrapResult =
  | { kind: 'created'; project: Project; updatedAt: string | null }
  | { kind: 'opened'; record: CloudProjectRecord; independentMeasurement: boolean };

export async function loadInitialProject(options: BootstrapOptions): Promise<BootstrapResult | null> {
  let list = await withReadDeadline(options.refreshCloudList());
  if (options.isCancelled()) return null;
  if (list.length === 0 && options.creator) {
    const name = await generateUniqueCloudName('Minha primeira obra');
    const project = await createCloudProject(name, options.orgId, getSampleSeed());
    if (options.isCancelled()) return null;
    list = await options.refreshCloudList();
    return { kind: 'created', project, updatedAt: list.find(item => item.id === project.id)?.updatedAt ?? null };
  }
  if (list.length === 0) throw new Error('Não há obras disponíveis para sua conta. Confira com a administração da empresa.');

  const selection = selectInitialProject(
    list, options.routeProjectId, readAppUiSession()?.projectId,
    options.initialView, options.role, options.fallbackView, options.canViewWarehousePanel,
  );
  await withReadDeadline(preloadIndexedDbProjectDraft(selection.projectId));
  if (options.isCancelled()) return null;
  options.onAreaSelected(selection.view, selection.warehouseTab);

  // A Medição independente tem revisão própria. Sua confirmação precede a
  // escolha das coleções que serão carregadas no registro geral da obra.
  let independentMeasurement = false;
  if (selection.view === 'measurement') {
    const { data, error } = await supabase.from('measurement_workspaces' as never)
      .select('project_id').eq('project_id', selection.projectId).maybeSingle();
    if (options.isCancelled()) return null;
    independentMeasurement = !error && !!data;
  }
  const collections = includePendingDraftCollections(
    selection.projectId,
    projectCollectionsForView(selection.view, selection.warehouseTab, independentMeasurement),
  );
  const record = await withReadDeadline(loadStableCloudProjectRecord(selection.projectId, {
    collections, strict: true, deferSnapshot: true,
  }));
  if (options.isCancelled()) {
    if (record) discardCloudProjectRecord(record);
    return null;
  }
  if (!record) throw new Error('A obra não foi encontrada. Tente novamente ou confira o acesso com a administração.');
  return { kind: 'opened', record, independentMeasurement };
}
