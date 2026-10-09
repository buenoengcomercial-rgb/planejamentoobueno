import { Cloud, CloudOff, Loader2, Check, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { APP_BUILD } from '@/lib/buildIdentity';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'updating' | 'saved' | 'conflict' | 'offline' | 'error';

interface Props {
  status: SaveStatus;
  className?: string;
  confirmedAt?: string | null;
  lastCheckedAt?: string | null;
  projectId?: string;
  live?: boolean;
  remoteUpdateAt?: string | null;
  pendingRemoteAreas?: readonly string[];
  partialSyncPending?: boolean;
  partialSyncDraftProtected?: boolean;
  syncRetrying?: boolean;
}

function timeLabel(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export default function SaveStatusIndicator({ status, className, confirmedAt, lastCheckedAt, projectId, live, remoteUpdateAt, pendingRemoteAreas = [], partialSyncPending = false, partialSyncDraftProtected = false, syncRetrying = false }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [live]);
  const map = {
    idle:   { icon: Cloud,   text: 'Pronto',          color: 'text-muted-foreground' },
    pending: { icon: Cloud, text: 'Aguardando envio à nuvem', color: 'text-muted-foreground' },
    saving: { icon: Loader2, text: 'Salvando...',     color: 'text-muted-foreground', spin: true },
    updating: { icon: RefreshCw, text: 'Atualizando dados...', color: 'text-primary', spin: true },
    saved:  { icon: Check,   text: 'Salvo e conferido na nuvem',  color: 'text-primary' },
    conflict: { icon: TriangleAlert, text: 'Atualização em outro aparelho', color: 'text-warning' },
    offline: { icon: WifiOff, text: 'Sem internet', color: 'text-warning' },
    error:  { icon: CloudOff, text: 'Falha na sincronização', color: 'text-destructive' },
  } as const;
  const cfg = partialSyncPending
    ? { icon: syncRetrying ? Loader2 : TriangleAlert,
        text: syncRetrying ? 'Sincronização parcial — tentando novamente'
          : partialSyncDraftProtected ? 'Sincronização parcial — cópia local protegida'
            : 'Sincronização parcial — mantenha esta página aberta',
        color: 'text-warning', spin: syncRetrying }
    : map[status];
  const Icon = cfg.icon;
  const confirmed = timeLabel(confirmedAt);
  const remoteUpdated = timeLabel(remoteUpdateAt);
  const lastCheckAge = lastCheckedAt ? now - new Date(lastCheckedAt).getTime() : Number.POSITIVE_INFINITY;
  const elapsed = Number.isFinite(lastCheckAge) && lastCheckAge >= 0
    ? lastCheckAge < 60_000 ? 'há menos de 1 min' : `há ${Math.floor(lastCheckAge / 60_000)} min`
    : null;
  const liveLabel = live ? 'Atualizado · Tempo real ativo'
    : lastCheckAge < 30_000 ? 'Reconectando · dados conferidos recentemente'
      : `Dados podem estar desatualizados${elapsed ? ` · última conferência ${elapsed}` : ''}`;
  const shortProjectId = projectId?.slice(0, 8);
  return (
    <div data-app-revision={APP_BUILD.revision} data-app-built-at={APP_BUILD.builtAt} className={cn('flex max-w-[65vw] flex-col items-end text-right text-[11px] leading-tight', cfg.color, className)}>
      <div className="flex items-center gap-1.5 font-medium">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', 'spin' in cfg && cfg.spin && 'animate-spin')} />
        <span>{cfg.text}</span>
      </div>
      {(confirmed || shortProjectId) && (
        <span className="mt-0.5 text-[10px] text-muted-foreground">
          {confirmed ? `Confirmado ${confirmed}` : 'Ainda não confirmado'}{shortProjectId ? ` · Obra ${shortProjectId}` : ''}
        </span>
      )}
      <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
        <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-primary' : 'bg-muted-foreground/50')} />
        {liveLabel}
        {remoteUpdated ? ` · Atualizado por outro usuário ${remoteUpdated}` : ''}
      </span>
      {pendingRemoteAreas.length > 0 && (
        <span className="mt-1 max-w-full rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          Atualizações em outras áreas: {pendingRemoteAreas.join(', ')}
        </span>
      )}
    </div>
  );
}
