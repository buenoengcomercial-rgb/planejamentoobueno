import { supabase } from '@/integrations/supabase/client';
import { withReadDeadline } from '@/lib/readDeadline';
import type { ProjectCollectionKey } from '@/lib/projectDataScope';
import type { Project, WarehouseState } from '@/types/project';

const WAREHOUSE_COLLECTIONS = new Set<ProjectCollectionKey>([
  'warehouseMovements', 'warehouseRequisitions', 'warehouseCustody', 'stockMovements',
]);

export interface WarehouseProjectStateRead {
  warehouse: WarehouseState;
  version: number;
  updatedAt: string;
}

export async function readVersionedProjectRow(projectId: string) {
  const projected = await withReadDeadline(supabase.from('projects')
    .select('id, updated_at, warehouse_version, warehouse_updated_at, warehouse_project_state(warehouse_version, warehouse_updated_at)')
    .eq('id', projectId).maybeSingle());
  // A missing relationship is expected only before the projection migration.
  if (projected.error?.code === 'PGRST200'
    && /warehouse_project_state/i.test(projected.error.message)) {
    return withReadDeadline(supabase.from('projects')
      .select('id, updated_at, warehouse_version, warehouse_updated_at')
      .eq('id', projectId).maybeSingle());
  }
  if (projected.data?.warehouse_project_state) {
    const { warehouse_project_state: state, ...parent } = projected.data;
    return { ...projected, data: { ...parent, ...state } };
  }
  return projected;
}

/** Lê a projeção nas áreas do estoque e na carga completa de uma obra com estoque. */
export function needsWarehouseProjectState(collections?: readonly ProjectCollectionKey[]): boolean {
  return collections?.some(collection => WAREHOUSE_COLLECTIONS.has(collection)) ?? false;
}

/**
 * Durante a transição, o JSON da obra continua sendo a fonte antiga. Ambientes
 * que ainda não receberam a tabela seguem lendo o JSON; outras falhas de rede
 * são propagadas para que um estado incompleto não pareça confirmado.
 */
export async function readWarehouseProjectState(
  project: Project,
): Promise<WarehouseProjectStateRead | null> {
  const { data, error } = await withReadDeadline(supabase
    .from('warehouse_project_state')
    .select('state_json, warehouse_version, warehouse_updated_at')
    .eq('project_id', project.id)
    .maybeSingle());
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return null;
    throw error;
  }
  if (!data) {
    throw new Error('Falta a projeção do Almoxarifado para esta obra. A edição foi preservada.');
  }
  if (!data.state_json || typeof data.state_json !== 'object' || Array.isArray(data.state_json)
    || !Number.isSafeInteger(data.warehouse_version) || data.warehouse_version < 0) {
    throw new Error('Estado do Almoxarifado inválido na nuvem. A edição foi preservada.');
  }
  return {
    warehouse: {
      locations: [], items: [], equipments: [], equipmentGroups: [],
      ...data.state_json,
      // As coleções operacionais continuam vindo das tabelas próprias.
      movements: project.warehouse?.movements ?? [],
      requisitions: project.warehouse?.requisitions ?? [],
      custodyTerms: project.warehouse?.custodyTerms ?? [],
    } as WarehouseState,
    version: data.warehouse_version,
    updatedAt: data.warehouse_updated_at,
  };
}
