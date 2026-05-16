import { AlertCircle, Lock } from 'lucide-react';
import type { Row } from '@/components/measurement/types';
import { fmtBRL, fmtNum } from '@/components/measurement/measurementFormat';
import { AdditiveBadge } from '@/components/shared/AdditiveBadge';

export interface MeasurementItemRowProps {
  row: Row;
  indentPx: number;
  isLocked: boolean;
  isSnapshotMode: boolean;
  // Handlers abaixo são mantidos para compatibilidade da assinatura, mas a
  // tela de Medição é somente leitura para dados contratados e quantidades
  // medidas. Edição de preço unitário e quantidade do período não é mais
  // permitida — todos os valores vêm da Sintética importada e dos
  // apontamentos da EAP/Tarefas/Diário de Obra.
  editingPriceTaskId?: string | null;
  editingPriceValue?: string;
  setEditingPriceTaskId?: (id: string | null) => void;
  setEditingPriceValue?: (v: string) => void;
  updateUnitPriceNoBDI?: (taskId: string, v: number) => void;
  updateTaskField?: (taskId: string, patch: Record<string, unknown>) => void;
  patchSnapshotItem?: (taskId: string, patch: Record<string, unknown>, fieldLabel: string) => void;
  setManualPeriodQuantity?: (taskId: string, v: number) => void;
  G_BG: { id: string; contract: string; period: string; forecast?: string; accum: string; balance: string };
  BORDER_L: string;
}

export default function MeasurementItemRow({
  row: r,
  indentPx,
  isLocked,
  G_BG,
  BORDER_L,
}: MeasurementItemRowProps) {
  const baseBg = r.hasNoLogsInPeriod ? 'bg-warning/5' : 'bg-background';
  const stickyBg = r.hasNoLogsInPeriod ? 'bg-warning/5' : 'bg-background';

  return (
    <tr className={`border-b border-border/60 hover:bg-muted/30 ${baseBg}`}>
      {/* Identificação */}
      <td
        className={`px-2 py-1.5 font-mono tabular-nums text-foreground align-top ${stickyBg}`}
        style={{ paddingLeft: indentPx + 8 }}
      >
        {r.item}
      </td>
      <td className={`px-1 py-1 align-top text-center ${stickyBg}`}>
        <span className="block text-[11px] font-mono tabular-nums text-foreground">
          {r.itemCode || '—'}
        </span>
      </td>
      <td className={`px-1 py-1 align-top text-center ${stickyBg}`}>
        <span className="block text-[11px] font-mono tabular-nums text-foreground">
          {r.priceBank || '—'}
        </span>
      </td>
      <td className={`px-2 py-1.5 text-foreground align-top cell-desc ${stickyBg}`}>
        <div className="flex items-start gap-1.5">
          {r.hasNoLogsInPeriod && (
            <AlertCircle
              className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5 print:hidden"
              aria-label="Sem apontamento no período"
            />
          )}
          <span className="leading-snug break-words">{r.description}</span>
          <AdditiveBadge
            originAdditiveId={r.originAdditiveId}
            originAdditiveName={r.originAdditiveName}
            originAdditiveVersion={r.originAdditiveVersion}
            additiveHistory={r.additiveHistory}
            suppressedByAdditive={r.suppressedByAdditive}
            baseQuantity={r.qtyContracted}
            className="shrink-0 mt-0.5"
          />
        </div>
      </td>
      <td className={`px-2 py-1.5 text-muted-foreground align-top cell-und ${G_BG.id}`}>
        {r.unit}
      </td>

      {/* Contrato */}
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${BORDER_L} ${G_BG.contract}`}>
        {fmtNum(r.qtyContracted)}
      </td>
      <td className={`px-2 py-1.5 text-right align-top ${G_BG.contract}`}>
        <div className="flex items-center justify-end gap-1">
          <span className={`tabular-nums text-[11px] ${r.unitPriceIsEstimated ? 'italic text-muted-foreground' : ''}`}>
            {fmtBRL(r.unitPriceNoBDI || 0)}
          </span>
          {isLocked && (
            <Lock className="h-3 w-3 text-muted-foreground print:hidden" aria-label="Medição bloqueada" />
          )}
        </div>
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${G_BG.contract}`}>
        {fmtBRL(r.unitPriceWithBDI || 0)}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${G_BG.contract}`}>
        {fmtBRL(r.valueContracted)}
      </td>

      {/* Medição atual — somente leitura, vem dos apontamentos da EAP/Diário */}
      <td
        className={`px-2 py-1.5 text-right tabular-nums align-top ${BORDER_L} ${G_BG.period} ${
          r.hasNoLogsInPeriod ? 'text-muted-foreground' : 'font-semibold text-foreground'
        }`}
        title={r.hasNoLogsInPeriod ? 'Sem apontamento no período — lance produção em Tarefas/EAP/Diário de Obra' : undefined}
      >
        {fmtNum(r.qtyPeriod || 0)}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums font-semibold text-foreground align-top ${G_BG.period}`}>
        {fmtBRL(r.valuePeriod)}
      </td>

      {/* Previsão (Gantt) — somente leitura, recalcula com mudanças no cronograma */}
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${BORDER_L} ${G_BG.forecast || 'bg-accent/20'}`}>
        {fmtNum(r.qtyForecast || 0)}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${G_BG.forecast || 'bg-accent/20'}`}>
        {fmtBRL(r.valueForecast || 0)}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums align-top ${G_BG.forecast || 'bg-accent/20'} ${
        (r.diffForecastVsReal || 0) > 0 ? 'text-success font-semibold'
        : (r.diffForecastVsReal || 0) < 0 ? 'text-destructive font-semibold'
        : 'text-muted-foreground'
      }`}>
        {fmtBRL(r.diffForecastVsReal || 0)}
      </td>

      {/* Acumulado */}
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${BORDER_L} ${G_BG.accum}`}>
        {fmtNum(r.qtyCurrentAccum)}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${G_BG.accum}`}>
        {fmtBRL(r.valueAccum)}
      </td>

      {/* Saldo */}
      <td className={`px-2 py-1.5 text-right tabular-nums text-muted-foreground align-top ${BORDER_L} ${G_BG.balance}`}>
        {fmtNum(r.qtyBalance)}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums text-muted-foreground align-top ${G_BG.balance}`}>
        {fmtBRL(r.valueBalance)}
      </td>
    </tr>
  );
}
