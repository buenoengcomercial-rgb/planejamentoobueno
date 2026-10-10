type PeriodDates = { number: number; startDate: string; endDate: string };

/** The first period is configured explicitly; subsequent periods contain 30 calendar days. */
export function nextMeasurementPeriod(periods: readonly PeriodDates[]): PeriodDates | null {
  const previous = [...periods].sort((a, b) => b.number - a.number)[0];
  if (!previous) return null;
  const end = new Date(`${previous.endDate}T00:00:00Z`);
  if (!Number.isSafeInteger(previous.number) || previous.number < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(previous.endDate) || !Number.isFinite(end.getTime()) || end.toISOString().slice(0, 10) !== previous.endDate) throw new Error('Confira o período da medição anterior.');
  end.setUTCDate(end.getUTCDate() + 1);
  const startDate = end.toISOString().slice(0, 10);
  end.setUTCDate(end.getUTCDate() + 29);
  return { number: previous.number + 1, startDate, endDate: end.toISOString().slice(0, 10) };
}
