import { supabase } from '@/integrations/supabase/client';
import type { Database, Json } from '@/integrations/supabase/types';
import type { TakeoffPlan } from './planTakeoff';

export interface CloudTakeoffScope { organizationId: string; userId: string; projectId: string }
type PlanRow = Database['public']['Tables']['takeoff_plans']['Row'];
export const TAKEOFF_BUCKET = 'plan-takeoff';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function cloudTakeoffScope(key: string): CloudTakeoffScope | null {
  try {
    const parts: unknown = JSON.parse(key);
    if (Array.isArray(parts) && parts.length === 3 && parts.every(part => typeof part === 'string' && uuid.test(part))) {
      return { organizationId: parts[0], userId: parts[1], projectId: parts[2] };
    }
  } catch { /* Chaves antigas de testes locais nao usam o escopo da nuvem. */ }
  return null;
}

function cloudError(error: { code?: string; message: string }, operation: string): Error {
  if (['42P01', 'PGRST205', '404'].includes(error.code ?? '')) {
    return new Error('O armazenamento de plantas na nuvem ainda não foi instalado nesta obra. Sua cópia local foi preservada.');
  }
  return new Error(`${operation}: ${error.message}`);
}

export async function readCloudPlanRows(scope: CloudTakeoffScope): Promise<PlanRow[]> {
  const { data, error } = await supabase.from('takeoff_plans').select('*').eq('project_id', scope.projectId).order('created_at');
  if (error) throw cloudError(error, 'Não foi possível consultar as plantas na nuvem');
  return data ?? [];
}

export async function cloudRowToPlan(row: PlanRow, cached?: TakeoffPlan): Promise<TakeoffPlan> {
  let file = cached?.id === row.id && (cached.storagePath === row.file_path || !cached.storagePath && !cached.cloudRevision)
    ? cached.file : undefined;
  if (!file) {
    const { data, error } = await supabase.storage.from(TAKEOFF_BUCKET).download(row.file_path);
    if (error || !data) throw cloudError(error ?? { message: 'Arquivo indisponível.' }, `Não foi possível abrir ${row.name}`);
    file = data;
  }
  return {
    id: row.id, name: row.name, floor: row.floor, kind: row.kind as TakeoffPlan['kind'], file,
    chapterId: row.chapter_id ?? undefined, building: row.building ?? undefined,
    scales: row.scales && typeof row.scales === 'object' && !Array.isArray(row.scales)
      ? row.scales as Record<number, number> : {},
    measures: Array.isArray(row.measures) ? row.measures as unknown as TakeoffPlan['measures'] : [],
    storagePath: row.file_path, cloudRevision: row.revision,
  };
}

function planFields(plan: TakeoffPlan) {
  return {
    chapter_id: plan.chapterId ?? null,
    building: plan.building ?? null,
    name: plan.name,
    floor: plan.floor,
    kind: plan.kind,
    scales: plan.scales as Json,
    measures: plan.measures as unknown as Json,
  };
}

export async function insertCloudPlan(scope: CloudTakeoffScope, plan: TakeoffPlan): Promise<void> {
  const extension = plan.kind === 'image' ? (plan.name.split('.').pop()?.toLowerCase() || 'png') : plan.kind;
  const path = `${scope.projectId}/${plan.id}/${crypto.randomUUID()}.${extension}`;
  const { error: uploadError } = await supabase.storage.from(TAKEOFF_BUCKET).upload(path, plan.file, {
    contentType: plan.file.type || 'application/octet-stream', upsert: false,
  });
  if (uploadError) throw cloudError(uploadError, `Não foi possível enviar ${plan.name}`);
  const { data, error } = await supabase.from('takeoff_plans').insert({
    id: plan.id, project_id: scope.projectId, file_path: path, ...planFields(plan),
  }).select('revision').single();
  if (error || !data) throw cloudError(error ?? { message: 'Gravação não confirmada.' }, `Arquivo enviado, mas o cadastro de ${plan.name} não foi confirmado`);
  plan.storagePath = path;
  plan.cloudRevision = data.revision;
}

export async function updateCloudPlan(scope: CloudTakeoffScope, plan: TakeoffPlan, previous: TakeoffPlan): Promise<void> {
  if (!previous.cloudRevision || !previous.storagePath || plan.file !== previous.file) {
    throw new Error('O arquivo original da planta não pode ser substituído nesta edição.');
  }
  const { data, error } = await supabase.from('takeoff_plans').update({
    ...planFields(plan), revision: previous.cloudRevision + 1,
  }).eq('project_id', scope.projectId).eq('id', plan.id).eq('revision', previous.cloudRevision)
    .is('deleted_at', null).select('revision').maybeSingle();
  if (error) throw cloudError(error, `Não foi possível atualizar ${plan.name}`);
  if (!data) throw new Error('Esta planta foi alterada em outro computador. Reabra a planta antes de salvar; suas alterações atuais não foram enviadas.');
  plan.storagePath = previous.storagePath;
  plan.cloudRevision = data.revision;
}

export async function archiveCloudPlan(scope: CloudTakeoffScope, plan: TakeoffPlan): Promise<void> {
  if (!plan.cloudRevision) throw new Error('A planta não possui uma versão confirmada na nuvem.');
  const { data, error } = await supabase.from('takeoff_plans').update({
    revision: plan.cloudRevision + 1, deleted_at: new Date().toISOString(),
  }).eq('project_id', scope.projectId).eq('id', plan.id).eq('revision', plan.cloudRevision)
    .is('deleted_at', null).select('id').maybeSingle();
  if (error) throw cloudError(error, `Não foi possível retirar ${plan.name}`);
  if (!data) throw new Error('Esta planta foi alterada em outro computador. Reabra antes de desfazer.');
  // O arquivo continua no bucket privado para recuperacao administrativa.
}
