import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ClipboardList, NotebookPen, TrendingUp } from 'lucide-react';
import type { Project } from '@/types/project';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import TaskList from '@/components/TaskList';
import DailyReport from '@/components/DailyReport';

type ProductionWorkspaceTab = 'production' | 'dailyReport';

interface DailyProductionWorkspaceProps {
  project: Project;
  initialTab?: ProductionWorkspaceTab;
  productionUndoButton?: React.ReactNode;
  dailyReportUndoButton?: React.ReactNode;
  onProductionChange: (next: Project | ((prev: Project) => Project)) => void;
  onDailyReportChange: (next: Project | ((prev: Project) => Project)) => void;
  dailyReportInitialDate?: string;
  dailyReportInitialFilter?: string;
  dailyReportNavKey?: number;
}

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function countTasks(project: Project) {
  return project.phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
}

function countInProgressTasks(project: Project) {
  return project.phases.reduce((sum, phase) => (
    sum + phase.tasks.filter(task => {
      const progress = task.physicalProgress ?? 0;
      return progress > 0 && progress < 100;
    }).length
  ), 0);
}

function countTodayProduction(project: Project) {
  const today = todayISO();
  return project.phases.reduce((sum, phase) => (
    sum + phase.tasks.reduce((taskSum, task) => (
      taskSum + (task.dailyLogs ?? []).filter(log => log.date === today && (log.actualQuantity ?? 0) > 0).length
    ), 0)
  ), 0);
}

function countDailyReports(project: Project) {
  return project.dailyReports?.length ?? 0;
}

export default function DailyProductionWorkspace({
  project,
  initialTab = 'production',
  productionUndoButton,
  dailyReportUndoButton,
  onProductionChange,
  onDailyReportChange,
  dailyReportInitialDate,
  dailyReportInitialFilter,
  dailyReportNavKey,
}: DailyProductionWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<ProductionWorkspaceTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, dailyReportNavKey]);

  const summary = useMemo(() => ({
    totalTasks: countTasks(project),
    inProgress: countInProgressTasks(project),
    todayProduction: countTodayProduction(project),
    dailyReports: countDailyReports(project),
  }), [project]);

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="max-w-[1400px] mx-auto space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Produção diária</h1>
              <p className="text-xs text-muted-foreground">
                Programação da EAP e diário de obra em uma única rotina de campo.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="text-muted-foreground">Tarefas</div>
              <div className="font-bold text-foreground">{summary.totalTasks}</div>
            </div>
            <div className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="text-muted-foreground">Em andamento</div>
              <div className="font-bold text-primary">{summary.inProgress}</div>
            </div>
            <div className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="text-muted-foreground">Produções hoje</div>
              <div className="font-bold text-success">{summary.todayProduction}</div>
            </div>
            <div className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="text-muted-foreground">Diários</div>
              <div className="font-bold text-foreground">{summary.dailyReports}</div>
            </div>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={value => setActiveTab(value as ProductionWorkspaceTab)} className="w-full">
          <TabsList className="h-10 bg-muted">
            <TabsTrigger value="production" className="text-xs">
              <ClipboardList className="w-3.5 h-3.5 mr-1" /> Produção
            </TabsTrigger>
            <TabsTrigger value="dailyReport" className="text-xs">
              <NotebookPen className="w-3.5 h-3.5 mr-1" /> Diário de obra
            </TabsTrigger>
            {dailyReportInitialDate && (
              <span className="hidden md:inline-flex items-center gap-1 ml-2 text-[11px] text-muted-foreground">
                <CalendarDays className="w-3.5 h-3.5" />
                Diário aberto pela medição
              </span>
            )}
          </TabsList>

          <TabsContent value="production" className="mt-4">
            <TaskList project={project} onProjectChange={onProductionChange} undoButton={productionUndoButton} />
          </TabsContent>

          <TabsContent value="dailyReport" className="mt-4">
            <DailyReport
              project={project}
              onProjectChange={onDailyReportChange}
              undoButton={dailyReportUndoButton}
              initialDate={dailyReportInitialDate}
              initialMeasurementFilter={dailyReportInitialFilter}
              navKey={dailyReportNavKey}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
