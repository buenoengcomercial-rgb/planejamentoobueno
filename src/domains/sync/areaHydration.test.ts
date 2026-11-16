import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import * as cloud from '@/lib/cloudProjects';
import * as sync from '@/lib/projectSync';
import * as warehouse from '@/lib/warehouseProjectState';
import { hydrateAreaCollections, planAreaHydration } from './areaHydration';

const project = (id = 'obra'): Project => ({
  id, name: 'Obra', startDate: '2026-10-20', endDate: '2027-10-20', phases: [], totalBudget: 0,
});

beforeEach(() => vi.restoreAllMocks());

describe('hidratação delimitada da área', () => {
  it('não carrega outra aba e preserva o grupo de produção em edição', () => {
    expect(planAreaHydration(
      'obra', ['tasks'], new Set(['warehouseMovements']), undefined, undefined, [],
    ).collections).toEqual([]);
    expect(planAreaHydration(
      'obra', ['tasks', 'eapChapters'], undefined, undefined, new Set(['tasks']), ['eapChapters'],
    ).collections).toEqual([]);
  });

  it('mantém dados ainda ausentes como não prontos e não confunde carga em andamento com ausência', () => {
    const plan = planAreaHydration(
      'obra', ['tasks'], undefined, new Set(['tasks']), undefined, ['tasks'],
    );
    expect(plan).toMatchObject({ missing: ['tasks'], collections: ['eapChapters'], ready: false });
  });

  it('descarta uma leitura se a versão mudar enquanto a área é carregada', async () => {
    vi.spyOn(cloud, 'getCloudProjectVersion')
      .mockResolvedValueOnce({ updatedAt: 'v1' } as Awaited<ReturnType<typeof cloud.getCloudProjectVersion>>)
      .mockResolvedValueOnce({ updatedAt: 'v2' } as Awaited<ReturnType<typeof cloud.getCloudProjectVersion>>);
    const hydrated = project();
    vi.spyOn(sync, 'hydrateProjectFromCloud').mockResolvedValue(hydrated);
    const discard = vi.spyOn(sync, 'discardHydratedProjectCollections').mockImplementation(() => undefined);
    await expect(hydrateAreaCollections({
      projectId: 'obra', collections: ['tasks'], source: project(),
      currentProject: () => project(), savedProjectJson: () => null, isCurrent: () => true,
    })).rejects.toThrow('A obra mudou durante o carregamento');
    expect(discard).toHaveBeenCalledWith(hydrated);
  });

  it('descarta a resposta de uma aba que deixou de ser a atual', async () => {
    vi.spyOn(cloud, 'getCloudProjectVersion').mockResolvedValue({
      updatedAt: 'v1',
    } as Awaited<ReturnType<typeof cloud.getCloudProjectVersion>>);
    const hydrated = project();
    vi.spyOn(sync, 'hydrateProjectFromCloud').mockResolvedValue(hydrated);
    const discard = vi.spyOn(sync, 'discardHydratedProjectCollections').mockImplementation(() => undefined);
    const merge = vi.spyOn(sync, 'mergeHydratedProjectCollections');
    const result = await hydrateAreaCollections({
      projectId: 'obra', collections: ['tasks'], source: project(),
      currentProject: () => project(), savedProjectJson: () => null, isCurrent: () => false,
    });
    expect(result).toBeNull();
    expect(discard).toHaveBeenCalledWith(hydrated);
    expect(merge).not.toHaveBeenCalled();
  });

  it('carrega o catálogo corrente ao abrir uma aba do estoque com a versão geral intacta', async () => {
    vi.spyOn(cloud, 'getCloudProjectVersion').mockResolvedValue({
      projectId: 'obra', updatedAt: 'v1', warehouseVersion: 6, warehouseUpdatedAt: 'stock-v6',
    });
    const warehouseState = {
      locations: [], items: [], movements: [], requisitions: [], equipments: [], equipmentGroups: [],
      custodyTerms: [], receivers: [{ name: 'Recebedor atual' }],
    };
    vi.spyOn(warehouse, 'readWarehouseProjectState').mockResolvedValue({
      warehouse: warehouseState, version: 6, updatedAt: 'stock-v6',
    });
    vi.spyOn(sync, 'hydrateProjectFromCloud').mockImplementation(async source => source);
    const source: Project = { ...project(), warehouse: { ...warehouseState, receivers: [{ name: 'Legado' }] } };
    const result = await hydrateAreaCollections({
      projectId: 'obra', collections: ['warehouseRequisitions'], source,
      currentProject: () => source, savedProjectJson: () => JSON.stringify(source), isCurrent: () => true,
    });
    expect(result?.warehouseVersion).toBe(6);
    expect(result?.project.warehouse?.receivers).toEqual([{ name: 'Recebedor atual' }]);
    expect(JSON.parse(result!.savedProjectJson).warehouse.receivers).toEqual([{ name: 'Recebedor atual' }]);
  });
});
