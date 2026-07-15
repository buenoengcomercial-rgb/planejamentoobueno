import type { MeasurementStatus, TaskAdditiveHistoryEntry } from '@/types/project';

// ───────────────────────── Tipos internos ─────────────────────────
export interface Row {
  item: string;
  phaseId: string;
  phaseChain: string;
  syntheticChapterCode?: string;
  syntheticChapterName?: string;
  syntheticSubchapterCode?: string;
  syntheticSubchapterName?: string;
  taskId: string;
  description: string;
  unit: string;
  itemCode: string;
  priceBank: string;
  qtyContracted: number;
  qtyPriorAccum: number;
  /** Quantidade efetivamente medida no período (proposed por padrão; approved se houver). */
  qtyPeriod: number;
  qtyProposed: number;
  qtyApproved?: number;
  qtyCurrentAccum: number;
  qtyBalance: number;
  percentExecuted: number;
  unitPriceNoBDI: number;
  unitPriceWithBDI: number;
  unitPriceIsEstimated: boolean;
  valueContractedNoBDI: number;
  valuePeriodNoBDI: number;
  valueAccumNoBDI: number;
  valueBalanceNoBDI: number;
  valueContracted: number;
  valuePeriod: number;
  valueAccum: number;
  valueBalance: number;
  // ─────── Previsão (baseada no Cronograma/Gantt; não altera medição real) ───────
  qtyForecast: number;
  valueForecast: number;
  valueForecastNoBDI: number;
  /** Subtotal real - Subtotal previsto (positivo = real superou previsto). */
  diffForecastVsReal: number;
  hasNoLogsInPeriod: boolean;
  hasNoLogsAtAll: boolean;
  // ─────── Indicadores de aditivo (apenas visualização) ───────
  originAdditiveId?: string;
  originAdditiveName?: string;
  originAdditiveVersion?: number;
  additiveHistory?: TaskAdditiveHistoryEntry[];
  suppressedByAdditive?: boolean;
  notes?: string;
}

export interface GroupTotals {
  contracted: number;
  period: number;
  accum: number;
  balance: number;
  contractedNoBDI: number;
  periodNoBDI: number;
  accumNoBDI: number;
  balanceNoBDI: number;
  qtyContracted: number;
  qtyAccum: number;
  // Previsão
  forecast: number;
  forecastNoBDI: number;
  diffForecast: number;
  pctPeriod?: number;
  pctAccum?: number;
  pctBalance?: number;
}

export interface GroupNode {
  phaseId: string;
  number: string;
  name: string;
  depth: number;
  rows: Row[];
  children: GroupNode[];
  totals: GroupTotals;
}

export const STATUS_LABEL: Record<MeasurementStatus, string> = {
  draft: 'Rascunho',
  generated: 'Previsão',
  in_review: 'Enviada p/ Fiscal',
  approved: 'Aprovada',
  rejected: 'Reprovada / Ajustar',
};

export const STATUS_DESCRIPTION: Record<MeasurementStatus, string> = {
  draft: 'Rascunho',
  generated: 'Atualiza com apontamentos e Gantt',
  in_review: 'Snapshot enviado para fiscalização',
  rejected: 'Liberar edição mediante justificativa',
  approved: 'Medição aprovada e congelada',
};

export const STATUS_CLASS: Record<MeasurementStatus, string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  generated: 'bg-info/15 text-info border-info/40',
  in_review: 'bg-warning/15 text-warning border-warning/40',
  approved: 'bg-success/15 text-success border-success/40',
  rejected: 'bg-destructive/15 text-destructive border-destructive/40',
};

/** Status que mantêm o snapshot congelado (in_review/approved sempre; rejected enquanto edição não liberada). */
export const isLockedStatus = (s: MeasurementStatus, editUnlocked?: boolean) =>
  s === 'in_review' || s === 'approved' || (s === 'rejected' && !editUnlocked);
