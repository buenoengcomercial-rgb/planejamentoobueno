import { Cloud, CloudOff, Loader2, Check, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SaveStatus = 'idle' | 'saving' | 'updating' | 'saved' | 'conflict' | 'offline' | 'error';

interface Props {
  status: SaveStatus;
  className?: string;
  confirmedAt?: string | null;
  projectId?: string;
  live?: boolean;
  remoteUpdateAt?: string | null;
}

function timeLabel(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export default function SaveStatusIndicator({ status, className, confirmedAt, projectId, live, remoteUpdateAt }: Props) {
  const map = {
    idle:   { icon: Cloud,   text: 'Pronto',          color: 'text-muted-foreground' },
    saving: { icon: Loader2, text: 'Salvando...',     color: 'text-muted-foreground', spin: true },
    updating: { icon: RefreshCw, text: 'Atualizando dados...', color: 'text-primary', spin: true },
    saved:  { icon: Check,   text: 'Salvo e conferido na nuvem',  color: 'text-primary' },
    conflict: { icon: TriangleAlert, text: 'Atualização em outro aparelho', color: 'text-warning' },
    offline: { icon: WifiOff, text: 'Sem internet', color: 'text-warning' },
    error:  { icon: CloudOff, text: 'Falha na sincronização', color: 'text-destructive' },
  } as const;
  const cfg = map[status];
  const Icon = cfg.icon;
  const confirmed = timeLabel(confirmedAt);
  const remoteUpdated = timeLabel(remoteUpdateAt);
  const shortProjectId = projectId?.slice(0, 8);
  return (
    <div className={cn('flex max-w-[65vw] flex-col items-end text-right text-[11px] leading-tight', cfg.color, className)}>
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
        {live ? 'Tempo real ativo' : 'Tempo real reconectando'}
        {remoteUpdated ? ` · Atualizado por outro usuário ${remoteUpdated}` : ''}
      </span>
    </div>
  );
}
