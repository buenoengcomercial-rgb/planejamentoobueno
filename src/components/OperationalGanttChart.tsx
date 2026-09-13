import { useCallback, useMemo, type ComponentProps } from 'react';

import { buildOperationalProjectFromPendingAdditives, getPendingAdditiveScheduleControls } from '@/lib/additiveSchedule';
import { mergeOperationalProjectIntoRaw } from '@/lib/operationalProject';
import type { Project } from '@/types/project';
import GanttChart from './GanttChart';

type ProjectUpdate = Project | ((previous: Project) => Project);
type Props = Omit<ComponentProps<typeof GanttChart>, 'project' | 'onProjectChange' | 'lockedTaskLabels'> & {
  project: Project;
  onProjectChange: (next: ProjectUpdate) => void;
};

export default function OperationalGanttChart({ project, onProjectChange, ...props }: Props) {
  const operationalProject = useMemo(() => buildOperationalProjectFromPendingAdditives(project), [project]);
  const lockedTaskLabels = useMemo(() => Object.fromEntries(
    Array.from(getPendingAdditiveScheduleControls(project).entries())
      .map(([taskId, control]) => [taskId, control.additiveName]),
  ), [project]);
  const updateOperationalProject = useCallback((next: ProjectUpdate) => {
    onProjectChange(previous => {
      const previousOperational = buildOperationalProjectFromPendingAdditives(previous);
      const nextOperational = typeof next === 'function' ? next(previousOperational) : next;
      return mergeOperationalProjectIntoRaw(previous, nextOperational);
    });
  }, [onProjectChange]);

  return (
    <GanttChart
      {...props}
      project={operationalProject}
      onProjectChange={updateOperationalProject}
      lockedTaskLabels={lockedTaskLabels}
    />
  );
}
