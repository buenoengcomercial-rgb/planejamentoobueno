import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DailyProductionWorkspace from './DailyProductionWorkspace';

vi.mock('./TaskList', () => ({
  default: () => <div>Conteúdo de produção</div>,
}));

vi.mock('./DailyReport', () => ({
  default: () => <div>Conteúdo do diário</div>,
}));

const project = { id: 'obra-1', name: 'Obra', phases: [] } as never;
const onProjectChange = vi.fn();

describe('DailyProductionWorkspace', () => {
  it('exibe diretamente a Produção sem a aba interna de planejamento', () => {
    render(<DailyProductionWorkspace project={project} initialTab="production" onProductionChange={onProjectChange} onDailyReportChange={onProjectChange} />);

    expect(screen.getByText('Conteúdo de produção')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Produção e Diário de Obra')).not.toBeInTheDocument();
  });

  it('exibe diretamente o Diário sem a aba interna de produção', () => {
    render(<DailyProductionWorkspace project={project} initialTab="dailyReport" onProductionChange={onProjectChange} onDailyReportChange={onProjectChange} />);

    expect(screen.getByText('Conteúdo do diário')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
