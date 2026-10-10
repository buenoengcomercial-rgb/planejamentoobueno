import { useEffect, useRef, useState } from 'react';
import type { MeasurementRepository } from '@/lib/measurementWorkspaceStore';
import type { MeasurementWorkspace } from '@/lib/measurementWorkspace';

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
  const [connected, setConnected] = useState(false), [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => {
    const { repository } = latest.current;
    if (!repository.watch || !repository.remoteRevision) return;
    let disposed = false, live = false, wanted = -1, reading = false, checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 300);
    };
    const refresh = async () => {
      const state = latest.current;
      if (disposed || state.revision === undefined || reading) return;
      if (wanted <= state.revision) { setPending(false); return; }
      setPending(true);
      if (!state.canRefresh()) return;
      reading = true;
      const baseRevision = state.revision;
      let succeeded = false;
      try {
        const remote = await repository.load();
        if (disposed) return;
        const now = latest.current;
        // Editing or committing can start while the complete cloud read is pending.
        if (!remote || remote.projectId !== state.projectId || remote.revision <= baseRevision) throw new Error('Atualização não confirmada');
        if (now.revision === baseRevision && now.canRefresh() && remote && remote.revision > baseRevision) now.onRefresh(remote);
        succeeded = true; setFailed(false);
      } catch { if (!disposed) setFailed(true); }
      finally { reading = false; if (!disposed && succeeded && latest.current.revision !== baseRevision) schedule(); }
    };
    const notice = (revision: number) => { if (!disposed) { wanted = Math.max(wanted, revision); schedule(); } };
    const check = async () => {
      if (disposed || checking || document.visibilityState === 'hidden') return;
      checking = true;
      try { const revision = await repository.remoteRevision!(); if (!disposed) { setFailed(false); notice(revision); } }
      catch { if (!disposed) setFailed(true); }
      finally { checking = false; }
    };
    const stop = repository.watch(notice, value => {
      if (disposed) return;
      live = value; setConnected(value);
      if (value) void check();
    });
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    const focus = () => { void check(); schedule(); };
    const offline = () => { live = false; setConnected(false); };
    resume.current = schedule;
    // Only a small revision check is polled when the socket is disconnected.
    const fallback = setInterval(() => { if (!live || wanted > (latest.current.revision ?? -1)) { void check(); schedule(); } }, 15000);
    window.addEventListener('focus', focus); window.addEventListener('online', focus); window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible); document.addEventListener('focusout', schedule);
    return () => {
      disposed = true; stop(); if (timer) clearTimeout(timer); clearInterval(fallback); resume.current = () => undefined;
      window.removeEventListener('focus', focus); window.removeEventListener('online', focus); window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible); document.removeEventListener('focusout', schedule);
    };
  }, [options.repository]);
  useEffect(() => { resume.current(); });
  return { connected, pending, failed, available: !!options.repository.watch };
}
