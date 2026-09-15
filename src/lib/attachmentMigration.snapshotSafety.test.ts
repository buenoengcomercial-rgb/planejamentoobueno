import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';

const mocks = vi.hoisted(() => ({
  listCloudProjects: vi.fn(),
  loadCloudProjectRecord: vi.fn(),
  discardCloudProjectRecord: vi.fn(),
  storageList: vi.fn(),
}));

vi.mock('./cloudProjects', () => ({
  listCloudProjects: mocks.listCloudProjects,
  loadCloudProjectRecord: mocks.loadCloudProjectRecord,
  discardCloudProjectRecord: mocks.discardCloudProjectRecord,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    storage: {
      from: vi.fn(() => ({ list: mocks.storageList })),
    },
  },
}));

import { auditOrganizationStorage } from './attachmentMigration';

describe('auditoria auxiliar de anexos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storageList.mockResolvedValue({ data: [], error: null });
  });

  it('hidrata de forma estrita e descarta a resposta sem confirmar o snapshot ativo', async () => {
    const project = {
      id: 'project-active',
      name: 'Obra ativa',
      phases: [],
      totalBudget: 0,
    } as Project;
    const record = {
      project,
      updatedAt: '2026-09-14T20:00:00.000Z',
      warehouseVersion: 7,
      warehouseUpdatedAt: '2026-09-14T20:00:00.000Z',
      loadedCollections: [],
    };
    mocks.listCloudProjects.mockResolvedValue([{
      id: project.id,
      name: project.name,
      createdAt: '2026-09-14T19:00:00.000Z',
      updatedAt: record.updatedAt,
    }]);
    mocks.loadCloudProjectRecord.mockResolvedValue(record);

    const result = await auditOrganizationStorage();

    expect(mocks.loadCloudProjectRecord).toHaveBeenCalledWith(project.id, {
      strict: true,
      deferSnapshot: true,
    });
    expect(mocks.discardCloudProjectRecord).toHaveBeenCalledOnce();
    expect(mocks.discardCloudProjectRecord).toHaveBeenCalledWith(record);
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe(project);
  });
});
