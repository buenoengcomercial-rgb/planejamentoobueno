import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AlertCircle, Lock, Pencil, Check, X } from 'lucide-react';
import type { Row } from '@/components/measurement/types';
import { fmtBRL, fmtNum } from '@/components/measurement/measurementFormat';

export interface MeasurementItemRowProps {
  row: Row;
  indentPx: number;
  isLocked: boolean;
  isSnapshotMode: boolean;
  editingPriceTaskId: string | null;
  editingPriceValue: string;
  setEditingPriceTaskId: (id: string | null) => void;
  setEditingPriceValue: (v: string) => void;
  updateUnitPriceNoBDI: (taskId: string, v: number) => void;
  updateTaskField: (taskId: string, patch: Record<string, unknown>) => void;
  patchSnapshotItem: (taskId: string, patch: Record<string, unknown>, fieldLabel: string) => void;
  setManualPeriodQuantity: (taskId: string, v: number) => void;
  G_BG: { id: string; contract: string; period: string; accum: string; balance: string };
  BORDER_L: string;
}

export default function MeasurementItemRow({
  row: r,
  indentPx,
  isLocked,
  isSnapshotMode,
  editingPriceTaskId,
  editingPriceValue,
  setEditingPriceTaskId,
  setEditingPriceValue,
  updateUnitPriceNoBDI,
  updateTaskField,
  patchSnapshotItem,
  setManualPeriodQuantity,
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
        </div>
      </td>
      <td className={`px-2 py-1.5 text-muted-foreground align-top cell-und ${G_BG.id}`}>
        {r.unit}
      </td>

      {/* Contrato */}
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${BORDER_L} ${G_BG.contract}`}>
        {fmtNum(r.qtyContracted)}
      </td>
      <td className={`px-1 py-1 text-right align-top ${G_BG.contract}`} style={{ minWidth: 210, width: 220 }}>
        {editingPriceTaskId === r.taskId ? (
          <div className="flex items-center justify-end gap-1 print:hidden bg-accent/40 rounded px-1 py-0.5 min-w-[210px]">
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">R$</span>
              <Input
                autoFocus
                type="number" step="0.01" min="0"
                value={editingPriceValue}
                placeholder="0,00"
                onChange={e => setEditingPriceValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    updateUnitPriceNoBDI(r.taskId, parseFloat(editingPriceValue) || 0);
                    setEditingPriceTaskId(null);
                  } else if (e.key === 'Escape') {
                    setEditingPriceTaskId(null);
                  }
                }}
                className="h-7 pl-7 pr-2 text-right tabular-nums text-xs w-[150px] min-w-[150px]"
              />
            </div>
            <Button
              type="button" size="icon" variant="ghost"
              className="h-6 w-6 shrink-0 text-success hover:text-success"
              title="Confirmar (Enter)"
              onClick={() => {
                updateUnitPriceNoBDI(r.taskId, parseFloat(editingPriceValue) || 0);
                setEditingPriceTaskId(null);
              }}
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button" size="icon" variant="ghost"
              className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
              title="Cancelar (Esc)"
              onClick={() => setEditingPriceTaskId(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1 print:hidden">
            <span className={`tabular-nums text-[11px] ${r.unitPriceIsEstimated ? 'italic text-muted-foreground' : ''}`}>
              {fmtBRL(r.unitPriceNoBDI || 0)}
            </span>
            {!isLocked && (
              <Button
                type="button" size="icon" variant="ghost"
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                title={r.unitPriceIsEstimated ? 'Preço estimado — clique para editar' : 'Editar valor unitário s/ BDI'}
                onClick={() => {
                  setEditingPriceValue(((r.unitPriceNoBDI || 0)).toFixed(2));
                  setEditingPriceTaskId(r.taskId);
                }}
              >
                <Pencil className="h-3 w-3" />
              </Button>
            )}
            {isLocked && (
              <Lock className="h-3 w-3 text-muted-foreground" aria-label="Medição bloqueada" />
            )}
          </div>
        )}
        <span className="hidden print:inline tabular-nums">{fmtBRL(r.unitPriceNoBDI || 0)}</span>
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${G_BG.contract}`}>
        {fmtBRL(r.unitPriceWithBDI || 0)}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums text-foreground align-top ${G_BG.contract}`}>
        {fmtBRL(r.valueContracted)}
      </td>

      {/* Medição atual */}
      <td className={`px-1 py-1 text-right align-top ${BORDER_L} ${G_BG.period}`}>
        {isSnapshotMode ? (
          <Input
            type="number" step="0.01" min="0"
            value={r.qtyPeriod ? Number(r.qtyPeriod.toFixed(3)) : ''}
            placeholder="0,00"
            disabled={isLocked}
            onChange={e => {
              const v = parseFloat(e.target.value) || 0;
              // Em modo edição liberada de snapshot, ajusta qtyApproved
              patchSnapshotItem(r.taskId, { qtyApproved: v }, 'Quant. medição (aprovada)');
            }}
            className="h-7 px-1.5 text-right tabular-nums text-[11px] border-transparent hover:border-input focus-visible:ring-1 print:hidden"
            title="Quantidade desta medição"
          />
        ) : r.hasNoLogsInPeriod ? (
          <Input
            type="number" step="0.01" min="0"
            value={r.qtyPeriod ? Number(r.qtyPeriod.toFixed(3)) : ''}
            placeholder="0,00"
            onChange={e => setManualPeriodQuantity(r.taskId, parseFloat(e.target.value) || 0)}
            className="h-7 px-1.5 text-right tabular-nums text-[11px] border-warning/50 print:hidden"
            title="Sem apontamento no período — lance manualmente"
          />
        ) : (
          <span className="tabular-nums font-semibold pr-2">{fmtNum(r.qtyPeriod)}</span>
        )}
        <span className="hidden print:inline tabular-nums">{fmtNum(r.qtyPeriod)}</span>
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums font-semibold text-foreground align-top ${G_BG.period}`}>
        {fmtBRL(r.valuePeriod)}
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
