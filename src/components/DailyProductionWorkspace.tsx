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
  productionReadOnly?: boolean;
  dailyReportReadOnly?: boolean;
  dailyReportCanManageConclusion?: boolean;
  onProductionChange: (next: Project | ((prev: Project) => Project)) => void;
  onDailyReportChange: (next: Project | ((prev: Project) => Project)) => void;
  dailyReportInitialDate?: string;
  dailyReportInitialFilter?: string;
  dailyReportNavKey?: number;
  productionFocusTaskId?: string;
  productionFocusDate?: string;
}

export default function DailyProductionWorkspace({
  project,
  initialTab = 'production',
  productionUndoButton,
  dailyReportUndoButton,
  productionReadOnly = false,
  dailyReportReadOnly = false,
  dailyReportCanManageConclusion = false,
  onProductionChange,
  onDailyReportChange,
  dailyReportInitialDate,
  dailyReportInitialFilter,
  dailyReportNavKey,
  productionFocusTaskId,
  productionFocusDate,
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
              <h1 className="text-2xl font-bold leading-tight text-foreground">Produção e Diário de Obra</h1>
              <p className="text-sm text-muted-foreground">
                Planejamento da EAP separado da operação diária da equipe de campo.
              </p>
            </div>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={value => setActiveTab(value as ProductionWorkspaceTab)} className="w-full">
          <TabsList className="grid h-auto min-h-11 w-full grid-cols-2 bg-muted sm:inline-flex sm:w-auto">
            <TabsTrigger value="production" className="min-h-10 px-2 text-sm sm:px-4">
              <ClipboardList className="mr-2 h-4 w-4" />
              <span className="sm:hidden">Planejamento</span>
              <span className="hidden sm:inline">Planejamento da produção</span>
            </TabsTrigger>
            <TabsTrigger value="dailyReport" className="min-h-10 px-2 text-sm sm:px-4">
              <NotebookPen className="mr-2 h-4 w-4" /> Diário de obra
            </TabsTrigger>
            {dailyReportInitialDate && (
              <span className="hidden md:inline-flex items-center gap-1 ml-2 text-xs text-muted-foreground">
                <CalendarDays className="w-3.5 h-3.5" />
                Diário aberto pela medição
              </span>
            )}
          </TabsList>

          <TabsContent value="production" className="mt-4">
            <TaskList
              project={project}
              onProjectChange={onProductionChange}
              undoButton={productionUndoButton}
              readOnly={productionReadOnly}
              focusTaskId={productionFocusTaskId}
              focusDate={productionFocusDate}
            />
          </TabsContent>

          <TabsContent value="dailyReport" className="mt-4">
            <DailyReport
              project={project}
              onProjectChange={onDailyReportChange}
              undoButton={dailyReportUndoButton}
              readOnly={dailyReportReadOnly}
              canManageConclusion={dailyReportCanManageConclusion}
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
