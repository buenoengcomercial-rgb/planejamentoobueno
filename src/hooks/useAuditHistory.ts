import { useEffect, useMemo, useRef, useState } from 'react';
import { loadAuditHistoryPage } from '@/lib/auditHistory';
import { getEntityAuditLogs } from '@/lib/audit';
import type { AuditEntityType, AuditLog, Project } from '@/types/project';

export function useAuditHistory(project: Project, entityType: AuditEntityType, entityId: string, enabled: boolean, pageSize = 25) {
  const key = `${project.id}:${entityType}:${entityId}:${enabled}`;
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string; logs: AuditLog[]; page: number; loading: boolean; error: boolean; hasMore: boolean }>({ key: '', logs: [], page: -1, loading: false, error: false, hasMore: false });
  const fetchPage = async (page: number) => {
    const request = ++sequence.current;
    setState(previous => ({ ...(previous.key === key ? previous : { logs: [], page: -1, hasMore: false }), key, loading: true, error: false }));
    try {
      const result = await loadAuditHistoryPage(project.id, entityType, entityId, page, pageSize);
      if (request === sequence.current) setState(previous => ({ key, logs: page === 0 ? result.logs : [...previous.logs, ...result.logs], page, loading: false, error: false, hasMore: result.hasMore }));
    } catch {
      if (request === sequence.current) setState(previous => ({ ...previous, loading: false, error: true }));
    }
  };
  useEffect(() => {
    if (enabled) void fetchPage(0);
    // Request version ref, not a DOM ref: invalidate all outstanding reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { sequence.current++; };
    // The request is tied to the identity, not to edits of the project object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pageSize]);
  const logs = useMemo(() => {
    const merged = new Map<string, AuditLog>();
    if (enabled && state.key === key) state.logs.forEach(log => merged.set(log.id, log));
    getEntityAuditLogs(project, entityType, entityId).forEach(log => merged.set(log.id, log));
    return [...merged.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  }, [project, entityType, entityId, enabled, key, state]);
  return { logs, loading: enabled && (state.key !== key || state.loading), error: state.key === key && state.error, hasMore: state.key === key && state.hasMore, retry: () => fetchPage(Math.max(0, state.page + 1)), loadMore: () => fetchPage(state.page + 1) };
}
