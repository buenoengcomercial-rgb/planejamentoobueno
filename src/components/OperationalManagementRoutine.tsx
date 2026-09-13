import { useCallback, useMemo, type ComponentProps } from 'react';

import { buildOperationalProjectFromPendingAdditives } from '@/lib/additiveSchedule';
import { mergeOperationalProjectIntoRaw } from '@/lib/operationalProject';
import type { Project } from '@/types/project';
import ManagementRoutine from './ManagementRoutine';

type ProjectUpdate = Project | ((previous: Project) => Project);
type Props = Omit<ComponentProps<typeof ManagementRoutine>, 'project' | 'onProjectChange'> & {
  project: Project;
  onProjectChange: (next: ProjectUpdate) => void;
};

export default function OperationalManagementRoutine({ project, onProjectChange, ...props }: Props) {
  const operationalProject = useMemo(() => buildOperationalProjectFromPendingAdditives(project), [project]);
  const updateOperationalProject = useCallback((next: ProjectUpdate) => {
    onProjectChange(previous => {
      const previousOperational = buildOperationalProjectFromPendingAdditives(previous);
      const nextOperational = typeof next === 'function' ? next(previousOperational) : next;
      return mergeOperationalProjectIntoRaw(previous, nextOperational);
    });
  }, [onProjectChange]);

  return (
    <ManagementRoutine
      {...props}
      project={operationalProject}
      onProjectChange={updateOperationalProject}
    />
  );
}
