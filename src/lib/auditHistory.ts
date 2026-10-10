import { supabase } from '@/integrations/supabase/client';
import type { AuditEntityType, AuditLog } from '@/types/project';
import { withReadDeadline } from './readDeadline';

// History reads never enter the editable Project or its persistence snapshot.
const SUMMARY_SELECT: string = 'id,at:data->>at,entityType:data->>entityType,entityId:data->>entityId,action:data->>action,title:data->>title,description:data->>description,userName:data->>userName,userEmail:data->>userEmail';
export const AUDIT_PAGE_SIZE = 25;
const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export async function loadAuditHistoryPage(projectId: string, entityType: AuditEntityType, entityId: string, page = 0, pageSize = AUDIT_PAGE_SIZE) {
  const offset = page * pageSize;
  const result = await withReadDeadline(supabase.from('audit_logs')
    .select(SUMMARY_SELECT)
    .eq('project_id', projectId)
    .or(`and(entity_type.eq.${quoted(entityType)},entity_id.eq.${quoted(entityId)}),and(data->>entityType.eq.${quoted(entityType)},data->>entityId.eq.${quoted(entityId)})`)
    .order('occurred_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + pageSize)); // One extra summary determines whether another page exists.
  if (result.error) throw result.error;
  const rows = (result.data ?? []) as unknown as AuditLog[];
  return { logs: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}

export async function loadAuditHistoryDetail(projectId: string, id: string): Promise<AuditLog> {
  const result = await withReadDeadline(supabase.from('audit_logs').select('id,data').eq('project_id', projectId).eq('id', id).single());
  if (result.error) throw result.error;
  return { ...(result.data.data as object), id: result.data.id } as AuditLog;
}
