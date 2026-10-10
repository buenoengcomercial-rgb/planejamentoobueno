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
  concludeDailyReport: () => void;
  reopenDailyReport: () => void;
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
  const [selectedDate, setSelectedDate] = useState<string>(initialDate || todayISO());
  // O Diário deve abrir com acesso a todas as datas, mesmo que exista uma
  // medição em preparação com um período antigo no projeto.
  const [measurementFilter, setMeasurementFilter] = useState<string>(initialMeasurementFilter || 'all');

  // Sincroniza filtro/data vindos da Medição. Depende de navKey para re-aplicar mesmo
  // quando os mesmos valores são enviados de novo (ex.: clicar 2x em "Ver no Diário").
  useEffect(() => {
    if (initialMeasurementFilter) setMeasurementFilter(initialMeasurementFilter);
    if (initialDate) setSelectedDate(initialDate);
  }, [initialMeasurementFilter, initialDate, navKey]);

  const currentReport: DailyReportEntry = useMemo(() => {
    const found = (project.dailyReports || [])
      .filter(r => r.date === selectedDate)
      .reduce<DailyReportEntry | undefined>((latest, report) => pickLatestDailyReport(latest, report), undefined);
    if (found) return found;
    return createBlankDailyReport(selectedDate);
  }, [project.dailyReports, selectedDate]);

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

  const concludeDailyReport = useCallback(() => {
    persist(report => ({ ...report, concludedAt: new Date().toISOString() }));
  }, [persist]);

  const reopenDailyReport = useCallback(() => {
    persist(report => {
      const { concludedAt: _concludedAt, concludedBy: _concludedBy, ...editable } = report;
      return editable;
    });
  }, [persist]);

  return {
    selectedDate,
    setSelectedDate,
    measurementFilter,
    setMeasurementFilter,
    currentReport,
    persist,
    updateField,
    clearDailyReport,
    concludeDailyReport,
    reopenDailyReport,
  };
}
