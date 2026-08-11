import { describe, expect, it } from 'vitest';
import { getAdditiveExportSummary } from './additiveExportSummary';

describe('getAdditiveExportSummary', () => {
  it('preserva a ordem de leitura e apresenta a supressao com sinal negativo', () => {
    const summary = getAdditiveExportSummary({
      totalContratadoOriginal: 1000,
      totalSuprimido: 125,
      percentSupressao: 0.125,
      totalAcrescido: 260,
      percentAcrescimo: 0.26,
      valorFinal: 1135,
    });

    expect(summary.map(entry => entry.label)).toEqual([
      'Valor do contrato', 'Total suprimido', '% suprimido',
      'Total acrescido', '% acrescido', 'Valor final',
    ]);
    expect(summary.map(entry => entry.value)).toEqual([1000, -125, 0.125, 260, 0.26, 1135]);
  });
});
