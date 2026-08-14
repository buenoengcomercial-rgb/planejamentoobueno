import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
        id: 'scheduled-new', name: 'Novo serviço programado', phase: 'phase-1', startDate: '2026-08-10', duration: 5,
        dependencies: [], responsible: 'Encarregado', team: 'alpha', percentComplete: 0, materials: [], level: 0,
        quantity: 1, unit: 'UN',
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
};

describe('GanttChart no Cronograma do Aditivo', () => {
  it('mostra a situação integral sem barra e mantém novos serviços programados', () => {
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
    expect(screen.getByTestId('gantt-bar-scheduled-new')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dias' }));
    expect(screen.getByTestId('gantt-status-only-suspended-1d')).toHaveTextContent('SUSPENSO - AGUARDA FORMALIZAÇÃO DO ADITIVO');
    fireEvent.click(screen.getByRole('button', { name: 'Meses' }));
    expect(screen.getByTestId('gantt-status-only-suspended-1d')).toHaveTextContent('SUSPENSO - AGUARDA FORMALIZAÇÃO DO ADITIVO');
  });

  it('preserva a barra no cronograma oficial', () => {
    render(<GanttChart project={project} context="official" suspensionMap={suspensionMap} readOnly />);
    expect(screen.queryByTestId('gantt-status-only-suspended-1d')).not.toBeInTheDocument();
    expect(screen.getByTestId('gantt-bar-suspended-1d')).toBeInTheDocument();
  });
});
