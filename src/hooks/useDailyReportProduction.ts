import { useMemo } from 'react';
import type { Project, DailyReport as DailyReportEntry } from '@/types/project';
import { getChapterTree, getChapterNumbering, type ChapterNode } from '@/lib/chapters';
import type { ProductionEntry } from '@/components/dailyReport/types';

/** Coleta todos os apontamentos da data, respeitando hierarquia capítulo/subcapítulo. */
export function collectProductionForDate(project: Project, dateISO: string): ProductionEntry[] {
  const numbering = getChapterNumbering(project);
  const tree = getChapterTree(project);
  const out: ProductionEntry[] = [];

  const visit = (node: ChapterNode, parent?: ChapterNode) => {
    const phase = node.phase;
    const visitTask = (task: Project['phases'][number]['tasks'][number]) => {
      (task.dailyLogs || []).forEach(log => {
        if (log.date !== dateISO) return;
        // O Diário é o registro do que foi efetivamente executado. Planejamento
        // ou observação sem produção não devem gerar uma linha no relatório do dia.
        if ((log.actualQuantity ?? 0) <= 0) return;
        const isSub = !!parent;
        out.push({
          chapterId: parent?.phase.id ?? phase.id,
          chapterName: parent?.phase.name ?? phase.name,
          chapterNumber: numbering.get(parent?.phase.id ?? phase.id) || '',
          subChapterId: isSub ? phase.id : undefined,
          subChapterName: isSub ? phase.name : undefined,
          subChapterNumber: isSub ? (numbering.get(phase.id) || '') : undefined,
          taskId: task.id,
          taskCode: task.contractItem,
          taskName: task.name,
          unit: task.unit || 'un',
          actualQuantity: log.actualQuantity || 0,
          plannedQuantity: log.plannedQuantity || 0,
          notes: log.notes,
          teamCode: task.team,
        });
      });
      task.children?.forEach(visitTask);
    };
    (phase.tasks || []).forEach(visitTask);
    node.children.forEach(child => visit(child, node));
  };

  tree.forEach(node => visit(node));
  return out;
}

export interface ProductionGroup {
  chapterNumber: string;
  chapterName: string;
  subs: Map<string, { number: string; name: string; entries: ProductionEntry[] }>;
  direct: ProductionEntry[];
}

export interface ProductionSummary {
  tasks: number;
  chapters: number;
  teams: number;
  occurrences: number;
  hasImpediments: boolean;
}

export interface UseDailyReportProductionResult {
  production: ProductionEntry[];
  grouped: ProductionGroup[];
  summary: ProductionSummary;
}

interface UseDailyReportProductionArgs {
  project: Project;
  selectedDate: string;
  currentReport: DailyReportEntry;
}

export function useDailyReportProduction({
  project,
  selectedDate,
  currentReport,
}: UseDailyReportProductionArgs): UseDailyReportProductionResult {
  const production = useMemo(
    () => collectProductionForDate(project, selectedDate),
    [project, selectedDate],
  );

  const grouped = useMemo<ProductionGroup[]>(() => {
    const byChapter = new Map<string, ProductionGroup>();
    production.forEach(p => {
      if (!byChapter.has(p.chapterId)) {
        byChapter.set(p.chapterId, {
          chapterNumber: p.chapterNumber,
          chapterName: p.chapterName,
          subs: new Map(),
          direct: [],
        });
      }
      const bucket = byChapter.get(p.chapterId)!;
      if (p.subChapterId) {
        if (!bucket.subs.has(p.subChapterId)) {
          bucket.subs.set(p.subChapterId, {
            number: p.subChapterNumber || '',
            name: p.subChapterName || '',
            entries: [],
          });
        }
        bucket.subs.get(p.subChapterId)!.entries.push(p);
      } else {
        bucket.direct.push(p);
      }
    });
    return Array.from(byChapter.values());
  }, [production]);

  const summary = useMemo<ProductionSummary>(() => ({
    tasks: new Set(production.map(p => p.taskId)).size,
    chapters: new Set(production.map(p => p.chapterId)).size,
    teams: (currentReport.teamsPresent?.length || 0),
    occurrences: (currentReport.occurrences?.trim() ? 1 : 0),
    hasImpediments: !!currentReport.impediments?.trim(),
  }), [production, currentReport]);

  return { production, grouped, summary };
}
