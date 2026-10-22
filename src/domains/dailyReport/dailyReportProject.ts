import type { DailyReport, Project } from '@/types/project';
import { serializeProject } from '@/lib/cloudProjectDraftCore';

export function reportForDate(project: Project, date: string): DailyReport | undefined {
  return (project.dailyReports ?? []).find(report => report.date === date);
}

export function replaceReportForDate(project: Project, date: string, report: DailyReport | null): Project {
  const withoutDate = (project.dailyReports ?? []).filter(item => item.date !== date);
  return { ...project, dailyReports: report ? [...withoutDate, report] : withoutDate };
}

export function replaceSavedDailyReport(serialized: string | null, date: string, report: DailyReport | null): string | null {
  if (!serialized) return serialized;
  try {
    return serializeProject(replaceReportForDate(JSON.parse(serialized) as Project, date, report));
  } catch {
    return serialized;
  }
}
