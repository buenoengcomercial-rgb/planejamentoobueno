import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import type { Project } from '@/types/project';
import { loadMeasurementPeriodHeaders } from '@/lib/measurementPeriodHeaders';
import { useDailyReportPeriods } from './useDailyReportPeriods';

vi.mock('@/lib/measurementPeriodHeaders', () => ({ loadMeasurementPeriodHeaders: vi.fn() }));

const project = {
  id: 'project-1',
  phases: [],
  dailyReports: [],
  measurementDraft: { number: 1, startDate: '2026-08-24', endDate: '2026-09-22' },
} as unknown as Project;

beforeEach(() => vi.resetAllMocks());

describe('períodos do Diário de Obra', () => {
  it('usa a 1ª e a 2ª medições independentes, sem truncar a primeira pelo rascunho antigo', async () => {
    vi.mocked(loadMeasurementPeriodHeaders).mockResolvedValue([
      { id: 'draft:1:2026-08-24:2026-09-22', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'draft' },
      { id: 'second', number: 2, startDate: '2026-09-30', endDate: '2026-10-29', status: 'draft' },
    ]);
    const { result, rerender } = renderHook(
      ({ date, filter }) => useDailyReportPeriods({ project, selectedDate: date, measurementFilter: filter }),
      { initialProps: { date: '2026-09-28', filter: 'draft' } },
    );

    await waitFor(() => expect(result.current.measurementPeriods).toHaveLength(2));
    expect(result.current.activePeriod?.endDate).toBe('2026-09-29');
    expect(result.current.periodDates.at(-1)).toBe('2026-09-29');
    expect(result.current.dateMembership?.label).toBe('Medição Nº 1');

    rerender({ date: '2026-10-15', filter: 'second' });
    expect(result.current.activePeriod?.number).toBe(2);
    expect(result.current.dateMembership?.label).toBe('Medição Nº 2');
    expect(result.current.periodSummary?.startDate).toBe('2026-09-30');
    expect(result.current.periodSummary?.endDate).toBe('2026-10-29');
  });

  it('consulta a estrutura antiga somente quando a Medição independente não existe', async () => {
    vi.mocked(loadMeasurementPeriodHeaders).mockResolvedValue(null);
    const { result } = renderHook(() => useDailyReportPeriods({
      project, selectedDate: '2026-09-20', measurementFilter: 'draft',
    }));
    await waitFor(() => expect(result.current.measurementPeriods).toHaveLength(1));
    expect(result.current.activePeriod?.endDate).toBe('2026-09-22');
  });

  it('não substitui um erro na leitura da base independente por datas antigas', async () => {
    vi.mocked(loadMeasurementPeriodHeaders).mockRejectedValue(new Error('Consulta indisponível'));
    const { result } = renderHook(() => useDailyReportPeriods({
      project, selectedDate: '2026-10-09', measurementFilter: 'draft',
    }));
    await waitFor(() => expect(result.current.periodLoadError).toBe('Consulta indisponível'));
    expect(result.current.measurementPeriods).toEqual([]);
    expect(result.current.activePeriod).toBeNull();
  });
});
