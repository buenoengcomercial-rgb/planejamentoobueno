import type { ElementType } from 'react';
import { ListChecks, FolderTree, Users, FileText, AlertOctagon } from 'lucide-react';

export interface DailyReportSummary {
  tasks: number;
  chapters: number;
  teams: number;
  occurrences: number;
  hasImpediments: boolean;
}

interface DailyReportSummaryCardsProps {
  summary: DailyReportSummary;
}

export function DailyReportSummaryCards({ summary }: DailyReportSummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <SummaryCard icon={ListChecks} label="Tarefas com produção" value={summary.tasks} />
      <SummaryCard icon={FolderTree} label="Capítulos com produção" value={summary.chapters} />
      <SummaryCard icon={Users} label="Equipes presentes" value={summary.teams} />
      <SummaryCard icon={FileText} label="Ocorrências" value={summary.occurrences} />
      <SummaryCard
        icon={AlertOctagon}
        label="Impedimentos"
        value={summary.hasImpediments ? 'Sim' : 'Não'}
        tone={summary.hasImpediments ? 'warning' : 'ok'}
      />
    </div>
  );
}

function SummaryCard({
  icon: Icon, label, value, tone = 'default',
}: { icon: ElementType; label: string; value: number | string; tone?: 'default' | 'ok' | 'warning' }) {
  const toneCls =
    tone === 'warning' ? 'text-warning' :
    tone === 'ok' ? 'text-success' :
    'text-foreground';
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center">
        <Icon className="w-5 h-5 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-muted-foreground truncate">{label}</div>
        <div className={`text-xl font-bold leading-tight ${toneCls}`}>{value}</div>
      </div>
    </div>
  );
}
