import { supabase } from '@/integrations/supabase/client';
import type { DailyReport } from '@/types/project';
import { isDailyReportEmpty } from '@/lib/dailyReportSummary';

type Json = import('@/integrations/supabase/types').Json;

export class DailyReportLockedError extends Error {
  constructor() {
    super('Este Diário já foi concluído e não pode ser alterado.');
    this.name = 'DailyReportLockedError';
  }
}

export interface DailyReportSaveResult {
  report: DailyReport | null;
  conflicts: string[];
}

interface DailyReportRow {
  id: string;
  data: DailyReport;
  updated_at: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function mergeValue(base: unknown, local: unknown, remote: unknown, path: string, conflicts: string[]): unknown {
  if (same(local, base)) return remote;
  if (same(remote, base) || same(local, remote)) return local;

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    const hasIds = [...base, ...local, ...remote].every(item => isRecord(item) && typeof item.id === 'string');
    if (!hasIds) {
      conflicts.push(path);
      return remote;
    }
    const baseById = new Map(base.map(item => [(item as { id: string }).id, item]));
    const localById = new Map(local.map(item => [(item as { id: string }).id, item]));
    const remoteById = new Map(remote.map(item => [(item as { id: string }).id, item]));
    const ids = [...remoteById.keys(), ...localById.keys()].filter((id, index, values) => values.indexOf(id) === index);
    return ids.flatMap(id => {
      const before = baseById.get(id);
      const localItem = localById.get(id);
      const remoteItem = remoteById.get(id);
      if (!before) return [remoteItem ?? localItem];
      if (!localItem) {
        if (!remoteItem || same(remoteItem, before)) return [];
        conflicts.push(`${path}.${id}`);
        return [remoteItem];
      }
      if (!remoteItem) return [localItem];
      return [mergeValue(before, localItem, remoteItem, `${path}.${id}`, conflicts)];
    });
  }

  if (isRecord(base) && isRecord(local) && isRecord(remote)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    const merged: Record<string, unknown> = {};
    keys.forEach(key => {
      const value = mergeValue(base[key], local[key], remote[key], path ? `${path}.${key}` : key, conflicts);
      if (value !== undefined) merged[key] = value;
    });
    return merged;
  }

  // A primeira alteração no mesmo campo permanece. A edição concorrente nunca
  // substitui silenciosamente um texto já confirmado no servidor.
  conflicts.push(path);
  return remote;
}

export function mergeDailyReportVersions(base: DailyReport, local: DailyReport, remote: DailyReport): DailyReportSaveResult {
  const conflicts: string[] = [];
  // Metadados de linha não representam conteúdo concorrente. Eles não podem
  // transformar duas alterações em campos distintos em um falso conflito.
  const { id: _baseId, date: _baseDate, createdAt: _baseCreatedAt, updatedAt: _baseUpdatedAt, ...baseContent } = base;
  const { id: _localId, date: _localDate, createdAt: _localCreatedAt, updatedAt: _localUpdatedAt, ...localContent } = local;
  const { id: _remoteId, date: _remoteDate, createdAt: _remoteCreatedAt, updatedAt: _remoteUpdatedAt, ...remoteContent } = remote;
  const merged = mergeValue(baseContent, localContent, remoteContent, '', conflicts) as Omit<DailyReport, 'id' | 'date' | 'createdAt' | 'updatedAt'>;
  return {
    report: {
      ...merged,
      id: remote.id,
      date: remote.date,
      createdAt: remote.createdAt || merged.createdAt,
      updatedAt: new Date().toISOString(),
    },
    conflicts,
  };
}

async function loadDailyReport(projectId: string, date: string): Promise<DailyReportRow | null> {
  const { data, error } = await supabase
    .from('daily_reports')
    .select('id, data, updated_at')
    .eq('project_id', projectId)
    .eq('report_date', date)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id, data: data.data as unknown as DailyReport, updated_at: data.updated_at };
}

/**
 * Salva somente o Diário alterado. A versão da linha é a barreira de
 * concorrência: alterações em campos distintos são combinadas e, no mesmo
 * campo, a primeira confirmação do servidor é mantida.
 */
export async function saveOpenDailyReport(
  projectId: string,
  base: DailyReport,
  local: DailyReport,
): Promise<DailyReportSaveResult> {
  let remote = await loadDailyReport(projectId, local.date);
  const allConflicts: string[] = [];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!remote) {
      if (isDailyReportEmpty(local)) return { report: null, conflicts: allConflicts };
      const { data, error } = await supabase
        .from('daily_reports')
        .insert({ id: local.id, project_id: projectId, report_date: local.date, data: local as unknown as Json })
        .select('data')
        .maybeSingle();
      if (!error && data) return { report: data.data as unknown as DailyReport, conflicts: allConflicts };
      remote = await loadDailyReport(projectId, local.date);
      if (!remote) throw error ?? new Error('Não foi possível criar o Diário.');
    }

    if (remote.data.concludedAt) throw new DailyReportLockedError();

    if (isDailyReportEmpty(local)) {
      const { data, error } = await supabase
        .from('daily_reports')
        .delete()
        .eq('id', remote.id)
        .eq('updated_at', remote.updated_at)
        .select('id');
      if (error) throw error;
      if (data?.length) return { report: null, conflicts: allConflicts };
      remote = await loadDailyReport(projectId, local.date);
      continue;
    }

    const merged = mergeDailyReportVersions(base, local, remote.data);
    allConflicts.push(...merged.conflicts);
    const { data, error } = await supabase
      .from('daily_reports')
      .update({ data: merged.report as unknown as Json, report_date: merged.report.date })
      .eq('id', remote.id)
      .eq('updated_at', remote.updated_at)
      .select('data')
      .maybeSingle();
    if (error) throw error;
    if (data) return { report: data.data as unknown as DailyReport, conflicts: allConflicts };
    remote = await loadDailyReport(projectId, local.date);
  }

  throw new Error('O Diário mudou várias vezes durante o salvamento. Tente novamente.');
}

export async function loadOpenDailyReport(projectId: string, date: string): Promise<DailyReport | null> {
  const row = await loadDailyReport(projectId, date);
  return row?.data ?? null;
}
