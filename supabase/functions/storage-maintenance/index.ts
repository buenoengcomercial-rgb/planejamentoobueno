import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

import { readCompletePages } from '../_shared/verifiedPages.ts';

const BUCKET = 'daily-report-photos';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
type StoredObject = { quarantinedAt?: string; cleanupStatus?: string; name: string; metadata?: { size?: number | string }; owner_id?: string | null };
type AttachmentRef = { path: string; optimizationVersion?: number; optimizedAt?: string };

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } }); }
function bytes(value: unknown) { return typeof value === 'number' ? value : Number(value || 0); }

function collectReferences(value: unknown, output: AttachmentRef[]) {
  if (Array.isArray(value)) { value.forEach(item => collectReferences(item, output)); return; }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.storagePath === 'string') {
    output.push({ path: record.storagePath, optimizationVersion: typeof record.optimizationVersion === 'number' ? record.optimizationVersion : undefined, optimizedAt: typeof record.optimizedAt === 'string' ? record.optimizedAt : undefined });
  }
  Object.values(record).forEach(item => collectReferences(item, output));
}

async function audit(admin: SupabaseClient, organizationId: string, callerId: string) {
  const activeProjects = await readCompletePages<{id:string; name:string; data_json:unknown}>((after,head) => {
    const q = admin.from('projects').select('id,name,data_json',{count:'exact',head}).eq('organization_id',organizationId).order('id').limit(500);
    return after ? q.gt('id',after) : q;
  });
  const projectIds = activeProjects.map(project => project.id);
  const projectMap = new Map(activeProjects.map(project => [project.id, project]));
  const members = await readCompletePages<{id:string; user_id:string}>((after,head) => {
    const q = admin.from('organization_members').select('id,user_id',{count:'exact',head}).eq('organization_id',organizationId).order('id').limit(500);
    return after ? q.gt('id',after) : q;
  });
  const memberIds = new Set(members.map(member => member.user_id));
  const references: AttachmentRef[] = [];
  activeProjects.forEach(project => collectReferences(project.data_json, references));
  // Chunk project IDs to avoid oversized URLs; every table has counted keyset pages.
  for (let offset=0; offset<projectIds.length; offset+=50) {
    const ids=projectIds.slice(offset,offset+50);
    for (const table of ['daily_reports','warehouse_requisitions','warehouse_custody','warehouse_movements','audit_logs']) {
      const rows=await readCompletePages<{id:string;data:unknown}>((after,head)=>{
        const q=admin.from(table).select('id,data',{count:'exact',head}).in('project_id',ids).order('id').limit(500);
        return after?q.gt('id',after):q;
      });
      rows.forEach(row=>collectReferences(row.data,references));
    }
  }
  const referenceMap = new Map<string, AttachmentRef>();
  references.forEach(reference => referenceMap.set(reference.path, reference));
  const { data: rows, error: storageError } = await admin.rpc('storage_maintenance_objects', { p_organization_id: organizationId });
  if (storageError) throw storageError;
  const visible = ((rows ?? []) as Array<{ name: string; size: number | string | null; owner_id: string | null; quarantinedAt?:string; cleanupStatus?:string }>)
    .map(row => ({ name: row.name, metadata: { size: bytes(row.size) }, owner_id: row.owner_id, quarantinedAt:row.quarantinedAt, cleanupStatus:row.cleanupStatus }) as StoredObject)
    .filter(object => {
      const prefix = object.name.split('/')[0];
      return projectMap.has(prefix) || (!!object.owner_id && memberIds.has(object.owner_id));
    });

  const groups = new Map<string, { projectId: string; projectName: string; state: 'ativa' | 'obra_excluida'; files: number; bytes: number; referenced: number; pending: number; optimized: number; orphans: Array<{ path: string; bytes: number; reason: string; quarantinedAt?:string; cleanupStatus?:string }> }>();
  for (const object of visible) {
    const prefix = object.name.split('/')[0];
    const project = projectMap.get(prefix);
    const key = project ? prefix : `deleted:${prefix}`;
    const group = groups.get(key) ?? { projectId: prefix, projectName: project?.name ?? 'Obra excluída sem cadastro', state: project ? 'ativa' : 'obra_excluida', files: 0, bytes: 0, referenced: 0, pending: 0, optimized: 0, orphans: [] };
    const size = bytes(object.metadata?.size);
    group.files += 1; group.bytes += size;
    const reference = referenceMap.get(object.name);
    if (!reference) group.orphans.push({ path: object.name, bytes: size, reason: project ? 'candidato; servidor ainda confere históricos e backups' : 'obra não confirmada; exclusão bloqueada', quarantinedAt:object.quarantinedAt, cleanupStatus:object.cleanupStatus });
    else {
      group.referenced += 1;
      if (!reference.optimizedAt || (reference.optimizationVersion ?? 1) < 2) group.pending += 1;
      else group.optimized += 1;
    }
    groups.set(key, group);
  }
  const report = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  const orphanPaths = report.flatMap(group => group.orphans.map(orphan => orphan.path));
  return { report, orphanPaths, totalFiles: visible.length, totalBytes: visible.reduce((sum, object) => sum + bytes(object.metadata?.size), 0), activeProjectId: projectIds[0] ?? null, callerId };
}

async function log(admin: SupabaseClient, projectId: string | null, callerId: string, action: string, data: Record<string, unknown>) {
  if (!projectId) return;
  const { error } = await admin.from('audit_logs').insert({ id: crypto.randomUUID(), project_id: projectId, entity_type: 'storage_maintenance', entity_id: 'daily-report-photos', action, occurred_at: new Date().toISOString(), user_id: callerId, data });
  if (error) throw new Error(`Registro de manutenção não confirmado: ${error.message}`);
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const admin = createClient(url, serviceKey);
    const { data: auth, error: authError } = await userClient.auth.getUser();
    if (authError || !auth.user) return json({ error: 'Não autenticado.' }, 401);
    const body = await req.json().catch(() => ({}));
    if (!['audit', 'quarantine_orphans', 'delete_orphans', 'record_optimization'].includes(body.action)) return json({error:'Ação inválida.'},400);
    const organizationId = String(body.organizationId ?? '');
    if (!organizationId) return json({ error: 'Organização não informada.' }, 400);
    const { data: owner } = await admin.from('organization_members').select('id').eq('organization_id', organizationId).eq('user_id', auth.user.id).eq('status', 'active').eq('role', 'owner').maybeSingle();
    if (!owner) return json({ error: 'Somente o Proprietário pode manter o Storage.' }, 403);
    const inventory = await audit(admin, organizationId, auth.user.id);
    if (body.action === 'delete_orphans' || body.action === 'quarantine_orphans') {
      const requested: string[] = Array.isArray(body.paths) ? body.paths.filter((path: unknown): path is string => typeof path === 'string') : [];
      const allowed = new Set(inventory.orphanPaths);
      const paths = requested.filter(path => allowed.has(path));
      if (!paths.length) return json({ error: 'Nenhum arquivo órfão elegível foi encontrado. Atualize a auditoria.' }, 409);
      const action=body.action==='quarantine_orphans'?'quarantine':'delete';
      // One server claim per file: complete reference scan + serialized writer guard.
      // Never fall back to the old inventory-only deletion if the migration is absent.
      const completed:string[]=[];
      for (const path of [...new Set(paths)]) {
        const { data:claim, error:claimError }=await admin.rpc('prepare_storage_cleanup',{
          p_organization_id:organizationId,p_actor_id:auth.user.id,p_path:path,p_action:action,
        });
        if(claimError) throw claimError;
        if(action==='quarantine' && claim?.status!=='quarantined') throw new Error('Quarentena não confirmada pelo servidor.');
        if(action==='delete' && claim?.status!=='already_removed') {
          if(claim?.status!=='deleting') throw new Error('Exclusão não confirmada pelo servidor.');
          const {error}=await admin.storage.from(BUCKET).remove([path]);
          if(error) throw error; // Keep claim durable: a late response cannot race a new link.
        }
        if(action==='delete') await log(admin, path.split('/')[0], auth.user.id, 'storage_orphans_deleted', {count:1,paths:[path]});
        completed.push(path);
      }
      return json({ deleted:action==='delete'?completed.length:0, quarantined:action==='quarantine'?completed.length:0, paths:completed });
    }
    if (body.action === 'record_optimization') {
      const projectId = String(body.projectId ?? '');
      const project = inventory.report.find(group => group.projectId === projectId && group.state === 'ativa');
      if (!project) return json({ error: 'Obra inválida para registrar a otimização.' }, 400);
      await log(admin, projectId, auth.user.id, 'storage_optimized', { count: Number(body.count ?? 0), savedBytes: Number(body.savedBytes ?? 0) });
      return json({ ok: true });
    }
    return json({ generatedAt: new Date().toISOString(), totalFiles: inventory.totalFiles, totalBytes: inventory.totalBytes, groups: inventory.report });
  } catch (error) {
    return json({ error: error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Falha na manutenção do Storage.' }, 500);
  }
});
