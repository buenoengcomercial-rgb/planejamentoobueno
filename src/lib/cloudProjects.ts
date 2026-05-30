import { supabase } from '@/integrations/supabase/client';
import { Project } from '@/types/project';
import { sampleProject } from '@/data/sampleProject';
import {
  hydrateProjectFromCloud,
  stripNormalizedCollections,
  syncCollectionsToCloud,
  setCloudSnapshot,
  clearCloudSnapshot,
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
  return {
    project: { ...proj, id: data.id, name: data.name },
    updatedAt: data.updated_at,
  };
}

export async function upsertCloudProject(project: Project, organizationId: string, expectedUpdatedAt?: string): Promise<string> {
  if (expectedUpdatedAt) {
    const { data, error } = await supabase
      .from('projects')
      .update({
        name: project.name,
        data_json: project as unknown as import('@/integrations/supabase/types').Json,
      })
      .eq('id', project.id)
      .eq('organization_id', organizationId)
      .eq('updated_at', expectedUpdatedAt)
      .select('updated_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new CloudProjectConflictError();
    return data.updated_at;
  }

  const { data, error } = await supabase
    .from('projects')
    .upsert([{
      id: project.id,
      organization_id: organizationId,
      name: project.name,
      data_json: project as unknown as import('@/integrations/supabase/types').Json,
    }], { onConflict: 'id' })
    .select('updated_at')
    .single();
  if (error) throw error;
  return data.updated_at;
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
  const proj = await loadCloudProject(id);
  if (!proj) return null;
  const newId = crypto.randomUUID();
  const copy: Project = { ...JSON.parse(JSON.stringify(proj)), id: newId, name: `${proj.name} (cópia)` };
  const { error } = await supabase.from('projects').insert([{
    id: newId,
    organization_id: organizationId,
    name: copy.name,
    data_json: copy as unknown as import('@/integrations/supabase/types').Json,
  }]);
  if (error) throw error;
  return copy;
}

export async function deleteCloudProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
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
