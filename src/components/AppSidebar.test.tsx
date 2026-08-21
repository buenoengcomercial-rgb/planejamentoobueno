import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AppSidebar from './AppSidebar';

describe('AppSidebar para Almoxarife', () => {
  it('mostra somente o Almoxarifado e não oferece gestão ou exclusão de obras', () => {
    render(
      <AppSidebar
        currentView="warehouse"
        onViewChange={vi.fn()}
        projectName="Obra teste"
        collapsed={false}
        onToggleCollapse={vi.fn()}
        onSwitchProject={vi.fn()}
        onCreateProject={vi.fn()}
        onRenameProject={vi.fn()}
        onDuplicateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        activeProjectId="project-1"
        projectsList={[{ id: 'project-1', name: 'Obra teste', createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z' }]}
        orgName="Bueno Engenharia"
        roleLabel="Almoxarife"
        allowedViews={['warehouse']}
        canManageProjects={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Almoxarifado' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Mais opções')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nova obra/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Excluir obra')).not.toBeInTheDocument();
  });

  it('mostra exclusão somente quando a permissão específica do Proprietário é concedida', () => {
    const props = {
      currentView: 'dashboard' as const,
      onViewChange: vi.fn(),
      projectName: 'Obra teste',
      collapsed: false,
      onToggleCollapse: vi.fn(),
      onSwitchProject: vi.fn(),
      onCreateProject: vi.fn(),
      onRenameProject: vi.fn(),
      onDuplicateProject: vi.fn(),
      onDeleteProject: vi.fn().mockResolvedValue(false),
      activeProjectId: 'project-1',
      projectsList: [
        { id: 'project-1', name: 'Obra teste', createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z' },
        { id: 'project-2', name: 'Outra obra', createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z' },
      ],
      canManageProjects: true,
    };

    const { rerender } = render(<AppSidebar {...props} canDeleteProjects={false} />);
    expect(screen.queryByTitle('Excluir obra')).not.toBeInTheDocument();

    rerender(<AppSidebar {...props} canDeleteProjects />);
    expect(screen.getAllByTitle('Excluir obra')).toHaveLength(2);
  });
});
