import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import GanttChart from './GanttChart';
import type { AdditiveScheduleSuspensionMeta } from '@/lib/additiveSchedule';

const project: Project = {
  id: 'gantt-additive-test',
  name: 'Obra teste',
  startDate: '2026-08-01',
  endDate: '2026-09-30',
  totalBudget: 100,
  phases: [{
    id: 'phase-1',
    name: 'Capítulo 1',
    color: '#64748b',
    tasks: [
      {
        id: 'suspended-1d', name: 'Tarefa suspensa de um dia', phase: 'phase-1', startDate: '2026-08-03', duration: 1,
        dependencies: ['scheduled-new'], responsible: 'Encarregado', team: 'alpha', percentComplete: 0, materials: [], level: 0,
        quantity: 1, unit: 'UN',
      },
      {
        id: 'scheduled-new', name: 'Novo serviço programado', phase: 'phase-1', startDate: '2026-08-10', duration: 1,
        dependencies: [], responsible: 'Encarregado', team: 'alpha', percentComplete: 0, materials: [], level: 0,
        quantity: 1, unit: 'UN',
      },
      {
        id: 'scheduled-new-long', name: 'Novo serviço programado longo', phase: 'phase-1', startDate: '2026-08-12', duration: 45,
        dependencies: [], responsible: 'Encarregado', team: 'alpha', percentComplete: 0, materials: [], level: 0,
        quantity: 1, unit: 'UN',
      },
      {
        id: 'partial-existing', name: 'Extintor contratado com acréscimo', phase: 'phase-1', startDate: '2026-08-17', duration: 2,
        dependencies: [], responsible: 'Encarregado', team: 'alpha', percentComplete: 0, materials: [], level: 0,
        quantity: 10, unit: 'UN',
      },
    ],
  }],
};

const suspensionMap: Record<string, AdditiveScheduleSuspensionMeta> = {
  'suspended-1d': {
    kind: 'manual',
    label: 'SUSPENSO - AGUARDA FORMALIZAÇÃO DO ADITIVO',
    reason: 'A execução depende da formalização.',
    additiveId: 'add-1',
    additiveName: '1º Aditivo',
    checked: true,
    disabled: false,
    scheduleState: 'suspended',
    financialTreatment: 'excluded',
  },
  'scheduled-new': {
    kind: 'proposed',
    label: 'A CONTRATAR - EXECUÇÃO NÃO AUTORIZADA',
    reason: 'Planejamento preliminar.',
    additiveId: 'add-1',
    additiveName: '1º Aditivo',
    checked: true,
    disabled: true,
    scheduleState: 'scheduled',
    financialTreatment: 'monthly',
  },
  'scheduled-new-long': {
    kind: 'proposed',
    label: 'A CONTRATAR - EXECUÇÃO NÃO AUTORIZADA',
    reason: 'Planejamento preliminar.',
    additiveId: 'add-1',
    additiveName: '1º Aditivo',
    checked: true,
    disabled: true,
    scheduleState: 'scheduled',
    financialTreatment: 'monthly',
  },
  'partial-existing': {
    kind: 'quantity_limited',
    label: 'EXECUTAR: 10 UN CONTRATADAS | ACRÉSCIMO DE 2 UN AGUARDA ADITIVO',
    reason: 'Execução limitada ao contrato vigente.',
    additiveId: 'add-1',
    additiveName: '1º Aditivo',
    checked: false,
    disabled: false,
    scheduleState: 'scheduled',
    financialTreatment: 'monthly',
    quantityRestriction: {
      kind: 'contracted_balance_only', contractedQuantity: 10, executableQuantity: 10,
      addedQuantity: 2, suppressedQuantity: 0, unit: 'UN',
    },
  },
};

describe('GanttChart no Cronograma do Aditivo', () => {
  beforeEach(() => localStorage.clear());

  it('mostra suspensões e serviços novos somente como advertência no cronograma do aditivo', () => {
    render(
      <GanttChart
        project={project}
        context="additive-preview"
        suspensionMap={suspensionMap}
        readOnly
      />,
    );

    expect(screen.getByTestId('gantt-status-only-suspended-1d')).toHaveTextContent(
      'SUSPENSO - AGUARDA FORMALIZAÇÃO DO ADITIVO',
    );
    expect(screen.queryByTestId('gantt-bar-suspended-1d')).not.toBeInTheDocument();
    expect(screen.getByTestId('gantt-proposed-label-scheduled-new')).toHaveTextContent('A CONTRATAR - EXECUÇÃO NÃO AUTORIZADA');
    expect(screen.getByTestId('gantt-proposed-label-scheduled-new-long')).toHaveTextContent('A CONTRATAR - EXECUÇÃO NÃO AUTORIZADA');
    expect(screen.queryByTestId('gantt-bar-scheduled-new')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gantt-bar-scheduled-new-long')).not.toBeInTheDocument();
    expect(screen.getByTestId('gantt-bar-partial-existing')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-quantity-limited-partial-existing')).toHaveTextContent('EXECUTAR: 10 UN CONTRATADAS');

    fireEvent.click(screen.getByRole('button', { name: 'Dias' }));
    expect(screen.getByTestId('gantt-status-only-suspended-1d')).toHaveTextContent('SUSPENSO - AGUARDA FORMALIZAÇÃO DO ADITIVO');
    expect(screen.getByTestId('gantt-proposed-label-scheduled-new')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-proposed-label-scheduled-new-long')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Meses' }));
    expect(screen.getByTestId('gantt-status-only-suspended-1d')).toHaveTextContent('SUSPENSO - AGUARDA FORMALIZAÇÃO DO ADITIVO');
    expect(screen.getByTestId('gantt-proposed-label-scheduled-new')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-proposed-label-scheduled-new-long')).toBeInTheDocument();
  });

  it('preserva a barra no cronograma oficial', () => {
    render(<GanttChart project={project} context="official" suspensionMap={suspensionMap} readOnly />);
    expect(screen.queryByTestId('gantt-status-only-suspended-1d')).not.toBeInTheDocument();
    expect(screen.getByTestId('gantt-bar-suspended-1d')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-bar-scheduled-new')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-bar-scheduled-new-long')).toBeInTheDocument();
  });

  it('identifica e bloqueia no cronograma principal a tarefa planejada pelo aditivo', () => {
    render(
      <GanttChart
        project={project}
        context="official"
        onProjectChange={vi.fn()}
        lockedTaskLabels={{ 'partial-existing': '1º Aditivo' }}
      />,
    );

    expect(screen.getByText('Planejada pelo aditivo: 1º Aditivo')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-bar-partial-existing')).toHaveAttribute(
      'title',
      'Planejada pelo aditivo: 1º Aditivo. Edite no Cronograma do Aditivo.',
    );
    expect(screen.getByDisplayValue('2')).toBeDisabled();
  });

  it('mostra os valores da previsão financeira dentro das colunas mensais', () => {
    render(
      <GanttChart
        project={project}
        context="additive-preview"
        suspensionMap={suspensionMap}
        monthlyFinancialForecast={[
          { key: '2026-08', contractedReleased: 110457.49, proposed: 2218214.14 },
          { key: '2026-09', contractedReleased: 478274.39, proposed: -1693.47 },
        ]}
        readOnly
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Meses' }));
    expect(screen.getByTestId('gantt-month-financial-2026-08')).toHaveTextContent('R$ 110.457,49');
    expect(screen.getByTestId('gantt-month-financial-2026-08')).toHaveTextContent('R$ 2.218.214,14');
    expect(screen.getByTestId('gantt-month-financial-2026-09')).toHaveTextContent('-R$ 1.693,47');
  });

  it('mostra o marco visual da data inicial da medição em Dias, Semanas e Meses sem mutar tarefas', () => {
    const projectWithMeasurementDraft: Project = {
      ...project,
      measurementDraft: { number: 1, startDate: '2026-08-24', endDate: '2026-09-22' },
    };
    const originalPhases = structuredClone(projectWithMeasurementDraft.phases);

    render(<GanttChart project={projectWithMeasurementDraft} context="official" readOnly />);

    for (const mode of ['Semanas', 'Dias', 'Meses']) {
      fireEvent.click(screen.getByRole('button', { name: mode }));
      expect(screen.getByTestId('gantt-work-start-marker')).toHaveAttribute(
        'title',
        'Início da obra: 24/08/2026',
      );
      expect(screen.getByTestId('gantt-work-start-marker')).toHaveTextContent('24/08/2026');
    }
    expect(projectWithMeasurementDraft.phases).toEqual(originalPhases);
  });

  it('controla e restaura capítulos e subcapítulos recolhidos de forma independente', () => {
    const collapseProject: Project = {
      ...project,
      id: 'gantt-collapse-test',
      phases: [{
        id: 'parent', name: 'Capítulo pai', color: '#64748b', tasks: [{
          ...project.phases[0].tasks[0], id: 'parent-task', phase: 'parent', name: 'Tarefa do pai', dependencies: [],
        }],
      }, {
        id: 'child', parentId: 'parent', name: 'Subcapítulo filho', color: '#64748b', tasks: [{
          ...project.phases[0].tasks[1], id: 'child-task', phase: 'child', name: 'Tarefa do filho', dependencies: [],
        }],
      }],
    };
    const onCollapsedPhaseIdsChange = vi.fn();
    const view = render(
      <GanttChart
        project={collapseProject}
        collapsedPhaseIds={['child']}
        onCollapsedPhaseIdsChange={onCollapsedPhaseIdsChange}
        readOnly
      />,
    );

    expect(screen.getByTestId('gantt-bar-parent-task')).toBeInTheDocument();
    expect(screen.queryByTestId('gantt-bar-child-task')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Capítulo pai/i }));
    expect(onCollapsedPhaseIdsChange).toHaveBeenLastCalledWith(['child', 'parent']);

    view.rerender(
      <GanttChart
        project={collapseProject}
        collapsedPhaseIds={['child', 'parent']}
        onCollapsedPhaseIdsChange={onCollapsedPhaseIdsChange}
        readOnly
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Capítulo pai/i }));
    expect(onCollapsedPhaseIdsChange).toHaveBeenLastCalledWith(['child']);

    view.unmount();
    render(
      <GanttChart
        project={collapseProject}
        collapsedPhaseIds={['child']}
        onCollapsedPhaseIdsChange={onCollapsedPhaseIdsChange}
        readOnly
      />,
    );
    expect(screen.getByTestId('gantt-bar-parent-task')).toBeInTheDocument();
    expect(screen.queryByTestId('gantt-bar-child-task')).not.toBeInTheDocument();
  });

  it.each(['official', 'additive-preview'] as const)(
    'salva a dependência e a data recalculada em uma única atualização no contexto %s',
    context => {
      const dependencyProject: Project = {
        ...project,
        id: `gantt-dependency-${context}`,
        phases: [{
          ...project.phases[0],
          tasks: [{
            ...project.phases[0].tasks[0],
            id: 'predecessor',
            name: 'Predecessora',
            startDate: '2026-08-14',
            duration: 1,
            dependencies: [],
          }, {
            ...project.phases[0].tasks[1],
            id: 'successor',
            name: 'Sucessora',
            startDate: '2026-07-10',
            duration: 1,
            dependencies: [],
          }],
        }],
      };
      const onProjectChange = vi.fn();
      render(<GanttChart project={dependencyProject} context={context} onProjectChange={onProjectChange} />);

      const successorDependencyInput = screen.getAllByTitle('Nº da tarefa predecessora (ex: 3, 7)')[1];
      fireEvent.change(successorDependencyInput, { target: { value: '1' } });
      fireEvent.blur(successorDependencyInput);

      expect(onProjectChange).toHaveBeenCalledTimes(1);
      const updated = onProjectChange.mock.calls[0][0] as Project;
      expect(updated.phases[0].tasks[1]).toMatchObject({
        startDate: '2026-08-17',
        dependencies: ['predecessor'],
        dependencyDetails: [{ taskId: 'predecessor', type: 'TI' }],
      });
    },
  );

  it('edita o tipo de cada predecessora separadamente e recalcula pela mais tardia', () => {
    const dependencyProject: Project = {
      ...project,
      id: 'gantt-multiple-dependencies',
      phases: [{
        ...project.phases[0],
        tasks: [{
          ...project.phases[0].tasks[0],
          id: 'pred-a', name: 'Predecessora A', startDate: '2026-08-14', duration: 1, dependencies: [],
        }, {
          ...project.phases[0].tasks[1],
          id: 'pred-b', name: 'Predecessora B', startDate: '2026-08-18', duration: 1, dependencies: [],
        }, {
          ...project.phases[0].tasks[2],
          id: 'successor', name: 'Sucessora', startDate: '2026-08-18', duration: 1,
          dependencies: ['pred-a', 'pred-b'],
          dependencyDetails: [
            { taskId: 'pred-a', type: 'TI' },
            { taskId: 'pred-b', type: 'II' },
          ],
        }],
      }],
    };
    const onProjectChange = vi.fn();
    render(<GanttChart project={dependencyProject} context="additive-preview" onProjectChange={onProjectChange} />);

    const editor = screen.getByTestId('gantt-dependency-types-successor') as HTMLSelectElement;
    expect(editor).toHaveValue('__multiple__');
    expect(editor.querySelectorAll('optgroup')).toHaveLength(2);
    expect(editor.querySelectorAll('option')).toHaveLength(9);
    fireEvent.change(editor, { target: { value: '1:TI' } });

    expect(onProjectChange).toHaveBeenCalledTimes(1);
    const updated = onProjectChange.mock.calls[0][0] as Project;
    expect(updated.phases[0].tasks[2]).toMatchObject({
      startDate: '2026-08-19',
      dependencyDetails: [
        { taskId: 'pred-a', type: 'TI' },
        { taskId: 'pred-b', type: 'TI' },
      ],
    });
  });

  it('confirma a dependência com as setas e move o foco para o campo vertical seguinte', async () => {
    const keyboardProject: Project = {
      ...project,
      id: 'gantt-dependency-keyboard',
      phases: [{
        ...project.phases[0],
        tasks: [{
          ...project.phases[0].tasks[0],
          id: 'keyboard-a', name: 'Tarefa A', startDate: '2026-08-14', duration: 1, dependencies: [], dependencyDetails: [],
        }, {
          ...project.phases[0].tasks[1],
          id: 'keyboard-b', name: 'Tarefa B', startDate: '2026-07-10', duration: 1, dependencies: [], dependencyDetails: [],
        }, {
          ...project.phases[0].tasks[2],
          id: 'keyboard-c', name: 'Tarefa C', startDate: '2026-07-11', duration: 1, dependencies: [], dependencyDetails: [],
        }],
      }],
    };
    const onProjectChange = vi.fn();
    render(<GanttChart project={keyboardProject} context="additive-preview" onProjectChange={onProjectChange} />);
    const inputs = screen.getAllByTitle('Nº da tarefa predecessora (ex: 3, 7)') as HTMLInputElement[];

    inputs[1].focus();
    fireEvent.change(inputs[1], { target: { value: '1' } });
    fireEvent.keyDown(inputs[1], { key: 'ArrowDown' });

    expect(onProjectChange).toHaveBeenCalledTimes(1);
    expect((onProjectChange.mock.calls[0][0] as Project).phases[0].tasks[1]).toMatchObject({
      startDate: '2026-08-17',
      dependencies: ['keyboard-a'],
      dependencyDetails: [{ taskId: 'keyboard-a', type: 'TI' }],
    });
    await waitFor(() => expect(inputs[2]).toHaveFocus());

    fireEvent.keyDown(inputs[2], { key: 'ArrowUp' });
    await waitFor(() => expect(inputs[1]).toHaveFocus());
    expect(onProjectChange).toHaveBeenCalledTimes(1);
  });
});
