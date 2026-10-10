import { renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import type { Project } from '@/types/project';
import { useDailyReportState } from './useDailyReportState';

const project = {
  measurementDraft: { number: 1, startDate: '2026-08-24', endDate: '2026-09-22' },
  dailyReports: [],
} as unknown as Project;

describe('useDailyReportState', () => {
  it('não restringe o Diário ao período antigo da Medição por padrão', () => {
    const { result } = renderHook(() => useDailyReportState({
      project,
      onProjectChange: vi.fn(),
    }));

    expect(result.current.measurementFilter).toBe('all');
  });

  it('respeita o filtro pedido ao abrir o Diário pela Medição', () => {
    const { result } = renderHook(() => useDailyReportState({
      project,
      onProjectChange: vi.fn(),
      initialMeasurementFilter: 'draft',
    }));

    expect(result.current.measurementFilter).toBe('draft');
  });
});
