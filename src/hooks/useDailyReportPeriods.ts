import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@/types/project';
import { loadMeasurementPeriodHeaders, type MeasurementPeriodHeader } from '@/lib/measurementPeriodHeaders';
import {
  summarizeDailyReportsForPeriod,
  type DailyReportPeriodSummary,
} from '@/lib/dailyReportSummary';

export interface MeasurementPeriod {
  id: string;
  label: string;
  number: number;
  startDate: string;
  endDate: string;
  status?: string;
}

export type DateMembership =
  | { kind: 'generated'; label: string }
  | { kind: 'draft'; label: string }
  | null;

interface UseDailyReportPeriodsArgs {
  project: Project;
  selectedDate: string;
  measurementFilter: string;
}

export interface UseDailyReportPeriodsResult {
  measurementPeriods: MeasurementPeriod[];
  activePeriod: MeasurementPeriod | null;
  periodDates: string[];
  dateMembership: DateMembership;
  periodSummary: DailyReportPeriodSummary | null;
  periodLoadError: string | null;
}

interface PeriodSource {
  projectId: string;
  periods: MeasurementPeriodHeader[] | null;
  error: string | null;
}

export function useDailyReportPeriods({
  project,
  selectedDate,
  measurementFilter,
}: UseDailyReportPeriodsArgs): UseDailyReportPeriodsResult {
  const [source, setSource] = useState<PeriodSource | null>(null);

  useEffect(() => {
    let active = true;
    void loadMeasurementPeriodHeaders(project.id).then(periods => {
      if (active) setSource({ projectId: project.id, periods, error: null });
    }).catch(error => {
      if (active) setSource({
        projectId: project.id,
        periods: null,
        error: error instanceof Error ? error.message : 'Não foi possível consultar os períodos da Medição.',
      });
    });
    return () => { active = false; };
  }, [project.id]);

  // Uma base independente existente é a única fonte dos períodos. A estrutura
  // antiga da obra serve apenas a projetos ainda não incorporados.
  const measurementPeriods = useMemo<MeasurementPeriod[]>(() => {
    if (!source || source.projectId !== project.id || source.error) return [];
    if (source.periods !== null) return source.periods.map(period => ({
      ...period,
      label: `Medição Nº ${period.number}`,
    }));
    const list: MeasurementPeriod[] = [];
    (project.measurements || []).slice().sort((a, b) => a.number - b.number).forEach(m => {
      list.push({
        id: m.id,
        label: `Medição Nº ${m.number}`,
        number: m.number,
        startDate: m.startDate,
        endDate: m.endDate,
        status: m.status,
      });
    });
    const draft = project.measurementDraft;
    if (draft?.startDate && draft?.endDate) {
      list.push({
        id: 'draft',
        label: `Medição em preparação (Nº ${draft.number})`,
        number: draft.number,
        startDate: draft.startDate,
        endDate: draft.endDate,
        status: 'draft',
      });
    }
    return list;
  }, [project.id, project.measurements, project.measurementDraft, source]);

  const activePeriod = useMemo(
    () => {
      const exact = measurementPeriods.find(p => p.id === measurementFilter);
      if (exact) return exact;
      // Links antigos usam `draft` ou o id da medição legada. Resolva pelo
      // número quando a base independente já substituiu esses identificadores.
      const oldNumber = measurementFilter === 'draft'
        ? project.measurementDraft?.number
        : project.measurements?.find(period => period.id === measurementFilter)?.number;
      return measurementPeriods.find(period => period.number === oldNumber) || null;
    },
    [measurementPeriods, measurementFilter, project.measurementDraft, project.measurements],
  );

  // Datas exibidas no seletor secundário (quando filtra por uma medição)
  const periodDates = useMemo(() => {
    if (!activePeriod) return [] as string[];
    const out: string[] = [];
    const [sy, sm, sd] = activePeriod.startDate.split('-').map(Number);
    const [ey, em, ed] = activePeriod.endDate.split('-').map(Number);
    const cur = new Date(Date.UTC(sy, (sm || 1) - 1, sd || 1));
    const end = new Date(Date.UTC(ey, (em || 1) - 1, ed || 1));
    while (cur.getTime() <= end.getTime()) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }, [activePeriod]);

  // Associa a data ao período atual sem consultar snapshots antigos da obra.
  const dateMembership = useMemo<DateMembership>(() => {
    const period = measurementPeriods.find(p => selectedDate >= p.startDate && selectedDate <= p.endDate);
    if (!period) return null;
    return { kind: period.status === 'draft' ? 'draft' : 'generated', label: period.label };
  }, [measurementPeriods, selectedDate]);

  // Resumo do período (só calcula quando há período ativo)
  const periodSummary = useMemo(
    () => activePeriod ? summarizeDailyReportsForPeriod(project, activePeriod.startDate, activePeriod.endDate) : null,
    [activePeriod, project],
  );

  return {
    measurementPeriods,
    activePeriod,
    periodDates,
    dateMembership,
    periodSummary,
    periodLoadError: source?.projectId === project.id ? source.error : null,
  };
}
