import type { Project } from '@/types/project';
import { supabase } from '@/integrations/supabase/client';
import { optimizeStorageAttachment } from './attachmentOptimization';

export type MigratableAttachment = {
  id: string;
  name: string;
  mimeType?: string;
  storagePath?: string;
  dataUrl?: string;
  kind?: 'nf' | 'foto' | 'recibo' | 'termo' | 'outro';
  optimizedAt?: string;
  fileName?: string;
};

const BUCKET = 'daily-report-photos';

function isAttachment(value: unknown): value is MigratableAttachment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && (typeof candidate.storagePath === 'string' || typeof candidate.dataUrl === 'string')
    && (typeof candidate.name === 'string' || typeof candidate.fileName === 'string');
}

export function collectUnoptimizedAttachments(project: Project): MigratableAttachment[] {
  const found = new Map<string, MigratableAttachment>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (isAttachment(value)) {
      if (!value.optimizedAt && (value.mimeType?.startsWith('image/') || value.kind === 'foto' || value.kind === 'nf' || /\.(jpe?g|png|webp|heic|pdf)$/i.test(value.name || value.fileName || ''))) {
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
    optimizedAt: new Date().toISOString(),
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
