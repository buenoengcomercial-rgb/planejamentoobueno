import { describe, it, expect } from 'vitest';
import {
  computeTaskForecast,
  countOverlapDays,
  getPlannedDailyProduction,
} from './measurementForecast';

const baseTask = {
  startDate: '2025-05-10',
  duration: 10, // 2025-05-10 → 2025-05-19
  quantity: 100,
};

describe('countOverlapDays', () => {
  it('full overlap', () => {
    expect(countOverlapDays('2025-05-10', '2025-05-19', '2025-05-01', '2025-05-31')).toBe(10);
  });
  it('partial overlap', () => {
    expect(countOverlapDays('2025-05-10', '2025-05-19', '2025-05-15', '2025-05-31')).toBe(5);
  });
  it('no overlap', () => {
    expect(countOverlapDays('2025-05-10', '2025-05-19', '2025-06-01', '2025-06-30')).toBe(0);
  });
  it('single day overlap', () => {
    expect(countOverlapDays('2025-05-10', '2025-05-10', '2025-05-10', '2025-05-10')).toBe(1);
  });
});

describe('getPlannedDailyProduction', () => {
  it('prefers baseline.plannedDailyProduction', () => {
    expect(getPlannedDailyProduction({
      baseline: { plannedDailyProduction: 7, startDate: '', endDate: '', duration: 0, capturedAt: '' },
      quantity: 100, duration: 10,
    } as any)).toBe(7);
  });
  it('falls back to quantity/duration', () => {
    expect(getPlannedDailyProduction({ quantity: 100, duration: 10 } as any)).toBe(10);
  });
  it('returns 0 when missing', () => {
    expect(getPlannedDailyProduction({} as any)).toBe(0);
  });
});

describe('computeTaskForecast', () => {
  it('task fully inside period', () => {
    const r = computeTaskForecast({
      task: baseTask as any,
      periodStart: '2025-05-01',
      periodEnd: '2025-05-31',
      qtyContracted: 100,
      unitPriceWithBDI: 12.34,
      unitPriceNoBDI: 10,
    });
    expect(r.plannedDaysInPeriod).toBe(10);
    expect(r.qtyForecast).toBe(100); // 10 * 10
    expect(r.valueForecast).toBe(1234); // 12.34 * 100
  });

  it('task partially overlapping', () => {
    const r = computeTaskForecast({
      task: baseTask as any,
      periodStart: '2025-05-15',
      periodEnd: '2025-05-31',
      qtyContracted: 100,
      unitPriceWithBDI: 12.34,
      unitPriceNoBDI: 10,
    });
    expect(r.plannedDaysInPeriod).toBe(5);
    expect(r.qtyForecast).toBe(50);
    expect(r.valueForecast).toBe(617); // 12.34 * 50
  });

  it('task outside period → zero', () => {
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

  it('caps at qtyContracted', () => {
    const r = computeTaskForecast({
      task: { ...baseTask, duration: 100 } as any, // 100 days * 1/day if quantity=100 dur=100? use baseline
      periodStart: '2025-05-01',
      periodEnd: '2025-12-31',
      qtyContracted: 30,
      unitPriceWithBDI: 10,
      unitPriceNoBDI: 8,
    });
    expect(r.qtyForecast).toBe(30);
    expect(r.valueForecast).toBe(300);
  });

  it('truncates to 2 decimals', () => {
    const r = computeTaskForecast({
      task: { startDate: '2025-05-10', duration: 3, quantity: 10 } as any, // daily = 3.3333
      periodStart: '2025-05-10',
      periodEnd: '2025-05-10', // 1 dia
      qtyContracted: 10,
      unitPriceWithBDI: 1,
      unitPriceNoBDI: 1,
    });
    expect(r.qtyForecast).toBe(3.33);
    expect(r.valueForecast).toBe(3.33);
  });
});
