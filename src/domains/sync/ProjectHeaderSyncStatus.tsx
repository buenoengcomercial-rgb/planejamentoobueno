import SaveStatusIndicator, { type SaveStatus } from '@/components/SaveStatusIndicator';

interface ProjectHeaderSyncStatusProps {
  activeView: string;
  independentMeasurement: boolean;
  status: SaveStatus;
  confirmedAt: string | null;
  lastCheckedAt: string | null;
  projectId: string;
  live: boolean;
  remoteUpdateAt: string | null;
  pendingRemoteAreas: readonly string[];
  partialSyncPending: boolean;
  partialSyncDraftProtected: boolean;
  syncRetrying: boolean;
  dailyReportHasErrors: boolean;
}

export default function ProjectHeaderSyncStatus({
  activeView, independentMeasurement, status, confirmedAt, lastCheckedAt,
  projectId, live, remoteUpdateAt, pendingRemoteAreas, partialSyncPending,
  partialSyncDraftProtected, syncRetrying, dailyReportHasErrors,
}: ProjectHeaderSyncStatusProps) {
  if (independentMeasurement && ['idle', 'saved'].includes(status)
    && !dailyReportHasErrors && !partialSyncPending) return null;

  const indicatorStatus = dailyReportHasErrors && status !== 'saving' ? 'error' : status;
  const otherAreaLabel = independentMeasurement
    ? 'Outras áreas da obra'
    : dailyReportHasErrors && activeView !== 'dailyReport' ? 'Pendência no Diário de Obra' : null;

  return (
    <div className="absolute top-3 right-4 z-20">
      {otherAreaLabel && <span className="block text-right text-[10px] text-muted-foreground">{otherAreaLabel}</span>}
      <SaveStatusIndicator
        status={indicatorStatus}
        confirmedAt={confirmedAt}
        lastCheckedAt={lastCheckedAt}
        projectId={projectId}
        live={live}
        remoteUpdateAt={remoteUpdateAt}
        pendingRemoteAreas={pendingRemoteAreas}
        partialSyncPending={partialSyncPending}
        partialSyncDraftProtected={partialSyncDraftProtected}
        syncRetrying={syncRetrying}
      />
    </div>
  );
}
