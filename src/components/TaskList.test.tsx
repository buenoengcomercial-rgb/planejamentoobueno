import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TaskList from './TaskList';
import type { Project, Task } from '@/types/project';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('@/components/ImportSyntheticDialog', () => ({
  default: ({ open }: { open: boolean }) => open ? <div role="dialog">Importador carregado</div> : null,
}));

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
    expect(header).toHaveClass('cursor-pointer');
    expect(screen.getByText('Instalar hidrante')).toBeInTheDocument();

    const chapterNumber = header!.querySelector('span.tabular-nums');
    expect(chapterNumber).not.toBeNull();
    fireEvent.click(chapterNumber!);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Instalar hidrante')).not.toBeInTheDocument();

    fireEvent.click(header!);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Instalar hidrante')).toBeInTheDocument();
  });

  it('carrega o importador de Excel somente depois da ação do usuário', async () => {
    render(
      <TooltipProvider>
        <TaskList project={project} onProjectChange={vi.fn()} />
      </TooltipProvider>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /atualizar planilha/i }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Importador carregado');
  });

  it('edita nome e numeração somente pelo botão de renomear', () => {
    const onProjectChange = vi.fn();
    render(
      <TooltipProvider>
        <TaskList project={project} onProjectChange={onProjectChange} />
      </TooltipProvider>,
    );

    expect(screen.queryByTitle('Clique para editar a numeração')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Numeração do capítulo Capítulo de incêndio')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Renomear capítulo'));
    const numberInput = screen.getByLabelText('Numeração do capítulo Capítulo de incêndio');
    const nameInput = screen.getByLabelText('Nome do capítulo Capítulo de incêndio');
    expect(numberInput).toHaveValue('1');
    expect(nameInput).toHaveValue('Capítulo de incêndio');

    fireEvent.change(numberInput, { target: { value: 'A' } });
    fireEvent.change(nameInput, { target: { value: 'Nome descartado' } });
    fireEvent.keyDown(nameInput, { key: 'Escape' });
    expect(screen.queryByLabelText('Nome do capítulo Capítulo de incêndio')).not.toBeInTheDocument();
    expect(onProjectChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Renomear capítulo'));
    fireEvent.change(screen.getByLabelText('Numeração do capítulo Capítulo de incêndio'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Nome do capítulo Capítulo de incêndio'), { target: { value: 'Capítulo renomeado' } });
    fireEvent.click(screen.getByTitle('Salvar capítulo'));

    expect(onProjectChange).toHaveBeenCalledTimes(1);
    expect(onProjectChange.mock.calls[0][0].phases[0]).toMatchObject({
      id: 'phase-1',
      name: 'Capítulo renomeado',
      customNumber: 'A',
    });
  });

  it('salva nome e reordenação numérica em uma única atualização', () => {
    const onProjectChange = vi.fn();
    const projectWithSibling = {
      ...project,
      phases: [
        { ...project.phases[0], order: 0 },
        { ...project.phases[0], id: 'phase-2', name: 'Segundo capítulo', tasks: [], order: 1 },
      ],
    } as Project;
    render(
      <TooltipProvider>
        <TaskList project={projectWithSibling} onProjectChange={onProjectChange} />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getAllByTitle('Renomear capítulo')[0]);
    fireEvent.change(screen.getByLabelText('Numeração do capítulo Capítulo de incêndio'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Nome do capítulo Capítulo de incêndio'), { target: { value: 'Capítulo movido' } });
    fireEvent.keyDown(screen.getByLabelText('Nome do capítulo Capítulo de incêndio'), { key: 'Enter' });

    expect(onProjectChange).toHaveBeenCalledTimes(1);
    const updated = onProjectChange.mock.calls[0][0] as Project;
    expect(updated.phases.find(phase => phase.id === 'phase-1')).toMatchObject({ name: 'Capítulo movido', order: 1 });
    expect(updated.phases.find(phase => phase.id === 'phase-2')).toMatchObject({ order: 0 });
  });

  it('mantém a expansão acessível em modo somente leitura sem liberar renomeação', () => {
    const { container } = render(
      <TooltipProvider>
        <TaskList project={project} onProjectChange={vi.fn()} readOnly />
      </TooltipProvider>,
    );

    expect(container.querySelector('[aria-expanded="true"]')).toHaveClass('cursor-pointer');
    expect(screen.queryByTitle('Renomear capítulo')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Numeração do capítulo Capítulo de incêndio')).not.toBeInTheDocument();
  });
});
