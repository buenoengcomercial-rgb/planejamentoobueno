import { describe, it, expect } from 'vitest';
import {
  computeTaskForecast,
  countOverlapDays,
  getPlannedDailyProduction,
} from './measurementForecast';

// Tarefa: 2025-05-12 (segunda) por 10 dias úteis (sem sábado) → fim 2025-05-23 (sexta)
const baseTask = {
  startDate: '2025-05-12',
  duration: 10,
  quantity: 100,
};

describe('countOverlapDays (dias úteis, sem sábado)', () => {
  it('full overlap = 10 dias úteis', () => {
    expect(countOverlapDays('2025-05-12', '2025-05-23', '2025-05-01', '2025-05-31')).toBe(10);
  });
  it('partial overlap = 5 dias úteis (19→23)', () => {
    expect(countOverlapDays('2025-05-12', '2025-05-23', '2025-05-19', '2025-05-31')).toBe(5);
  });
  it('no overlap', () => {
    expect(countOverlapDays('2025-05-12', '2025-05-23', '2025-06-01', '2025-06-30')).toBe(0);
  });
  it('um único dia útil', () => {
    expect(countOverlapDays('2025-05-12', '2025-05-12', '2025-05-12', '2025-05-12')).toBe(1);
  });
});

describe('getPlannedDailyProduction', () => {
  it('usa qtyContracted / dias úteis quando há datas', () => {
    expect(getPlannedDailyProduction(baseTask as any, 100, false)).toBeCloseTo(10, 5);
  });
  it('fallback baseline quando sem contratação', () => {
    expect(getPlannedDailyProduction({
      baseline: { plannedDailyProduction: 7, startDate: '', endDate: '', duration: 0, capturedAt: '' },
      quantity: 100, duration: 10,
    } as any)).toBe(7);
  });
  it('zero quando vazio', () => {
    expect(getPlannedDailyProduction({} as any)).toBe(0);
  });
});

describe('computeTaskForecast (proporcional ao Gantt)', () => {
  it('tarefa totalmente dentro do período', () => {
    const r = computeTaskForecast({
      task: baseTask as any,
      periodStart: '2025-05-01',
      periodEnd: '2025-05-31',
      qtyContracted: 100,
      unitPriceWithBDI: 12.34,
      unitPriceNoBDI: 10,
    });
    expect(r.plannedDaysInPeriod).toBe(10);
    expect(r.qtyForecast).toBe(100);
    expect(r.valueForecast).toBe(1234);
  });

  it('tarefa parcialmente sobreposta — proporcional', () => {
    const r = computeTaskForecast({
      task: baseTask as any,
      periodStart: '2025-05-19',
      periodEnd: '2025-05-31',
      qtyContracted: 100,
      unitPriceWithBDI: 12.34,
      unitPriceNoBDI: 10,
    });
    // 5 dias úteis de 10 → 50
    expect(r.plannedDaysInPeriod).toBe(5);
    expect(r.qtyForecast).toBe(50);
    expect(r.valueForecast).toBe(617);
  });

  it('tarefa fora do período → zero', () => {
    const r = computeTaskForecast({
      task: baseTask as any,
      periodStart: '2025-06-01',
      periodEnd: '2025-06-30',
      qtyContracted: 100,
      unitPriceWithBDI: 12.34,
      unitPriceNoBDI: 10,
    });
    expect(r.qtyForecast).toBe(0);
    expect(r.valueForecast).toBe(0);
  });

  it('regressão: NÃO lança 100% no primeiro mês de tarefa longa', () => {
    // Administração de Obra: 30/04/2026 → ~15/12/2026 (≈164 dias úteis), 6 MES
    // Período medição: 30/04/2026 a 29/05/2026 (≈21 dias úteis)
    // Esperado: 6 * (21/164) ≈ 0,76 — muito menor que 6
    const r = computeTaskForecast({
      task: { startDate: '2026-04-30', duration: 164, quantity: 6 } as any,
      periodStart: '2026-04-30',
      periodEnd: '2026-05-29',
      qtyContracted: 6,
      unitPriceWithBDI: 1000,
      unitPriceNoBDI: 800,
    });
    expect(r.qtyForecast).toBeLessThan(6);
    expect(r.qtyForecast).toBeGreaterThan(0);
  });

  it('tarefa de 1 dia dentro do período → tudo', () => {
    const r = computeTaskForecast({
      task: { startDate: '2025-05-12', duration: 1, quantity: 1 } as any,
      periodStart: '2025-05-01',
      periodEnd: '2025-05-31',
      qtyContracted: 1,
      unitPriceWithBDI: 100,
      unitPriceNoBDI: 80,
    });
    expect(r.qtyForecast).toBe(1);
    expect(r.valueForecast).toBe(100);
  });

  it('tarefa de 1 dia fora do período → zero', () => {
    const r = computeTaskForecast({
      task: { startDate: '2025-05-12', duration: 1, quantity: 1 } as any,
      periodStart: '2025-06-01',
      periodEnd: '2025-06-30',
      qtyContracted: 1,
      unitPriceWithBDI: 100,
      unitPriceNoBDI: 80,
    });
    expect(r.qtyForecast).toBe(0);
  });

  it('limita ao qtyContracted', () => {
    const r = computeTaskForecast({
      task: { startDate: '2025-05-12', duration: 10, quantity: 100 } as any,
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      qtyContracted: 30,
      unitPriceWithBDI: 10,
      unitPriceNoBDI: 8,
    });
    expect(r.qtyForecast).toBe(30);
    expect(r.valueForecast).toBe(300);
  });
});
