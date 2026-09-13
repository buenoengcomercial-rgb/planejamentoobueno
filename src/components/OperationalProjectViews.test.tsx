import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '@/types/project';
import OperationalGanttChart from './OperationalGanttChart';
import OperationalManagementRoutine from './OperationalManagementRoutine';

const captured = vi.hoisted(() => ({
  managementProject: null as Project | null,
  ganttProject: null as Project | null,
}));

vi.mock('./ManagementRoutine', () => ({
  default: (props: { project: Project; onProjectChange: (next: (project: Project) => Project) => void }) => {
    captured.managementProject = props.project;
    return <button onClick={() => props.onProjectChange(project => ({ ...project, name: 'Rotina editada' }))}>Editar rotina</button>;
  },
}));

vi.mock('./GanttChart', () => ({
  default: (props: { project: Project; onProjectChange: (next: (project: Project) => Project) => void }) => {
    captured.ganttProject = props.project;
    return <button onClick={() => props.onProjectChange(project => ({ ...project, name: 'Cronograma editado' }))}>Editar cronograma</button>;
  },
}));

const project: Project = {
  id: 'project-1',
  name: 'Obra original',
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  totalBudget: 0,
  phases: [],
};

afterEach(() => {
  captured.managementProject = null;
  captured.ganttProject = null;
});

describe('projeções operacionais sob demanda', () => {
  it('mantém a projeção e devolve a edição da Rotina ao projeto-base', () => {
    const onProjectChange = vi.fn();
    render(
      <OperationalManagementRoutine
        project={project}
        onProjectChange={onProjectChange}
        onOpenDailyReport={vi.fn()}
        onOpenProduction={vi.fn()}
      />,
    );

    expect(captured.managementProject?.id).toBe(project.id);
    fireEvent.click(screen.getByRole('button', { name: 'Editar rotina' }));
    const updater = onProjectChange.mock.calls[0][0] as (previous: Project) => Project;
    expect(updater(project).name).toBe('Rotina editada');
  });

  it('mantém a projeção e devolve a edição do Cronograma ao projeto-base', () => {
    const onProjectChange = vi.fn();
    render(<OperationalGanttChart project={project} onProjectChange={onProjectChange} />);

    expect(captured.ganttProject?.id).toBe(project.id);
    fireEvent.click(screen.getByRole('button', { name: 'Editar cronograma' }));
    const updater = onProjectChange.mock.calls[0][0] as (previous: Project) => Project;
    expect(updater(project).name).toBe('Cronograma editado');
  });
});
