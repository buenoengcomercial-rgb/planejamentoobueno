import { applyProjectOperation } from '@/lib/projectOperations';
import { useCallback, useMemo, type ComponentProps } from 'react';

import { buildOfficialAdditiveSuspensionMap, buildOperationalProjectFromPendingAdditives, getPendingAdditiveScheduleControls } from '@/lib/additiveSchedule';
import { mergeOperationalProjectIntoRaw } from '@/lib/operationalProject';
import type { Additive, Project } from '@/types/project';
import { includeContractedAdditiveTasks } from '@/lib/contractedAdditiveSchedule';
import GanttChart from './GanttChart';
import GanttFinancialForecast from './gantt/GanttFinancialForecast';

type ProjectUpdate = Project | ((previous: Project) => Project);
type Props = Omit<ComponentProps<typeof GanttChart>, 'project' | 'onProjectChange' | 'lockedTaskLabels' | 'displayOnlyTaskIds'> & {
  project: Project;
  confirmedAdditives?: readonly Additive[];
  onProjectChange: (next: ProjectUpdate) => void;
};

const NO_ADDITIVES: readonly Additive[] = [];

export default function OperationalGanttChart({ project, confirmedAdditives = NO_ADDITIVES, onProjectChange, ...props }: Props) {
  const operationalProject = useMemo(() => buildOperationalProjectFromPendingAdditives(project), [project]);
  const display = useMemo(() => includeContractedAdditiveTasks(operationalProject, confirmedAdditives), [operationalProject, confirmedAdditives]);
  const suspensionMap = useMemo(() => buildOfficialAdditiveSuspensionMap(display.project), [display.project]);
  const lockedTaskLabels = useMemo(() => Object.fromEntries([
    ...Array.from(getPendingAdditiveScheduleControls(project), ([taskId, control]) => [taskId, control.additiveName]),
    ...display.project.phases.flatMap(phase => phase.tasks
      .filter(task => display.projectedTaskIds.has(task.id))
      .map(task => [task.id, task.originAdditiveName || phase.name])),
  ]), [project, display]);
  const updateOperationalProject = useCallback((next: ProjectUpdate) => {
    onProjectChange(previous => {
      const previousOperational = buildOperationalProjectFromPendingAdditives(previous);
      const currentDisplay = includeContractedAdditiveTasks(previousOperational, confirmedAdditives).project;
      const nextOperational = typeof next === 'function' ? next(currentDisplay) : next;
      return mergeOperationalProjectIntoRaw(previous, applyProjectOperation('gantt', currentDisplay, display.project, nextOperational));
    });
  }, [confirmedAdditives, display, onProjectChange]);

  return (
    <GanttChart
      {...props}
      project={display.project}
      onProjectChange={updateOperationalProject}
      lockedTaskLabels={lockedTaskLabels}
      suspensionMap={props.suspensionMap ?? suspensionMap}
      displayOnlyTaskIds={display.projectedTaskIds}
      financialForecastNode={props.financialForecastNode === undefined && display.projectedTaskIds.size > 0
        ? <GanttFinancialForecast project={operationalProject} trabalhaSabado={props.calendarConfig?.trabalhaSabado} />
        : props.financialForecastNode}
    />
  );
}
