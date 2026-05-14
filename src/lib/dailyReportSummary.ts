import type { Project, DailyReport } from '@/types/project';

export type DailyEntryStatus = 'filled' | 'pending' | 'noProduction' | 'impediment';

export interface DailyEntrySummary {
  date: string;            // ISO yyyy-mm-dd
  status: DailyEntryStatus;
  responsible?: string;
  weather?: string;
  totalProduction: number;  // soma de actualQuantity dos apontamentos do dia
  hasReport: boolean;
  hasProduction: boolean;
  hasImpediment: boolean;
}

export interface DailyReportPeriodSummary {
  startDate: string;
  endDate: string;
  totalDays: number;
  filledReports: number;
  missingReports: number;
  productionDays: number;
  noProductionDays: number;
  impedimentDays: number;
  reportDates: string[];
  entries: DailyEntrySummary[];
  /** Datas com produção apontada porém sem diário preenchido. */
  productionWithoutReportDates: string[];
}

export function isDailyReportEmpty(report?: Partial<DailyReport> | null): boolean {
  if (!report) return true;
  return !String(report.responsible ?? '').trim()
    && !report.weather
    && !String(report.weatherOther ?? '').trim()
    && !report.workCondition
    && !String(report.workConditionOther ?? '').trim()
    && !String(report.occurrences ?? '').trim()
    && !String(report.impediments ?? '').trim()
    && !String(report.observations ?? '').trim()
    && (report.teamsPresent?.length || 0) === 0
    && (report.equipment?.length || 0) === 0
    && (report.attachments?.length || 0) === 0;
}

function dailyReportTime(report: DailyReport): number {
  return Date.parse(report.updatedAt || report.createdAt || '') || 0;
}

export function pickLatestDailyReport(current: DailyReport | undefined, next: DailyReport): DailyReport {
  if (!current) return next;
  return dailyReportTime(next) >= dailyReportTime(current) ? next : current;
}

/** Itera datas ISO inclusivas entre start e end. */
function eachDateISO(startISO: string, endISO: string): string[] {
  if (!startISO || !endISO || startISO > endISO) return [];
  const out: string[] = [];
  const [sy, sm, sd] = startISO.split('-').map(Number);
  const [ey, em, ed] = endISO.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, (sm || 1) - 1, sd || 1));
  const end = new Date(Date.UTC(ey, (em || 1) - 1, ed || 1));
  while (cur.getTime() <= end.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Mapa data → soma de actualQuantity dos apontamentos da EAP daquela data. */
function buildProductionByDate(project: Project): Map<string, number> {
  const map = new Map<string, number>();
  project.phases.forEach(phase => {
    phase.tasks.forEach(task => {
      (task.dailyLogs || []).forEach(log => {
        if (!log.date) return;
        const q = log.actualQuantity || 0;
        if (q <= 0) return;
        map.set(log.date, (map.get(log.date) || 0) + q);
      });
    });
  });
  return map;
}

/** Calcula o resumo de Diários de Obra para um período da medição. */
export function summarizeDailyReportsForPeriod(
  project: Project,
  startDate: string,
  endDate: string,
): DailyReportPeriodSummary {
  const dates = eachDateISO(startDate, endDate);
  const reportsMap = new Map<string, DailyReport>();
  (project.dailyReports || []).forEach(r => {
    if (!r.date) return;
    reportsMap.set(r.date, pickLatestDailyReport(reportsMap.get(r.date), r));
  });
  const productionByDate = buildProductionByDate(project);

  let filledReports = 0;
  let productionDays = 0;
  let impedimentDays = 0;
  const productionWithoutReportDates: string[] = [];

  const entries: DailyEntrySummary[] = dates.map(date => {
    const report = reportsMap.get(date);
    const totalProduction = productionByDate.get(date) || 0;
    const hasProduction = totalProduction > 0;
    const impedimentText = String(report?.impediments ?? '').trim();
    const hasImpediment = impedimentText.length > 0;
    // "preenchido" = existe um diário com pelo menos um campo significativo.
    const hasReport = !!report && !isDailyReportEmpty(report);

    if (hasReport) filledReports++;
    if (hasProduction) productionDays++;
    if (hasImpediment) impedimentDays++;
    if (hasProduction && !hasReport) productionWithoutReportDates.push(date);

    let status: DailyEntryStatus;
    if (hasImpediment) status = 'impediment';
    else if (hasReport) status = 'filled';
    else if (hasProduction) status = 'pending'; // produção sem diário => pendente
    else status = 'noProduction'; // sem produção e sem diário => sem produção

    return {
      date,
      status,
      responsible: report?.responsible,
      weather: report?.weather,
      totalProduction,
      hasReport,
      hasProduction,
      hasImpediment,
    };
  });

  return {
    startDate,
    endDate,
    totalDays: dates.length,
    filledReports,
    missingReports: productionWithoutReportDates.length,
    productionDays,
    noProductionDays: dates.length - productionDays,
    impedimentDays,
    reportDates: dates,
    entries,
    productionWithoutReportDates,
  };
}

/** Snapshot leve para persistir em SavedMeasurement.dailyReportSnapshot. */
export interface DailyReportSnapshot {
  startDate: string;
  endDate: string;
  totalDays: number;
  filledReports: number;
  missingReports: number;
  productionDays: number;
  noProductionDays: number;
  impedimentDays: number;
  reportDates: string[];
}

export function buildDailyReportSnapshot(s: DailyReportPeriodSummary): DailyReportSnapshot {
  return {
    startDate: s.startDate,
    endDate: s.endDate,
    totalDays: s.totalDays,
    filledReports: s.filledReports,
    missingReports: s.missingReports,
    productionDays: s.productionDays,
    noProductionDays: s.noProductionDays,
    impedimentDays: s.impedimentDays,
    reportDates: s.reportDates,
  };
}
