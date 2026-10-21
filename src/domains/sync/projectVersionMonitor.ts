const REMOTE_VERSION_POLL_MS = 15_000;
const CHECK_DEBOUNCE_MS = 200;

interface ProjectVersionMonitorOptions {
  checkVersion: () => void;
  isRealtimeConnected: () => boolean;
  onOnline: () => void;
  onOffline: () => void;
}

/** Watches the active project for missed remote changes and reconnects. */
export function subscribeProjectVersionMonitor({
  checkVersion, isRealtimeConnected, onOnline, onOffline,
}: ProjectVersionMonitorOptions): () => void {
  let checkTimer: number | null = null;
  const checkSoon = () => {
    if (checkTimer !== null) return;
    checkTimer = window.setTimeout(() => {
      checkTimer = null;
      checkVersion();
    }, CHECK_DEBOUNCE_MS);
  };
  const handleOnline = () => {
    onOnline();
    checkSoon();
  };
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') checkSoon();
  };
  // Realtime covers connected sessions; polling only recovers missed changes.
  const interval = window.setInterval(() => {
    if (!isRealtimeConnected()) checkSoon();
  }, REMOTE_VERSION_POLL_MS);
  window.addEventListener('focus', checkSoon);
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', handleVisibility);

  return () => {
    window.clearInterval(interval);
    if (checkTimer !== null) window.clearTimeout(checkTimer);
    window.removeEventListener('focus', checkSoon);
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}
