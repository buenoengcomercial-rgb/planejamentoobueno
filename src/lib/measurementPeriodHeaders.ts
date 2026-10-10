import { supabase } from '@/integrations/supabase/client';

export interface MeasurementPeriodHeader {
  id: string;
  number: number;
  startDate: string;
  endDate: string;
  status?: string;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Null means the independent workspace does not exist; an empty array is a valid workspace. */
export async function loadMeasurementPeriodHeaders(projectId: string): Promise<MeasurementPeriodHeader[] | null> {
  const { data, error } = await supabase.rpc('list_measurement_period_headers' as never, {
    p_project_id: projectId,
  } as never);
  if (error) throw new Error(`Não foi possível consultar os períodos da Medição: ${error.message}`);
  if (data === null) return null;
  if (!Array.isArray(data)) throw new Error('Períodos da Medição incompletos.');

  const ids = new Set<string>();
  const numbers = new Set<number>();
  const periods = data.map((value): MeasurementPeriodHeader => {
    const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const { id, number, startDate, endDate, status } = item;
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(number) || (number as number) < 1
      || !validDate(startDate) || !validDate(endDate) || startDate > endDate
      || (status !== undefined && typeof status !== 'string')
      || ids.has(id) || numbers.has(number as number)) {
      throw new Error('Períodos da Medição incompletos ou inconsistentes.');
    }
    ids.add(id);
    numbers.add(number as number);
    return { id, number: number as number, startDate, endDate, ...(status ? { status } : {}) };
  });
  return periods.sort((a, b) => a.number - b.number);
}
