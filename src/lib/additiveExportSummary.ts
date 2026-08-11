/** Campos financeiros exibidos no rodape de todos os relatorios de Aditivo. */
export interface AdditiveExportSummaryTotals {
  totalContratadoOriginal: number;
  totalSuprimido: number;
  percentSupressao: number;
  totalAcrescido: number;
  percentAcrescimo: number;
  valorFinal: number;
}

export type AdditiveExportSummaryKind = 'money' | 'percent' | 'suppressed' | 'added' | 'final';

export interface AdditiveExportSummaryEntry {
  label: string;
  value: number;
  kind: AdditiveExportSummaryKind;
}

/**
 * Mantem a ordem e o sinal do quadro final independentes do formato exportado.
 * A supressao e negativa somente para apresentacao; o motor financeiro a guarda
 * como valor absoluto para os calculos do aditivo.
 */
export function getAdditiveExportSummary(
  totals: AdditiveExportSummaryTotals,
): AdditiveExportSummaryEntry[] {
  return [
    { label: 'Valor do contrato', value: totals.totalContratadoOriginal, kind: 'money' },
    { label: 'Total suprimido', value: -totals.totalSuprimido, kind: 'suppressed' },
    { label: '% suprimido', value: totals.percentSupressao, kind: 'percent' },
    { label: 'Total acrescido', value: totals.totalAcrescido, kind: 'added' },
    { label: '% acrescido', value: totals.percentAcrescimo, kind: 'percent' },
    { label: 'Valor final', value: totals.valorFinal, kind: 'final' },
  ];
}
