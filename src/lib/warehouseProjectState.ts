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

/** Lê a projeção somente nos fluxos que pedem coleções do Almoxarifado. */
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
  if (!data) return null;
  if (!data.state_json || typeof data.state_json !== 'object' || Array.isArray(data.state_json)
    || !Number.isSafeInteger(data.warehouse_version) || data.warehouse_version < 0) {
    throw new Error('Estado do Almoxarifado inválido na nuvem. A edição foi preservada.');
  }
  return {
    warehouse: {
      ...(project.warehouse ?? {
        locations: [], items: [], movements: [], requisitions: [], equipments: [], equipmentGroups: [], custodyTerms: [],
      }),
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
