import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, ClipboardList, NotebookPen, TrendingUp } from 'lucide-react';
import type { Project, Task } from '@/types/project';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import TaskList from '@/components/TaskList';
import DailyReport from '@/components/DailyReport';
import { isDailyReportEmpty } from '@/lib/dailyReportSummary';

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

function addDaysISO(dateISO: string, days: number) {
  const date = new Date(`${dateISO}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateISO;
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

function taskEndDate(task: Task) {
  if (task.current?.forecastEndDate) return task.current.forecastEndDate;
  if (task.forecastEndDate) return task.forecastEndDate;
  if (task.current?.endDate) return task.current.endDate;
  if (task.baseline?.endDate) return task.baseline.endDate;
  if (task.startDate && task.duration) return addDaysISO(task.startDate, Math.max(0, task.duration - 1));
  return task.startDate;
}

function taskIsPlannedToday(task: Task, today: string) {
  if (!task.startDate) return false;
  const end = taskEndDate(task);
  const progress = task.physicalProgress ?? task.percentComplete ?? 0;
  return task.startDate <= today && today <= end && progress < 100;
}

function taskHasProductionToday(task: Task, today: string) {
  return (task.dailyLogs ?? []).some(log => log.date === today && (log.actualQuantity ?? 0) > 0);
}

function taskBelowPlannedToday(task: Task, today: string) {
  return (task.dailyLogs ?? []).some(log =>
    log.date === today &&
    (log.plannedQuantity ?? 0) > 0 &&
    (log.actualQuantity ?? 0) < (log.plannedQuantity ?? 0)
  );
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

function flattenTasks(project: Project) {
  return project.phases.flatMap(phase => phase.tasks);
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

  const summary = useMemo(() => {
    const today = todayISO();
    const tasks = flattenTasks(project);
    const plannedToday = tasks.filter(task => taskIsPlannedToday(task, today));
    const producedToday = tasks.filter(task => taskHasProductionToday(task, today));
    const belowPlannedToday = tasks.filter(task => taskBelowPlannedToday(task, today));
    const todayReport = (project.dailyReports ?? []).find(report => report.date === today);

    return {
      totalTasks: countTasks(project),
      inProgress: countInProgressTasks(project),
      todayProduction: countTodayProduction(project),
      dailyReports: countDailyReports(project),
      plannedToday: plannedToday.length,
      producedToday: producedToday.length,
      belowPlannedToday: belowPlannedToday.length,
      todayReportFilled: !!todayReport && !isDailyReportEmpty(todayReport),
      pendingToday: Math.max(0, plannedToday.length - producedToday.length),
    };
  }, [project]);

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

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-3 rounded-xl border border-border bg-card p-3 shadow-sm">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <OperationalCard
              label="Planejado hoje"
              value={summary.plannedToday}
              description={`${summary.pendingToday} pendente(s) de apontamento`}
            />
            <OperationalCard
              label="Apontado hoje"
              value={summary.producedToday}
              description="Tarefas com produção real lançada"
              tone="success"
            />
            <OperationalCard
              label="Abaixo da RUP"
              value={summary.belowPlannedToday}
              description="Produção real menor que a prevista"
              tone={summary.belowPlannedToday ? 'warning' : 'success'}
            />
            <OperationalCard
              label="Diário de hoje"
              value={summary.todayReportFilled ? 'OK' : 'Pendente'}
              description={summary.todayReportFilled ? 'Relatório preenchido' : 'Preencha equipe, fotos e ocorrências'}
              tone={summary.todayReportFilled ? 'success' : 'warning'}
            />
          </div>

          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              Roteiro de fechamento do dia
            </div>
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
              <p>1. Confira o previsto e lance a produção real.</p>
              <p>2. Se houver desvio da RUP, registre a causa.</p>
              <p>3. Preencha o diário com equipe, equipamento e fotos.</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant={activeTab === 'production' ? 'default' : 'outline'} className="h-7 text-[11px]" onClick={() => setActiveTab('production')}>
                Abrir produção
              </Button>
              <Button size="sm" variant={activeTab === 'dailyReport' ? 'default' : 'outline'} className="h-7 text-[11px]" onClick={() => setActiveTab('dailyReport')}>
                Abrir diário
              </Button>
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

function OperationalCard({
  label,
  value,
  description,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  description: string;
  tone?: 'default' | 'success' | 'warning';
}) {
  const toneClass = tone === 'success'
    ? 'border-success/35 bg-success/5 text-success'
    : tone === 'warning'
      ? 'border-warning/35 bg-warning/5 text-warning'
      : 'border-border bg-background text-foreground';
  const Icon = tone === 'warning' ? AlertTriangle : CheckCircle2;

  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="mt-1 text-lg font-bold tabular-nums text-foreground">{value}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</div>
    </div>
  );
}
