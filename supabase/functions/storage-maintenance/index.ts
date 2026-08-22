import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const BUCKET = 'daily-report-photos';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
type StoredObject = { name: string; metadata?: { size?: number | string }; owner_id?: string | null };
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

async function audit(admin: ReturnType<typeof createClient>, organizationId: string, callerId: string) {
  const { data: projects, error: projectError } = await admin.from('projects').select('id,name,data_json').eq('organization_id', organizationId);
  if (projectError) throw projectError;
  const activeProjects = projects ?? [];
  const projectIds = activeProjects.map(project => project.id);
  const projectMap = new Map(activeProjects.map(project => [project.id, project]));
  const { data: members, error: memberError } = await admin.from('organization_members').select('user_id').eq('organization_id', organizationId);
  if (memberError) throw memberError;
  const memberIds = new Set((members ?? []).map(member => member.user_id));
  const references: AttachmentRef[] = [];
  activeProjects.forEach(project => collectReferences(project.data_json, references));
  if (projectIds.length) {
    const [daily, requisitions, custody] = await Promise.all([
      admin.from('daily_reports').select('data').in('project_id', projectIds),
      admin.from('warehouse_requisitions').select('data').in('project_id', projectIds),
      admin.from('warehouse_custody').select('data').in('project_id', projectIds),
    ]);
    if (daily.error) throw daily.error;
    if (requisitions.error) throw requisitions.error;
    if (custody.error) throw custody.error;
    (daily.data ?? []).forEach(row => collectReferences(row.data, references));
    (requisitions.data ?? []).forEach(row => collectReferences(row.data, references));
    (custody.data ?? []).forEach(row => collectReferences(row.data, references));
  }
  const referenceMap = new Map<string, AttachmentRef>();
  references.forEach(reference => referenceMap.set(reference.path, reference));
  const { data: rows, error: storageError } = await admin.schema('storage').from('objects').select('name,metadata,owner_id').eq('bucket_id', BUCKET);
  if (storageError) throw storageError;
  const visible = ((rows ?? []) as StoredObject[]).filter(object => {
    const prefix = object.name.split('/')[0];
    return projectMap.has(prefix) || (!!object.owner_id && memberIds.has(object.owner_id));
  });
  const groups = new Map<string, { projectId: string; projectName: string; state: 'ativa' | 'obra_excluida'; files: number; bytes: number; referenced: number; pending: number; optimized: number; orphans: Array<{ path: string; bytes: number; reason: string }> }>();
  for (const object of visible) {
    const prefix = object.name.split('/')[0];
    const project = projectMap.get(prefix);
    const key = project ? prefix : `deleted:${prefix}`;
    const group = groups.get(key) ?? { projectId: prefix, projectName: project?.name ?? 'Obra excluída sem cadastro', state: project ? 'ativa' : 'obra_excluida', files: 0, bytes: 0, referenced: 0, pending: 0, optimized: 0, orphans: [] };
    const size = bytes(object.metadata?.size);
    group.files += 1; group.bytes += size;
    const reference = referenceMap.get(object.name);
    if (!reference) group.orphans.push({ path: object.name, bytes: size, reason: project ? 'sem vínculo em registro ativo' : 'pasta de obra excluída' });
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

async function log(admin: ReturnType<typeof createClient>, projectId: string | null, callerId: string, action: string, data: Record<string, unknown>) {
  if (!projectId) return;
  await admin.from('audit_logs').insert({ id: crypto.randomUUID(), project_id: projectId, entity_type: 'storage_maintenance', entity_id: 'daily-report-photos', action, occurred_at: new Date().toISOString(), user_id: callerId, data });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
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
    const organizationId = String(body.organizationId ?? '');
    if (!organizationId) return json({ error: 'Organização não informada.' }, 400);
    const { data: owner } = await admin.from('organization_members').select('id').eq('organization_id', organizationId).eq('user_id', auth.user.id).eq('status', 'active').eq('role', 'owner').maybeSingle();
    if (!owner) return json({ error: 'Somente o Proprietário pode manter o Storage.' }, 403);
    const inventory = await audit(admin, organizationId, auth.user.id);
    if (body.action === 'delete_orphans') {
      const requested = Array.isArray(body.paths) ? body.paths.filter((path): path is string => typeof path === 'string') : [];
      const allowed = new Set(inventory.orphanPaths);
      const paths = requested.filter(path => allowed.has(path));
      if (!paths.length) return json({ error: 'Nenhum arquivo órfão elegível foi encontrado. Atualize a auditoria.' }, 409);
      for (let index = 0; index < paths.length; index += 100) {
        const { error } = await admin.storage.from(BUCKET).remove(paths.slice(index, index + 100));
        if (error) throw error;
      }
      await log(admin, inventory.activeProjectId, auth.user.id, 'storage_orphans_deleted', { count: paths.length, paths });
      return json({ deleted: paths.length, paths });
    }
    if (body.action === 'record_optimization') {
      const projectId = String(body.projectId ?? '');
      const project = inventory.report.find(group => group.projectId === projectId && group.state === 'ativa');
      if (!project) return json({ error: 'Obra inválida para registrar a otimização.' }, 400);
      await log(admin, projectId, auth.user.id, 'storage_optimized', { count: Number(body.count ?? 0), savedBytes: Number(body.savedBytes ?? 0) });
      return json({ ok: true });
    }
    await log(admin, inventory.activeProjectId, auth.user.id, 'storage_audited', { totalFiles: inventory.totalFiles, totalBytes: inventory.totalBytes, groups: inventory.report.length });
    return json({ generatedAt: new Date().toISOString(), totalFiles: inventory.totalFiles, totalBytes: inventory.totalBytes, groups: inventory.report });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Falha na manutenção do Storage.' }, 500);
  }
});
