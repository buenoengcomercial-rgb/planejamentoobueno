import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project, DailyReport as DailyReportEntry } from '@/types/project';
import { todayISO, uid } from '@/components/dailyReport/dailyReportFormat';
import { isDailyReportEmpty, pickLatestDailyReport } from '@/lib/dailyReportSummary';

interface UseDailyReportStateArgs {
  project: Project;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
  initialDate?: string;
  initialMeasurementFilter?: string;
  navKey?: number;
}

export interface UseDailyReportStateResult {
  selectedDate: string;
  setSelectedDate: (date: string) => void;
  measurementFilter: string;
  setMeasurementFilter: (f: string) => void;
  currentReport: DailyReportEntry;
  persist: (mutator: (r: DailyReportEntry) => DailyReportEntry) => void;
  updateField: <K extends keyof DailyReportEntry>(key: K, value: DailyReportEntry[K]) => void;
  clearDailyReport: () => void;
}

function createBlankDailyReport(date: string): DailyReportEntry {
  const now = new Date().toISOString();
  return {
    id: uid('dr'),
    date,
    teamsPresent: [],
    equipment: [],
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function useDailyReportState({
  project,
  onProjectChange,
  initialDate,
  initialMeasurementFilter,
  navKey,
}: UseDailyReportStateArgs): UseDailyReportStateResult {
  // Default inteligente: se nada veio externo, mas existe medição em preparação, abrir já filtrado por ela.
  const hasDraft = !!(project.measurementDraft?.startDate && project.measurementDraft?.endDate);
  const defaultFilter = initialMeasurementFilter || (hasDraft ? 'draft' : 'all');

  const [selectedDate, setSelectedDate] = useState<string>(initialDate || todayISO());
  const [measurementFilter, setMeasurementFilter] = useState<string>(defaultFilter);

  // Sincroniza filtro/data vindos da Medição. Depende de navKey para re-aplicar mesmo
  // quando os mesmos valores são enviados de novo (ex.: clicar 2x em "Ver no Diário").
  useEffect(() => {
    if (initialMeasurementFilter) setMeasurementFilter(initialMeasurementFilter);
    if (initialDate) setSelectedDate(initialDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMeasurementFilter, initialDate, navKey]);

  const reports = project.dailyReports || [];

  const currentReport: DailyReportEntry = useMemo(() => {
    const found = reports
      .filter(r => r.date === selectedDate)
      .reduce<DailyReportEntry | undefined>((latest, report) => pickLatestDailyReport(latest, report), undefined);
    if (found) return found;
    return createBlankDailyReport(selectedDate);
  }, [reports, selectedDate]);

  const persist = useCallback((mutator: (r: DailyReportEntry) => DailyReportEntry) => {
    onProjectChange(prev => {
      const list = prev.dailyReports || [];
      const reportsForDate = list.filter(r => r.date === selectedDate);
      const base = reportsForDate.reduce<DailyReportEntry | undefined>(
        (latest, report) => pickLatestDailyReport(latest, report),
        undefined,
      ) || createBlankDailyReport(selectedDate);
      const updated: DailyReportEntry = { ...mutator(base), date: selectedDate, updatedAt: new Date().toISOString() };
      const listWithoutDate = list.filter(r => r.date !== selectedDate);
      const nextList = isDailyReportEmpty(updated) ? listWithoutDate : [...listWithoutDate, updated];
      return { ...prev, dailyReports: nextList };
    });
  }, [onProjectChange, selectedDate]);

  const updateField = useCallback(<K extends keyof DailyReportEntry>(key: K, value: DailyReportEntry[K]) => {
    persist(r => ({ ...r, [key]: value }));
  }, [persist]);

  const clearDailyReport = useCallback(() => {
    onProjectChange(prev => ({
      ...prev,
      dailyReports: (prev.dailyReports || []).filter(r => r.date !== selectedDate),
    }));
  }, [onProjectChange, selectedDate]);

  return {
    selectedDate,
    setSelectedDate,
    measurementFilter,
    setMeasurementFilter,
    currentReport,
    persist,
    updateField,
    clearDailyReport,
  };
}
