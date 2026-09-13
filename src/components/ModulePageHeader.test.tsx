import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ModulePageHeader } from './ModulePageHeader';

describe('ModulePageHeader', () => {
  it('organiza o contexto da página em um único cabeçalho semântico', () => {
    render(
      <ModulePageHeader
        eyebrow={<span>Visão geral</span>}
        title="Rotina semanal"
        description="Atividades programadas"
        meta={<span>Semana atual</span>}
      />,
    );

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Rotina semanal' })).toBeInTheDocument();
    expect(screen.getByText('Visão geral')).toBeInTheDocument();
    expect(screen.getByText('Atividades programadas')).toBeInTheDocument();
    expect(screen.getByText('Semana atual')).toBeInTheDocument();
  });

  it('mantém as ações agrupadas e disponíveis em largura móvel', () => {
    render(<ModulePageHeader title="Dashboard" actions={<button type="button">Desfazer</button>} />);

    const action = screen.getByRole('button', { name: 'Desfazer' });
    expect(action.parentElement).toHaveClass('w-full', 'sm:w-auto');
  });
});
