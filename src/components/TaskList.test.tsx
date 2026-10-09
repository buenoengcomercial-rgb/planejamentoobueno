import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => window.localStorage.clear());

  it('mostra a descrição completa de uma tarefa longa com quebra de linha', () => {
    const longName = 'PLACA DE SINALIZACAO DE SEGURANCA CONTRA INCENDIO FOTOLUMINESCENTE PARA ORIENTACAO DA ROTA DE FUGA NO PAVIMENTO';
    const longNameProject = {
      ...project,
      phases: [{ ...project.phases[0], tasks: [{ ...task, name: longName }] }],
    } as Project;
    const { container } = render(
      <TooltipProvider>
        <TaskList project={longNameProject} onProjectChange={vi.fn()} />
      </TooltipProvider>,
    );

    const taskRow = container.querySelector('[data-task-id="task-1"]');
    const name = screen.getByText(longName);
    expect(taskRow).toContainElement(name);
    expect(name).toHaveClass('whitespace-normal', 'break-words');
    expect(name).not.toHaveClass('truncate');
  });

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

  it('guarda a expansão neste navegador sem salvar a obra ao navegar', () => {
    const onProjectChange = vi.fn();
    const first = render(
      <TooltipProvider>
        <TaskList project={project} onProjectChange={onProjectChange} />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByTitle('Recolher'));
    expect(screen.queryByText('Instalar hidrante')).not.toBeInTheDocument();
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(project.uiState?.collapsedPhaseIds).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem('obraplanner:production:collapsed-phases:project-1') ?? '[]')).toEqual(['phase-1']);

    first.unmount();
    render(
      <TooltipProvider>
        <TaskList project={project} onProjectChange={onProjectChange} />
      </TooltipProvider>,
    );
    expect(screen.queryByText('Instalar hidrante')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Expandir'));
    expect(screen.getByText('Instalar hidrante')).toBeInTheDocument();
    expect(onProjectChange).not.toHaveBeenCalled();
  });

  it('abre a tarefa vinda da Rotina sem criar uma data de execução para a medição', () => {
    const onProjectChange = vi.fn();
    render(<TooltipProvider>
      <TaskList project={project} onProjectChange={onProjectChange}
        focusTaskId="task-1" focusDate="2026-09-30" auditActor={{ userId: 'owner-1', userName: 'Proprietário' }} />
    </TooltipProvider>);

    expect(screen.getByText(/Defina o número e as datas do período na aba Medição/)).toBeInTheDocument();
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Lançar em 30/09/2026' })).not.toBeInTheDocument();
  });

  it('abre a planta pelo capítulo em que a tarefa está, mesmo com phase legado na tarefa', () => {
    const nestedProject = {
      ...project,
      measurementDraft: { number: 1, startDate: '2026-09-01', endDate: '2026-09-30' },
      phases: [
        { ...project.phases[0], tasks: [] },
        {
          id: 'phase-child', name: 'Pavimento térreo', color: '#0ea5e9', parentId: 'phase-1',
          tasks: [{ ...task, phase: 'legacy-phase', dailyLogs: [{
            id: 'log-1', date: '', plannedQuantity: 0, actualQuantity: 0,
            measurementPeriod: { number: 1, startDate: '2026-09-01', endDate: '2026-09-30' },
            quantityDetails: [{ id: 'row-1', location: '', comment: '', multiplier: 0, measuredQuantity: 0 }],
          }] }],
        },
      ],
    } as Project;
    render(<TooltipProvider><TaskList project={nestedProject} onProjectChange={vi.fn()}
      focusTaskId="task-1" focusDate="2026-09-30" takeoffStorageKey="scope" /></TooltipProvider>);

    fireEvent.focus(screen.getByRole('spinbutton', { name: 'Medida da linha 1' }));
    expect(screen.getByRole('button', { name: 'Planta DXF' })).toBeEnabled();
  });

  it('preserva o apontamento diário existente para consulta sem convertê-lo em período', () => {
    const onProjectChange = vi.fn();
    const existing = { id: 'log-1', date: '2026-09-30', plannedQuantity: 1, actualQuantity: 0.5 };
    const withLog = {
      ...project,
      phases: [{ ...project.phases[0], tasks: [{ ...task, dailyLogs: [existing] }] }],
    } as Project;
    render(<TooltipProvider>
      <TaskList project={withLog} onProjectChange={onProjectChange}
        focusTaskId="task-1" focusDate="2026-09-30" auditActor={{ userId: 'owner-1' }} />
    </TooltipProvider>);
    expect(screen.getByText(/30\/09\/2026 · 0,5 UN/)).toBeInTheDocument();
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(withLog.phases[0].tasks[0].dailyLogs).toEqual([existing]);
  });

  it('mantém o progresso manual como rascunho até sair do campo', () => {
    const onProjectChange = vi.fn();
    render(<TooltipProvider><TaskList project={project} onProjectChange={onProjectChange} /></TooltipProvider>);
    const percent = screen.getByRole('spinbutton', { name: 'Progresso manual de Instalar hidrante' });
    fireEvent.focus(percent);
    fireEvent.change(percent, { target: { value: '40' } });
    expect(onProjectChange).not.toHaveBeenCalled();
    fireEvent.blur(percent);
    expect(onProjectChange).toHaveBeenCalledTimes(1);
    const saved = onProjectChange.mock.calls[0][0] as Project;
    expect(saved.phases[0].tasks[0].percentComplete).toBe(40);
    expect(saved.auditLogs?.[0]).toMatchObject({
      entityType: 'task', action: 'updated', title: 'Progresso manual corrigido',
      before: { percentComplete: 0 }, after: { percentComplete: 40 },
    });
  });

  it('registra a tarefa e apontamentos anteriores ao excluir', () => {
    const onProjectChange = vi.fn();
    const existingLog = { id: 'log-1', date: '2026-09-30', plannedQuantity: 1, actualQuantity: 0.5 };
    const withLog = {
      ...project,
      phases: [{ ...project.phases[0], tasks: [{ ...task, dailyLogs: [existingLog] }] }],
    } as Project;
    render(<TooltipProvider><TaskList project={withLog} onProjectChange={onProjectChange} /></TooltipProvider>);
    fireEvent.click(screen.getByTitle('Excluir tarefa'));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir tarefa' }));
    const saved = onProjectChange.mock.calls[0][0] as Project;
    expect(saved.phases[0].tasks).toHaveLength(0);
    expect(saved.auditLogs?.[0]).toMatchObject({
      entityType: 'task', action: 'deleted',
      before: expect.objectContaining({ id: 'task-1', dailyLogs: [existingLog] }),
      metadata: { phaseId: 'phase-1', removedLogIds: ['log-1'] },
    });
  });

  it('localiza tarefas dentro de capítulo recolhido sem salvar ou reordenar a EAP', () => {
    const onProjectChange = vi.fn();
    const filteredProject = {
      ...project,
      phases: [{ ...project.phases[0], tasks: [task, { ...task, id: 'task-2', name: 'Montar bomba' }] }],
    } as Project;
    render(<TooltipProvider><TaskList project={filteredProject} onProjectChange={onProjectChange} /></TooltipProvider>);
    fireEvent.click(screen.getByTitle('Recolher'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar tarefa ou capítulo' }), { target: { value: 'bomba' } });
    expect(screen.getByText('Montar bomba')).toBeInTheDocument();
    expect(screen.queryByText('Instalar hidrante')).not.toBeInTheDocument();
    expect(onProjectChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(screen.queryByText('Montar bomba')).not.toBeInTheDocument();
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
