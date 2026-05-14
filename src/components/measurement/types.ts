import type { MeasurementStatus } from '@/types/project';

// ───────────────────────── Tipos internos ─────────────────────────
export interface Row {
  item: string;
  phaseId: string;
  phaseChain: string;
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
  in_review: 'Em análise fiscal',
  approved: 'Aprovada',
  rejected: 'Reprovada / Ajustar',
};

export const STATUS_CLASS: Record<MeasurementStatus, string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  generated: 'bg-info/15 text-info border-info/40',
  in_review: 'bg-warning/15 text-warning border-warning/40',
  approved: 'bg-success/15 text-success border-success/40',
  rejected: 'bg-destructive/15 text-destructive border-destructive/40',
};

export const isLockedStatus = (s: MeasurementStatus) =>
  s === 'in_review' || s === 'approved';
