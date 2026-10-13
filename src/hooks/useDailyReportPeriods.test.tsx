import { renderHook } from '@testing-library/react';
import type { Project } from '@/types/project';
import { useDailyReportPeriods } from './useDailyReportPeriods';

describe('useDailyReportPeriods', () => {
  it('inclui todas as datas previstas da medição selecionada no PDF do período', () => {
    const project = {
      phases: [],
      measurements: [{ id: 'measurement-1', number: 1, startDate: '2026-09-29', endDate: '2026-10-02' }],
      dailyReports: [{ id: 'report-1', date: '2026-09-29', responsible: 'Equipe' }],
    } as unknown as Project;

    const { result } = renderHook(() => useDailyReportPeriods({
      project,
      selectedDate: '2026-09-29',
      measurementFilter: 'measurement-1',
    }));

    expect(result.current.activePeriod?.label).toBe('Medição Nº 1');
    expect(result.current.periodDates).toEqual([
      '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02',
    ]);
    expect(result.current.periodSummary?.filledReports).toBe(1);
  });
});
