import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleProject } from '@/data/sampleProject';
import MigrationDialog from './MigrationDialog';

const mocks = vi.hoisted(() => ({
  listLocalProjects: vi.fn(), loadLocalProject: vi.fn(), listCloudProjects: vi.fn(), upsertCloudProject: vi.fn(),
  user: { id: 'owner-1' },
}));
vi.mock('@/lib/projectStorage', () => ({ listProjects: mocks.listLocalProjects, loadProject: mocks.loadLocalProject }));
vi.mock('@/lib/cloudProjects', () => ({ listCloudProjects: mocks.listCloudProjects, upsertCloudProject: mocks.upsertCloudProject }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mocks.user }) }));

const local = { ...sampleProject, id: 'local-palacio', name: 'Palácio Rio Madeira' };
const meta = { id: local.id, name: local.name, createdAt: '', updatedAt: '' };
const cloud = { id: 'cloud-palacio', name: local.name, createdAt: '', updatedAt: '' };

describe('legacy cloud migration prompt', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.listLocalProjects.mockReturnValue([meta]);
    mocks.loadLocalProject.mockReturnValue(local);
  });

  it('does not offer to copy a work already in the cloud', async () => {
    mocks.listCloudProjects.mockResolvedValue([cloud]);
    render(<MigrationDialog organizationId="org-1" onMigrated={vi.fn()} />);
    await waitFor(() => expect(mocks.listCloudProjects).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mocks.upsertCloudProject).not.toHaveBeenCalled();
  });

  it('rechecks cloud state before writing a local work', async () => {
    mocks.listCloudProjects.mockResolvedValueOnce([]).mockResolvedValueOnce([cloud]);
    render(<MigrationDialog organizationId="org-1" onMigrated={vi.fn()} />);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(local.name);
    fireEvent.click(screen.getByRole('button', { name: 'Migrar para nuvem' }));
    await waitFor(() => expect(mocks.listCloudProjects).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mocks.upsertCloudProject).not.toHaveBeenCalled();
  });
});
