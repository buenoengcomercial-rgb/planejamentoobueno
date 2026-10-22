import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { CloudProjectConflictError, CloudProjectPartialSyncError, upsertCloudProject } from '@/lib/cloudProjects';
import { projectSaveAttempt } from './projectSaveAttempt';

const project = (name: string) => ({ id: 'obra-1', name } as Project);

describe('projectSaveAttempt', () => {
  it('reconcilia um avanço de versão antes de confirmar a fotografia aceita', async () => {
    const original = project('original');
    const rebased = project('conciliada');
    const accepted = project('confirmada');
    const expectedUpdatedAt = vi.fn().mockReturnValueOnce('v1').mockReturnValueOnce('v2');
    const onAccepted = vi.fn();
    const onVersionConflict = vi.fn().mockResolvedValue(rebased);
    const commit = vi.fn<typeof upsertCloudProject>()
      .mockRejectedValueOnce(new CloudProjectConflictError())
      .mockImplementationOnce(async (_project, _org, _version, onConfirmed) => {
        onConfirmed?.(accepted);
        return 'v3';
      });

    const result = await projectSaveAttempt({
      project: original,
      organizationId: 'equipe-1',
      expectedUpdatedAt,
      onAccepted,
      onVersionConflict,
      onFieldConflict: vi.fn(),
      commit,
    });

    expect(commit.mock.calls.map(([sent, , version]) => [sent, version])).toEqual([
      [original, 'v1'], [rebased, 'v2'],
    ]);
    expect(onVersionConflict).toHaveBeenCalledExactlyOnceWith(original);
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith(rebased, accepted, JSON.stringify(accepted));
    expect(result).toEqual({ project: accepted, json: JSON.stringify(accepted), updatedAt: 'v3' });
  });

  it('mantém o conflito real quando não há conciliação segura', async () => {
    const conflict = new CloudProjectConflictError();
    const commit = vi.fn<typeof upsertCloudProject>().mockRejectedValue(conflict);
    const onVersionConflict = vi.fn().mockResolvedValue(null);

    await expect(projectSaveAttempt({
      project: project('local'), organizationId: 'equipe-1', expectedUpdatedAt: () => 'v1',
      onAccepted: vi.fn(), onFieldConflict: vi.fn(), onVersionConflict, commit,
    })).rejects.toBe(conflict);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onVersionConflict).toHaveBeenCalledTimes(1);
  });

  it('não declara sucesso quando só o registro principal foi confirmado', async () => {
    const local = project('rascunho');
    const error = new CloudProjectPartialSyncError('v2', new Error('coleção indisponível'));
    const commit = vi.fn<typeof upsertCloudProject>().mockRejectedValue(error);
    const onAccepted = vi.fn();

    const result = await projectSaveAttempt({
      project: local, organizationId: 'equipe-1', expectedUpdatedAt: () => 'v1',
      onAccepted, onFieldConflict: vi.fn(), onVersionConflict: vi.fn(), commit,
    });

    expect(result).toEqual({ project: local, json: JSON.stringify(local), updatedAt: 'v2', partialSyncError: error });
    expect(onAccepted).not.toHaveBeenCalled();
  });
});
