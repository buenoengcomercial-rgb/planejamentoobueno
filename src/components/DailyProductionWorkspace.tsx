import { useEffect, useState } from 'react';
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

  return (
    <div className="p-4 lg:p-5 space-y-4">
      <div className="max-w-[1680px] mx-auto space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight text-foreground">Produção diária</h1>
              <p className="text-sm text-muted-foreground">
                Programação da EAP e diário de obra em uma única rotina de campo.
              </p>
            </div>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={value => setActiveTab(value as ProductionWorkspaceTab)} className="w-full">
          <TabsList className="h-11 bg-muted">
            <TabsTrigger value="production" className="text-sm px-4">
              <ClipboardList className="w-4 h-4 mr-2" /> Produção
            </TabsTrigger>
            <TabsTrigger value="dailyReport" className="text-sm px-4">
              <NotebookPen className="w-4 h-4 mr-2" /> Diário de obra
            </TabsTrigger>
            {dailyReportInitialDate && (
              <span className="hidden md:inline-flex items-center gap-1 ml-2 text-xs text-muted-foreground">
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
