import { supabase } from '@/integrations/supabase/client';
import { Project } from '@/types/project';
import { sampleProject } from '@/data/sampleProject';
import {
  hydrateProjectFromCloud,
  stripNormalizedCollections,
  syncCollectionsToCloud,
  clearCloudSnapshot,
  setCloudSnapshot,
  buildContractImportPayload,
} from '@/lib/projectSync';
import { repairProjectAnalyticLinks } from '@/lib/analyticLinks';
import { prepareWarehouseTestReset } from '@/lib/warehouseReset';

export interface CloudProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudProjectRecord {
  project: Project;
  updatedAt: string;
  repairApplied?: boolean;
}

export class CloudProjectConflictError extends Error {
  constructor() {
    super('Cloud project was modified elsewhere');
    this.name = 'CloudProjectConflictError';
  }
}

export async function listCloudProjects(): Promise<CloudProjectMeta[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function loadCloudProject(id: string): Promise<Project | null> {
  const record = await loadCloudProjectRecord(id);
  return record?.project ?? null;
}

export async function loadCloudProjectRecord(id: string): Promise<CloudProjectRecord | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, data_json, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const proj = (data.data_json ?? {}) as unknown as Project;
  const base: Project = { ...proj, id: data.id, name: data.name };
  // Hidrata coleções normalizadas (almoxarifado, diários, apontamentos).
  const hydrated = await hydrateProjectFromCloud(base);
  const repaired = repairProjectAnalyticLinks(hydrated);
  return {
    project: repaired.project,
    updatedAt: data.updated_at,
    repairApplied: repaired.changed,
  };
}

async function getCurrentUserId(): Promise<string | undefined> {
  try {
    const { data } = await supabase.auth.getUser();
    return data.user?.id;
  } catch {
    return undefined;
  }
}

export async function upsertCloudProject(project: Project, organizationId: string, expectedUpdatedAt?: string): Promise<string> {
  const userId = await getCurrentUserId();
  // Sincroniza coleções normalizadas em paralelo e remove do payload do JSON.
  const slim = stripNormalizedCollections(project);

  if (expectedUpdatedAt) {
    const { data, error } = await supabase
      .from('projects')
      .update({
        name: slim.name,
        data_json: slim as unknown as import('@/integrations/supabase/types').Json,
      })
      .eq('id', slim.id)
      .eq('organization_id', organizationId)
      .eq('updated_at', expectedUpdatedAt)
      .select('updated_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new CloudProjectConflictError();
    await syncCollectionsToCloud(project, userId);
    return data.updated_at;
  }

  const { data: existing, error: existingError } = await supabase
    .from('projects')
    .select('id')
    .eq('id', slim.id)
    .maybeSingle();
  if (existingError) throw existingError;
  const isNewProject = !existing;
  if (isNewProject && project.contractSchemaVersion === 2) {
    const contractPayload = buildContractImportPayload(project);
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>)('create_contract_project_v2', {
      p_project_id: slim.id,
      p_organization_id: organizationId,
      p_name: slim.name,
      p_data: slim as unknown as import('@/integrations/supabase/types').Json,
      p_budget_items: contractPayload.budgetItems as unknown as import('@/integrations/supabase/types').Json,
      p_analytic_compositions: contractPayload.analyticCompositions as unknown as import('@/integrations/supabase/types').Json,
      p_chapters: contractPayload.chapters as unknown as import('@/integrations/supabase/types').Json,
      p_tasks: contractPayload.tasks as unknown as import('@/integrations/supabase/types').Json,
    });
    if (!error) {
      setCloudSnapshot(project.id, project);
      return String(data ?? '');
    }
    const missingRpc = error.code === 'PGRST202'
      || /create_contract_project_v2|schema cache|could not find the function/i.test(error.message);
    if (!missingRpc) throw error;
    console.warn('[cloudProjects] RPC V2 ainda nao publicada; usando criacao com rollback compensatorio.');
  }
  const parentPayload = {
    id: slim.id,
    organization_id: organizationId,
    name: slim.name,
    data_json: slim as unknown as import('@/integrations/supabase/types').Json,
  };
  const parentQuery = isNewProject
    ? supabase.from('projects').insert([parentPayload])
    : supabase.from('projects').upsert([parentPayload], { onConflict: 'id' });
  const { data, error } = await parentQuery.select('updated_at').single();
  if (error) throw error;
  try {
    await syncCollectionsToCloud(project, userId);
    return data.updated_at;
  } catch (syncError) {
    clearCloudSnapshot(project.id);
    if (isNewProject) {
      const rollback = await supabase
        .from('projects')
        .delete()
        .eq('id', project.id)
        .eq('organization_id', organizationId);
      if (rollback.error) {
        throw new Error(`A importacao falhou e a obra incompleta nao pode ser removida automaticamente: ${rollback.error.message}`);
      }
    }
    throw syncError;
  }
}

export async function createCloudProject(name: string, organizationId: string, base?: Partial<Project>): Promise<Project> {
  const today = new Date().toISOString().split('T')[0];
  const seed: Project = {
    id: crypto.randomUUID(),
    name,
    startDate: today,
    endDate: today,
    phases: [],
    totalBudget: 0,
    ...base,
  };
  const { error } = await supabase
    .from('projects')
    .insert([{
      id: seed.id,
      organization_id: organizationId,
      name: seed.name,
      data_json: seed as unknown as import('@/integrations/supabase/types').Json,
    }])
    .select('id')
    .single();
  if (error) throw error;
  return seed;
}

export async function renameCloudProject(id: string, newName: string, organizationId: string): Promise<Project | null> {
  const proj = await loadCloudProject(id);
  if (!proj) return null;
  const updated = { ...proj, name: newName };
  await upsertCloudProject(updated, organizationId);
  return updated;
}

export async function duplicateCloudProject(id: string, organizationId: string): Promise<Project | null> {
  const source = await supabase.from('projects').select('name').eq('id', id).maybeSingle();
  if (source.error) throw source.error;
  if (!source.data) return null;
  const newName = `${source.data.name} (cópia)`;
  const { data: newId, error } = await supabase.rpc('duplicate_project', {
    p_source_id: id,
    p_organization_id: organizationId,
    p_new_name: newName,
  });
  if (error) throw error;
  if (!newId) return null;
  return await loadCloudProject(newId as string);
}

export async function deleteCloudProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
  clearCloudSnapshot(id);
}

/** Limpa os dados de teste pelo fluxo normal de persistência do Lovable Cloud. */
export async function clearCloudWarehouseAsOwner(projectId: string, password: string): Promise<void> {
  if (!password.trim()) throw new Error('Informe a senha da sua conta.');

  const { data: currentUserData, error: currentUserError } = await supabase.auth.getUser();
  if (currentUserError || !currentUserData.user?.email) {
    throw new Error('Não foi possível identificar a conta autenticada. Entre novamente e tente de novo.');
  }

  const expectedUserId = currentUserData.user.id;
  const { data: reauthenticated, error: passwordError } = await supabase.auth.signInWithPassword({
    email: currentUserData.user.email,
    password,
  });
  if (passwordError || reauthenticated.user?.id !== expectedUserId) {
    throw new Error('Senha incorreta. O almoxarifado não foi alterado.');
  }

  const projectAccess = await supabase
    .from('projects')
    .select('organization_id')
    .eq('id', projectId)
    .maybeSingle();
  if (projectAccess.error || !projectAccess.data?.organization_id) {
    throw new Error('Não foi possível localizar a obra no Lovable Cloud.');
  }

  const membership = await supabase
    .from('organization_members')
    .select('role, status')
    .eq('organization_id', projectAccess.data.organization_id)
    .eq('user_id', expectedUserId)
    .maybeSingle();
  if (membership.error || membership.data?.role !== 'owner' || membership.data.status !== 'active') {
    throw new Error('Somente o proprietário da organização pode limpar o almoxarifado.');
  }

  // Apaga diretamente as coleções normalizadas (não depende do diff em memória).
  const tables = ['warehouse_movements', 'warehouse_requisitions', 'warehouse_custody', 'stock_movements'] as const;
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq('project_id', projectId);
    if (error) throw new Error(`Não foi possível apagar ${table}: ${error.message}`);
  }

  const current = await loadCloudProjectRecord(projectId);
  if (!current) throw new Error('Não foi possível carregar a obra antes da limpeza.');
  const previousEquipmentIds = new Set((current.project.warehouse?.equipments ?? []).map(equipment => equipment.id));
  const { project: cleared } = prepareWarehouseTestReset(current.project, {
    userId: expectedUserId,
    userEmail: currentUserData.user.email,
  });

  // Sem trava otimista: a limpeza é uma operação administrativa deliberada.
  try {
    await upsertCloudProject(cleared, projectAccess.data.organization_id);
  } catch (error) {
    throw new Error(`Não foi possível salvar a limpeza: ${error instanceof Error ? error.message : String(error)}`);
  }
  clearCloudSnapshot(projectId);

  const verified = await loadCloudProjectRecord(projectId);
  if (!verified) throw new Error('A limpeza foi salva, mas não foi possível conferir o resultado. Atualize a página.');
  const verifiedWarehouse = verified.project.warehouse;
  const historiesRemain = (verifiedWarehouse?.movements.length ?? 0) > 0
    || (verifiedWarehouse?.requisitions.length ?? 0) > 0
    || (verifiedWarehouse?.custodyTerms.length ?? 0) > 0
    || (verified.project.stockMovements?.length ?? 0) > 0;
  const verifiedEquipmentIds = new Set((verifiedWarehouse?.equipments ?? []).map(equipment => equipment.id));
  const equipmentWasLost = [...previousEquipmentIds].some(id => !verifiedEquipmentIds.has(id));

  if (equipmentWasLost) {
    throw new Error('A conferência detectou diferença no cadastro de equipamentos. A limpeza foi interrompida para revisão.');
  }
  if (historiesRemain) {
    throw new Error('Parte do histórico ainda permanece no Lovable Cloud. Tente a limpeza novamente.');
  }

  clearCloudSnapshot(projectId);
}


export async function generateUniqueCloudName(base = 'Nova obra'): Promise<string> {
  const all = await listCloudProjects();
  const names = new Set(all.map(p => p.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

export function getSampleSeed(): Partial<Project> {
  const { id: _id, name: _name, ...rest } = sampleProject;
  return rest;
}
