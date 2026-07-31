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

export interface CloudProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudProjectRecord {
  project: Project;
  updatedAt: string;
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
  return {
    project: hydrated,
    updatedAt: data.updated_at,
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
    const { data, error } = await supabase.rpc('create_contract_project_v2', {
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
      return data;
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
