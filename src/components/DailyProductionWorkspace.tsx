import type { Project } from '@/types/project';
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
  return (
    <div className="space-y-4 p-3 pt-4 sm:p-4 lg:p-5">
      <div className="mx-auto max-w-[1680px]">
        {initialTab === 'production' ? (
          <TaskList
            project={project}
            onProjectChange={onProductionChange}
            undoButton={productionUndoButton}
            readOnly={productionReadOnly}
            focusTaskId={productionFocusTaskId}
            focusDate={productionFocusDate}
          />
        ) : (
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
        )}
      </div>
    </div>
  );
}
