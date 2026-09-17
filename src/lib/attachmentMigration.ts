import type {
  CustodyTerm,
  DailyReport,
  Project,
  WarehouseRequisition,
  WarehouseState,
} from '@/types/project';
import { supabase } from '@/integrations/supabase/client';
import { ATTACHMENT_OPTIMIZATION_VERSION, optimizeStorageAttachment } from './attachmentOptimization';
import {
  discardCloudProjectRecord,
  listCloudProjects,
  loadCloudProjectRecord,
  type CloudProjectMeta,
} from './cloudProjects';

export type MigratableAttachment = {
  id: string;
  name: string;
  mimeType?: string;
  storagePath?: string;
  dataUrl?: string;
  kind?: 'nf' | 'foto' | 'recibo' | 'termo' | 'outro';
  optimizedAt?: string;
  optimizationVersion?: number;
  /** Cópia anterior preservada porque a limpeza física falhou após a confirmação. */
  cleanupPendingStoragePath?: string;
  storedBytes?: number;
  fileName?: string;
};

export type AttachmentMigrationScope =
  | { kind: 'daily-report'; before: DailyReport; after: DailyReport }
  | { kind: 'requisition'; before: WarehouseRequisition; after: WarehouseRequisition }
  | { kind: 'custody'; before: CustodyTerm; after: CustodyTerm }
  | { kind: 'warehouse-state'; domain: 'receipt' | 'catalog' };

const BUCKET = 'daily-report-photos';
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function isAttachment(value: unknown): value is MigratableAttachment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && (typeof candidate.storagePath === 'string' || typeof candidate.dataUrl === 'string')
    && (typeof candidate.name === 'string' || typeof candidate.fileName === 'string');
}

/** Elegível quando nunca foi otimizado ou quando foi gravado com um perfil antigo. */
function needsOptimization(attachment: MigratableAttachment): boolean {
  if (!attachment.optimizedAt) return true;
  return (attachment.optimizationVersion ?? 1) < ATTACHMENT_OPTIMIZATION_VERSION;
}

export function collectUnoptimizedAttachments(project: Project): MigratableAttachment[] {
  const found = new Map<string, MigratableAttachment>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (isAttachment(value)) {
      if (needsOptimization(value) && (value.mimeType?.startsWith('image/') || value.kind === 'foto' || value.kind === 'nf' || /\.(jpe?g|png|webp|heic|pdf)$/i.test(value.name || value.fileName || ''))) {
        found.set(`${value.id}:${value.storagePath || value.dataUrl}`, value);
      }
      return;
    }
    Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(project.dailyReports);
  visit(project.warehouse);
  return [...found.values()];
}

function changedRows<T extends { id: string }>(before: T[], after: T[]): Array<{ before: T; after: T }> {
  if (before.length !== after.length) {
    throw new Error('A manutenção não pode incluir, remover ou substituir registros.');
  }
  const beforeById = new Map(before.map(row => [row.id, row]));
  return after.flatMap(row => {
    const previous = beforeById.get(row.id);
    if (!previous) throw new Error('A manutenção não pode incluir, remover ou substituir registros.');
    return !same(previous, row) ? [{ before: previous, after: row }] : [];
  });
}

/**
 * A reotimização só pode alterar uma referência de anexo por vez. Esta
 * classificação impede que uma manutenção de Storage se transforme em
 * persistência genérica da obra ou em regravação de movimentos confirmados.
 */
export function attachmentMigrationScope(before: Project, after: Project): AttachmentMigrationScope {
  if (before.id !== after.id) throw new Error('O anexo não pertence à obra aberta.');
  const projectKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])] as Array<keyof Project>;
  const changedProjectKeys = projectKeys.filter(key => key !== 'dailyReports' && key !== 'warehouse' && !same(before[key], after[key]));
  if (changedProjectKeys.length) {
    throw new Error('A manutenção não pode alterar dados fora da coleção dona do anexo.');
  }

  const daily = changedRows(before.dailyReports ?? [], after.dailyReports ?? []);
  const requisitions = changedRows(
    before.warehouse?.requisitions ?? [],
    after.warehouse?.requisitions ?? [],
  );
  const custody = changedRows(
    before.warehouse?.custodyTerms ?? [],
    after.warehouse?.custodyTerms ?? [],
  );
  const previousWarehouse = before.warehouse;
  const nextWarehouse = after.warehouse;
  if (!previousWarehouse || !nextWarehouse) {
    throw new Error('Não foi possível identificar a coleção responsável pelo anexo.');
  }
  const rowCollections = new Set<keyof WarehouseState>(['requisitions', 'custodyTerms']);
  const warehouseKeys = [...new Set([...Object.keys(previousWarehouse), ...Object.keys(nextWarehouse)])] as Array<keyof WarehouseState>;
  const changedStateKeys = warehouseKeys
    .filter(key => !rowCollections.has(key) && !same(previousWarehouse[key], nextWarehouse[key]));
  const changedCollections = Number(daily.length > 0) + Number(requisitions.length > 0) + Number(custody.length > 0) + changedStateKeys.length;

  if (changedCollections !== 1 || daily.length > 1 || requisitions.length > 1 || custody.length > 1) {
    throw new Error('A manutenção deve alterar um único anexo por vez.');
  }
  if (daily.length) return { kind: 'daily-report', ...daily[0] };
  if (requisitions.length) return { kind: 'requisition', ...requisitions[0] };
  if (custody.length) return { kind: 'custody', ...custody[0] };
  if (changedStateKeys.length === 1 && changedStateKeys[0] === 'fiscalNotes') return { kind: 'warehouse-state', domain: 'receipt' };
  if (changedStateKeys.length === 1 && (changedStateKeys[0] === 'equipments' || changedStateKeys[0] === 'equipmentGroups')) {
    return { kind: 'warehouse-state', domain: 'catalog' };
  }
  throw new Error('Este anexo histórico não pode ser atualizado sem alterar outro registro. A cópia original foi preservada.');
}

function updateAttachmentByStoredPath(
  value: unknown,
  attachmentId: string,
  storagePath: string,
  update: (attachment: MigratableAttachment) => MigratableAttachment,
): unknown {
  if (Array.isArray(value)) return value.map(item => updateAttachmentByStoredPath(item, attachmentId, storagePath, update));
  if (!value || typeof value !== 'object') return value;
  if (isAttachment(value) && value.id === attachmentId && value.storagePath === storagePath) return update(value);
  const entries = Object.entries(value as Record<string, unknown>);
  let changed = false;
  const next = Object.fromEntries(entries.map(([key, item]) => {
    const result = updateAttachmentByStoredPath(item, attachmentId, storagePath, update);
    changed ||= result !== item;
    return [key, result];
  }));
  return changed ? next : value;
}

/** Mantém o caminho anterior somente quando sua limpeza física não confirmou. */
export function markAttachmentCleanupPending(
  project: Project,
  attachmentId: string,
  storedPath: string,
  previousPath: string,
): Project {
  return updateAttachmentByStoredPath(project, attachmentId, storedPath, attachment => ({
    ...attachment,
    cleanupPendingStoragePath: previousPath,
  })) as Project;
}

/** Lista todos os anexos referenciados por uma obra, inclusive os já otimizados. */
export function collectProjectAttachments(project: Project): MigratableAttachment[] {
  const found = new Map<string, MigratableAttachment>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (isAttachment(value)) { found.set(`${value.id}:${value.storagePath || value.dataUrl}`, value); return; }
    Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(project.dailyReports);
  visit(project.warehouse);
  return [...found.values()];
}

export type StorageObjectAudit = { path: string; bytes: number };
export type StorageProjectAudit = {
  meta: CloudProjectMeta;
  project: Project;
  updatedAt: string;
  attachments: MigratableAttachment[];
  candidates: MigratableAttachment[];
  objects: StorageObjectAudit[];
  orphaned: StorageObjectAudit[];
};

function objectBytes(metadata: unknown): number {
  const raw = (metadata as { size?: unknown } | null)?.size;
  return typeof raw === 'number' ? raw : Number(raw || 0);
}

async function listStorageTree(prefix: string): Promise<StorageObjectAudit[]> {
  const objects: StorageObjectAudit[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`Não foi possível listar o Storage de ${prefix}: ${error.message}`);
    const batch = data ?? [];
    for (const item of batch) {
      const path = `${prefix}/${item.name}`;
      if (item.id) objects.push({ path, bytes: objectBytes(item.metadata) });
      else objects.push(...await listStorageTree(path));
    }
    hasMore = batch.length >= 100;
    if (hasMore) offset += batch.length;
  }
  return objects;
}

/** Auditoria somente-leitura de todas as obras visíveis da organização atual. */
export async function auditOrganizationStorage(): Promise<StorageProjectAudit[]> {
  const projects = await listCloudProjects();
  const result: StorageProjectAudit[] = [];
  for (const meta of projects) {
    // Esta é uma leitura auxiliar: o projeto não será adotado pela UI. Portanto,
    // a hidratação precisa permanecer isolada do snapshot usado pelo autosave da
    // obra aberta. A leitura estrita também impede classificar como órfão um
    // arquivo cuja coleção tenha falhado ao carregar.
    const record = await loadCloudProjectRecord(meta.id, {
      strict: true,
      deferSnapshot: true,
    });
    if (!record) continue;
    const inspectedProject = record.project;
    discardCloudProjectRecord(record);
    const attachments = collectProjectAttachments(inspectedProject);
    const referenced = new Set(attachments.flatMap(attachment => attachment.storagePath ? [attachment.storagePath] : []));
    const objects = await listStorageTree(meta.id);
    result.push({
      meta,
      project: inspectedProject,
      updatedAt: record.updatedAt,
      attachments,
      candidates: attachments.filter(needsOptimization),
      objects,
      orphaned: objects.filter(object => !referenced.has(object.path)),
    });
  }
  return result;
}


async function attachmentFile(attachment: MigratableAttachment): Promise<File> {
  let blob: Blob;
  if (attachment.storagePath) {
    const { data, error } = await supabase.storage.from(BUCKET).download(attachment.storagePath);
    if (error || !data) throw new Error(`Não foi possível baixar ${attachment.name || attachment.fileName}.`);
    blob = data;
  } else if (attachment.dataUrl) {
    blob = await (await fetch(attachment.dataUrl)).blob();
  } else throw new Error('Anexo sem arquivo de origem.');
  return new File([blob], attachment.name || attachment.fileName || 'anexo', { type: attachment.mimeType || blob.type });
}

function replaceAttachment(value: unknown, target: MigratableAttachment, replacement: MigratableAttachment): unknown {
  if (Array.isArray(value)) return value.map(item => replaceAttachment(item, target, replacement));
  if (!value || typeof value !== 'object') return value;
  if (isAttachment(value) && value.id === target.id && value.storagePath === target.storagePath && value.dataUrl === target.dataUrl) {
    const nameKey = 'fileName' in value ? 'fileName' : 'name';
    return { ...value, ...replacement, [nameKey]: replacement.name, dataUrl: undefined };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  let changed = false;
  const next = Object.fromEntries(entries.map(([key, item]) => {
    const result = replaceAttachment(item, target, replacement);
    changed ||= result !== item;
    return [key, result];
  }));
  return changed ? next : value;
}

export async function migrateAttachment(project: Project, attachment: MigratableAttachment): Promise<{ project: Project; originalBytes: number; storedBytes: number; oldPath?: string; newPath: string }> {
  const original = await attachmentFile(attachment);
  const optimized = await optimizeStorageAttachment(original, attachment.kind);
  // Já está no menor tamanho possível: apenas marca a versão do perfil para não reprocessar.
  if (optimized.size >= original.size) {
    const marked: MigratableAttachment = {
      ...attachment,
      optimizedAt: attachment.optimizedAt || new Date().toISOString(),
      optimizationVersion: ATTACHMENT_OPTIMIZATION_VERSION,
      storedBytes: original.size,
    };
    const same = replaceAttachment(project, attachment, marked) as Project;
    return { project: same, originalBytes: original.size, storedBytes: original.size, oldPath: undefined, newPath: attachment.storagePath || '' };
  }
  const extension = (optimized.name.split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const path = `${project.id}/optimized/${attachment.id}-${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, optimized, { contentType: optimized.type || 'application/octet-stream', upsert: false });
  if (error) throw new Error(`Não foi possível gravar a versão otimizada: ${error.message}`);
  const replacement: MigratableAttachment = {
    ...attachment,
    name: optimized.name,
    mimeType: optimized.type,
    storagePath: path,
    dataUrl: undefined,
    storedBytes: optimized.size,
    optimizedAt: new Date().toISOString(),
    optimizationVersion: ATTACHMENT_OPTIMIZATION_VERSION,
  };
  try {
    const next = replaceAttachment(project, attachment, replacement) as Project;
    return { project: next, originalBytes: original.size, storedBytes: optimized.size, oldPath: attachment.storagePath, newPath: path };
  } catch (error) {
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }
}


export async function deletePreviousAttachment(path?: string): Promise<void> {
  if (!path) return;
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}
