import type { DailyReport } from '@/types/project';
import { projectCollectionsForRealtimeTable, type ProjectCollectionKey } from '@/lib/projectDataScope';
import { subscribeProjectRealtime, type ProjectRealtimePayload } from './projectRealtimeChannel';

interface Ref<T> { current: T }

interface DispatchOptions {
  projectId: string;
  timerRef: Ref<number | null>;
  sourcesRef: Ref<Set<string>>;
  ownRowsRef: Ref<Map<string, number>>;
  pendingCollectionsRef: Ref<Map<string, Set<ProjectCollectionKey>>>;
  currentUpdatedAt: () => string | null;
  onDailyReport: (report: DailyReport) => void;
  onRefresh: (sources: readonly string[]) => void;
}

/** Groups row notifications while retaining their domain before any autosave can run. */
export function createProjectRealtimeDispatcher({
  projectId, timerRef, sourcesRef, ownRowsRef, pendingCollectionsRef,
  currentUpdatedAt, onDailyReport, onRefresh,
}: DispatchOptions) {
  let disposed = false;
  const onRow = (payload?: ProjectRealtimePayload, source?: string) => {
    if (disposed) return;
    if (source === 'daily_reports') {
      const incoming = payload?.new?.data as DailyReport | undefined;
      if (incoming?.date) {
        onDailyReport(incoming);
        return;
      }
    }
    const rowId = typeof payload?.new?.id === 'string'
      ? payload.new.id
      : typeof payload?.old?.id === 'string' ? payload.old.id : null;
    if (source && rowId) {
      const key = `${source}:${rowId}`;
      const expiresAt = ownRowsRef.current.get(key);
      if (expiresAt && expiresAt > Date.now()) {
        ownRowsRef.current.delete(key);
        return;
      }
      if (expiresAt) ownRowsRef.current.delete(key);
    }
    const remoteUpdatedAt = typeof payload?.new?.updated_at === 'string' ? payload.new.updated_at : null;
    if (remoteUpdatedAt && remoteUpdatedAt === currentUpdatedAt()) return;
    if (source) {
      const affectedCollections = projectCollectionsForRealtimeTable(source);
      if (affectedCollections.length > 0) {
        const pending = pendingCollectionsRef.current.get(projectId) ?? new Set<ProjectCollectionKey>();
        affectedCollections.forEach(collection => pending.add(collection));
        pendingCollectionsRef.current.set(projectId, pending);
      }
      sourcesRef.current.add(source);
    }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const sources = [...sourcesRef.current];
      sourcesRef.current.clear();
      if (!disposed) onRefresh(sources);
    }, 1200);
  };

  const dispose = () => {
    disposed = true;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    sourcesRef.current.clear();
  };
  return { onRow, dispose };
}

interface SubscribeOptions extends DispatchOptions {
  onConnected: () => void;
  onConnectionChange: (connected: boolean) => void;
  isConnected: () => boolean;
}

export function subscribeProjectRemoteSignals(options: SubscribeOptions): () => void {
  const dispatcher = createProjectRealtimeDispatcher(options);
  const unsubscribe = subscribeProjectRealtime({
    projectId: options.projectId,
    onRow: dispatcher.onRow,
    onConnected: options.onConnected,
    onConnectionChange: options.onConnectionChange,
    isConnected: options.isConnected,
  });
  return () => {
    dispatcher.dispose();
    unsubscribe();
  };
}
