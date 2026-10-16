import { supabase } from '@/integrations/supabase/client';
import { withReadDeadline } from './readDeadline';

export type StorageMaintenanceGroup = {
  projectId: string;
  projectName: string;
  state: 'ativa' | 'obra_excluida';
  files: number;
  bytes: number;
  referenced: number;
  pending: number;
  optimized: number;
  orphans: Array<{ path: string; bytes: number; reason: string; quarantinedAt?: string; cleanupStatus?: string }>;
};

export type StorageMaintenanceReport = { generatedAt: string; totalFiles: number; totalBytes: number; groups: StorageMaintenanceGroup[] };

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await withReadDeadline(supabase.functions.invoke<T>('storage-maintenance', { body }), 60_000);
  if (error) {
    const response = (error as { context?: Response }).context;
    if (response instanceof Response) {
      const details = await response.clone().json().catch(() => null);
      if (typeof details?.error === 'string') throw new Error(details.error);
    }
    const unavailable = /failed to send a request|functionsfetcherror|network/i.test(error.message || '');
    throw new Error(unavailable
      ? 'Não foi possível consultar a manutenção na nuvem. Confira a conexão e tente novamente.'
      : error.message || 'Não foi possível executar a manutenção do Storage.');
  }
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error?: unknown }).error === 'string') throw new Error((data as { error: string }).error);
  return data;
}

export function auditStorageMaintenance(organizationId: string) {
  return invoke<StorageMaintenanceReport>({ action: 'audit', organizationId });
}

export function deleteStorageOrphans(organizationId: string, paths: string[]) {
  return invoke<{ deleted: number; paths: string[] }>({ action: 'delete_orphans', organizationId, paths });
}

export function quarantineStorageOrphans(organizationId: string, paths: string[]) {
  return invoke<{ quarantined: number; paths: string[] }>({ action: 'quarantine_orphans', organizationId, paths });
}

export function recordStorageOptimization(organizationId: string, projectId: string, count: number, savedBytes: number) {
  return invoke<void>({ action: 'record_optimization', organizationId, projectId, count, savedBytes });
}
