import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import type { TaskAdditiveHistoryEntry } from '@/types/project';
import { Flag } from 'lucide-react';

export interface AdditiveBadgeProps {
  originAdditiveId?: string;
  originAdditiveName?: string;
  originAdditiveVersion?: number;
  additiveHistory?: TaskAdditiveHistoryEntry[];
  suppressedByAdditive?: boolean;
  /** Quantidade original conhecida (anterior a qualquer aditivo). Opcional. */
  baseQuantity?: number;
  compact?: boolean;
  className?: string;
}

const fmt = (n: number | undefined | null) =>
  Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
const fmtDate = (iso?: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
};

/**
 * Badge visual para indicar vínculo a aditivos em Tarefas, Cronograma e Medição.
 * Apenas visualização — não altera cálculos.
 */
export function AdditiveBadge({
  originAdditiveId,
  originAdditiveName,
  originAdditiveVersion,
  additiveHistory = [],
  suppressedByAdditive,
  baseQuantity,
  compact = false,
  className = '',
}: AdditiveBadgeProps) {
  const isNew = !!originAdditiveId;
  const all = additiveHistory ?? [];
  if (!isNew && all.length === 0) return null;

  const changes = all.filter(h => h.kind !== 'novo');
  const totalAdded = changes.reduce((s, h) => s + (h.addedQuantity || 0), 0);
  const totalSupp = changes.reduce((s, h) => s + (h.suppressedQuantity || 0), 0);

  let label = 'Aditivo';
  let cls = 'bg-primary/15 text-primary border-primary/30';
  if (isNew) {
    label = 'Novo por Aditivo';
  } else if (suppressedByAdditive || (totalSupp > 0 && totalAdded === 0)) {
    label = 'Supressão por Aditivo';
    cls = 'bg-rose-100 text-rose-700 border-rose-300';
  } else if (totalAdded > 0 && totalSupp === 0) {
    label = 'Acréscimo por Aditivo';
    cls = 'bg-emerald-100 text-emerald-700 border-emerald-300';
  } else if (totalAdded > 0 && totalSupp > 0) {
    label = 'Aditivo (Δ)';
  }

  const latest = all[all.length - 1];
  const firstEntry = all[0];
  const originalQty =
    baseQuantity ??
    (isNew ? 0 : firstEntry?.previousQuantity);
  const finalQty = latest?.newQuantity;
  const headName = originAdditiveName ?? latest?.additiveName;
  const headVersion = originAdditiveVersion ?? latest?.version;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`${compact ? 'inline-flex h-4 w-4 items-center justify-center rounded-full' : 'text-[9px] px-1 py-0.5 rounded'} border font-medium whitespace-nowrap ${cls} ${className}`}
          aria-label={label}
        >
          {compact ? <Flag className="h-2.5 w-2.5" /> : label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <div className="space-y-1">
          {(headName || headVersion !== undefined) && (
            <div className="font-semibold">
              {headName ?? 'Aditivo'}{headVersion !== undefined ? ` · v${headVersion}` : ''}
            </div>
          )}
          {originalQty !== undefined && (
            <div>Qtd. original: <span className="tabular-nums">{fmt(originalQty)}</span></div>
          )}
          <div>Qtd. acrescida: <span className="tabular-nums">{fmt(totalAdded)}</span></div>
          <div>Qtd. suprimida: <span className="tabular-nums">{fmt(totalSupp)}</span></div>
          {finalQty !== undefined && (
            <div>Qtd. final: <span className="tabular-nums font-medium">{fmt(finalQty)}</span></div>
          )}
          {latest?.at && (
            <div className="text-muted-foreground">Integrado em {fmtDate(latest.at)}</div>
          )}
          {suppressedByAdditive && (
            <div className="text-rose-600">Item suprimido (saldo zerado).</div>
          )}
          {all.length > 1 && (
            <div className="pt-1 border-t border-border/50 mt-1 space-y-0.5">
              {all.map((h, i) => (
                <div key={i} className="text-[10px] text-muted-foreground">
                  {h.additiveName} v{h.version}: {fmt(h.previousQuantity)} → {fmt(h.newQuantity)}
                </div>
              ))}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
