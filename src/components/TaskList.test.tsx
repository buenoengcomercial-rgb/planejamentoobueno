import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TaskList from './TaskList';
import type { Project, Task } from '@/types/project';
import { TooltipProvider } from '@/components/ui/tooltip';

const task: Task = {
  id: 'task-1',
  name: 'Instalar hidrante',
  phase: 'phase-1',
  startDate: '2026-09-08',
  duration: 2,
  dependencies: [],
  responsible: '',
  percentComplete: 0,
  materials: [],
  level: 0,
  quantity: 2,
  unit: 'UN',
};

const project = {
  id: 'project-1',
  name: 'Obra',
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  totalBudget: 0,
  phases: [{ id: 'phase-1', name: 'Capítulo de incêndio', color: '#0ea5e9', tasks: [task] }],
} as Project;

describe('TaskList', () => {
  it('expande e recolhe o capítulo pelo clique na área neutra da linha', () => {
    const { container } = render(
      <TooltipProvider>
        <TaskList project={project} onProjectChange={vi.fn()} />
      </TooltipProvider>,
    );
    const header = container.querySelector('[aria-expanded="true"]');

    expect(header).not.toBeNull();
    expect(screen.getByText('Instalar hidrante')).toBeInTheDocument();

    fireEvent.click(header!);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Instalar hidrante')).not.toBeInTheDocument();

    fireEvent.click(header!);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Instalar hidrante')).toBeInTheDocument();
  });
});
