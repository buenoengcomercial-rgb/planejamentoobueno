import { describe, expect, it } from 'vitest';
import { nextMeasurementPeriod } from './measurementPeriodSequence';

describe('períodos consecutivos de 30 dias', () => {
  it('preserva a primeira medição excepcional e calcula as próximas sem lacunas', () => {
    const periods = [{ number: 1, startDate: '2026-08-24', endDate: '2026-09-29' }];
    const original = structuredClone(periods);
    const second = nextMeasurementPeriod(periods)!;
    expect(second).toEqual({ number: 2, startDate: '2026-09-30', endDate: '2026-10-29' });
    const third = nextMeasurementPeriod([...periods, second])!;
    expect(third).toEqual({ number: 3, startDate: '2026-10-30', endDate: '2026-11-28' });
    expect(nextMeasurementPeriod([...periods, second, third])).toEqual({ number: 4, startDate: '2026-11-29', endDate: '2026-12-28' });
    expect(periods).toEqual(original);
  });
  it.each([
    ['2026-12-19', '2026-12-20', '2027-01-18'],
    ['2028-01-30', '2028-01-31', '2028-02-29'],
    ['2027-01-30', '2027-01-31', '2027-03-01'],
  ])('atravessa meses e anos a partir de %s', (endDate, nextStart, nextEnd) => {
    expect(nextMeasurementPeriod([{ number: 1, startDate: '2026-01-01', endDate }])).toEqual({ number: 2, startDate: nextStart, endDate: nextEnd });
  });
  it('não inventa o primeiro período nem aceita data inválida', () => {
    expect(nextMeasurementPeriod([])).toBeNull();
    expect(() => nextMeasurementPeriod([{ number: 1, startDate: '2026-01-01', endDate: '2026-02-30' }])).toThrow('período');
  });
});
