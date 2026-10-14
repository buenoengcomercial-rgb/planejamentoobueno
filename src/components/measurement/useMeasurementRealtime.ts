import { useCallback, useEffect, useRef, useState } from 'react';
import type { MeasurementRepository } from '@/lib/measurementWorkspaceStore';
import type { MeasurementWorkspace } from '@/lib/measurementWorkspace';
import { withReadDeadline } from '@/lib/readDeadline';

interface Options {
  repository: MeasurementRepository;
  projectId?: string;
  revision?: number;
  canRefresh: () => boolean;
  onRefresh: (workspace: MeasurementWorkspace) => void;
}

/** Version notices never confirm a save and never replace an in-progress draft. */
export function useMeasurementRealtime(options: Options) {
  const latest = useRef(options); latest.current = options;
  const resume = useRef<() => void>(() => undefined);
  const retryRead = useRef<() => void>(() => undefined);
  const [connected, setConnected] = useState(false), [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
  const [checkingCloud, setCheckingCloud] = useState(false), [failure, setFailure] = useState('');
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  useEffect(() => {
    const { repository } = latest.current;
    if (!repository.watch || !repository.remoteRevision) return;
    let disposed = false, live = false, wanted = -1, reading = false, checking = false, readFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (cause: unknown) => {
      readFailed = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      setFailed(true); setPending(false);
      setFailure(cause instanceof Error ? cause.message : 'Não foi possível consultar a Medição na nuvem.');
    };
    const clearFailure = () => { readFailed = false; setFailed(false); setFailure(''); };
    const schedule = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 300);
    };
    const refresh = async () => {
      const state = latest.current;
      if (disposed || state.revision === undefined || reading) return;
      if (!navigator.onLine) { setPending(false); return; }
      // A page opened from the browser copy must re-read the cloud even when
      // the revision matches, otherwise it stays marked as offline.
      const offlineBase = !!repository.loadedOffline?.();
      if (wanted <= state.revision && !offlineBase) { setPending(false); return; }
      setPending(true);
      if (!state.canRefresh()) return;
      reading = true;
      setCheckingCloud(true);
      const baseRevision = state.revision;
      let succeeded = false;
      try {
        // Cloud reads own their bounded cache recovery after the RPC deadline.
        // Do not race that recovery with an identical UI deadline.
        const read = repository.load();
        const remote = await (repository.loadState ? read : withReadDeadline(read));
        if (disposed) return;
        const now = latest.current;
        // Editing or committing can start while the complete cloud read is pending.
        if (!remote || remote.projectId !== state.projectId || repository.loadedOffline?.()
          || remote.revision < baseRevision || (remote.revision === baseRevision && !offlineBase)) throw new Error('Atualização não confirmada');
        if (now.revision === baseRevision && now.canRefresh()) now.onRefresh(remote);
        succeeded = true; clearFailure();
        if (wanted <= remote.revision) setPending(false);
      } catch (cause) { if (!disposed) fail(cause); }
      finally {
        reading = false;
        if (!disposed) { setCheckingCloud(checking); if (succeeded && latest.current.revision !== baseRevision) schedule(); }
      }
    };
    const notice = (revision: number) => { if (!disposed) { wanted = Math.max(wanted, revision); schedule(); } };
    const check = async () => {
      if (disposed || checking || !navigator.onLine || document.visibilityState === 'hidden') return;
      checking = true;
      setCheckingCloud(true);
      try {
        const revision = await withReadDeadline(repository.remoteRevision!());
        if (!disposed) {
          if (revision <= (latest.current.revision ?? -1) && wanted <= (latest.current.revision ?? -1) && !repository.loadedOffline?.()) clearFailure();
          setLastCheckedAt(new Date().toISOString()); notice(revision);
        }
      }
      catch (cause) { if (!disposed) fail(cause); }
      finally { checking = false; if (!disposed) setCheckingCloud(reading); }
    };
    const stop = repository.watch(notice, value => {
      if (disposed) return;
      live = value; setConnected(value);
      if (value) void check();
    });
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    const focus = () => { void check(); schedule(); };
    const offline = () => { live = false; setConnected(false); };
    resume.current = () => { if (!readFailed) schedule(); };
    retryRead.current = focus;
    // Only a small revision check is polled when the socket is disconnected.
    const fallback = setInterval(() => { if (!live || readFailed || wanted > (latest.current.revision ?? -1) || repository.loadedOffline?.()) { void check(); schedule(); } }, 15000);
    window.addEventListener('focus', focus); window.addEventListener('online', focus); window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible); document.addEventListener('focusout', schedule);
    return () => {
      disposed = true; stop(); if (timer) clearTimeout(timer); clearInterval(fallback); resume.current = () => undefined; retryRead.current = () => undefined;
      window.removeEventListener('focus', focus); window.removeEventListener('online', focus); window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible); document.removeEventListener('focusout', schedule);
    };
  }, [options.repository]);
  useEffect(() => { resume.current(); });
  const retry = useCallback(() => retryRead.current(), []);
  return { connected, pending, failed, failure, checking: checkingCloud, retry, lastCheckedAt, available: !!options.repository.watch };
}
