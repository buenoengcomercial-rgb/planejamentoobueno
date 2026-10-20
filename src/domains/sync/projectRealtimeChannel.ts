import { supabase } from '@/integrations/supabase/client';
import { PROJECT_REALTIME_TABLES } from '@/lib/projectDataScope';
import { recordSyncDiagnostic } from '@/lib/syncDiagnostics';

export interface ProjectRealtimePayload {
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
}

interface ProjectRealtimeOptions {
  projectId: string;
  onRow: (payload: ProjectRealtimePayload, table: string) => void;
  onConnected: () => void;
  onConnectionChange: (connected: boolean) => void;
  isConnected: () => boolean;
}

/** One channel per open project; changing tabs only changes the callbacks. */
export function subscribeProjectRealtime({
  projectId, onRow, onConnected, onConnectionChange, isConnected,
}: ProjectRealtimeOptions): () => void {
  const channel = supabase.channel(`project-live:${projectId}`);
  channel.on('postgres_changes', {
    event: '*', schema: 'public', table: 'projects', filter: `id=eq.${projectId}`,
  }, payload => onRow(payload, 'projects'));
  PROJECT_REALTIME_TABLES.forEach(table => {
    channel.on('postgres_changes', {
      event: '*', schema: 'public', table, filter: `project_id=eq.${projectId}`,
    }, payload => onRow(payload, table));
  });

  let disposed = false;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  const clearReconnect = () => {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };
  const scheduleReconnect = (immediate = false) => {
    if (disposed || reconnectTimer !== null || isConnected()) return;
    const delay = immediate ? 0 : [2000, 5000, 15000, 30000][Math.min(reconnectAttempts++, 3)];
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (disposed || isConnected()) return;
      if (!navigator.onLine || document.visibilityState !== 'visible') return;
      recordSyncDiagnostic({ area: 'realtime', operation: 'reconnect', outcome: 'disconnected', attempt: reconnectAttempts });
      channel.subscribe(handleChannelStatus);
      scheduleReconnect();
    }, delay);
  };
  const handleChannelStatus = (status: string) => {
    if (disposed) return;
    const connected = status === 'SUBSCRIBED';
    const wasConnected = isConnected();
    onConnectionChange(connected);
    if (connected) {
      if (!wasConnected) recordSyncDiagnostic({ area: 'realtime', operation: 'channel', outcome: 'connected' });
      clearReconnect();
      reconnectAttempts = 0;
      onConnected();
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      if (wasConnected) recordSyncDiagnostic({ area: 'realtime', operation: 'channel', outcome: 'disconnected' });
      console.warn(`[realtime] Canal da obra ${projectId} indisponível: ${status}`);
      if (status === 'CLOSED') scheduleReconnect();
    }
  };
  channel.subscribe(handleChannelStatus);
  const handleVisibility = () => {
    if (document.visibilityState === 'visible' && !isConnected()) scheduleReconnect(true);
  };
  const handleOnline = () => {
    if (!isConnected()) scheduleReconnect(true);
  };
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('online', handleOnline);
  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('online', handleOnline);
    clearReconnect();
    onConnectionChange(false);
    void supabase.removeChannel(channel);
  };
}
