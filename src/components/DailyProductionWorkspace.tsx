import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import type { Project } from '@/types/project';
import { lazyWithReload } from '@/lib/lazyWithReload';

// Produção e Diário são rotas independentes. Carregar somente a área aberta
// reduz a primeira transição e evita baixar PDF/fotos ao abrir Produção.
const TaskList = lazyWithReload(() => import('@/components/TaskList'));
const DailyReport = lazyWithReload(() => import('@/components/DailyReport'));

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
        <Suspense fallback={<div role="status" className="flex min-h-32 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando área…</div>}>
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
        </Suspense>
      </div>
    </div>
  );
}
