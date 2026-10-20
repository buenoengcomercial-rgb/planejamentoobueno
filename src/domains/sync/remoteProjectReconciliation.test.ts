import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { planRealtimeProjectRefresh, reconcileRemoteProjectSnapshot } from './remoteProjectReconciliation';

function project(name = 'Obra', observations = 'Original'): Project {
  return {
    id: 'obra-1', name, startDate: '2026-10-01', endDate: '2026-12-01',
    phases: [], totalBudget: 0,
    dailyReports: [{ id: 'diario-1', date: '2026-10-20', observations }],
    additives: [],
  } as Project;
}

describe('conciliação remota delimitada por domínio', () => {
  it('marca eventos do Almoxarifado como externos à Medição', () => {
    const plan = planRealtimeProjectRefresh(['warehouse_movements'], ['measurements']);
    expect(plan.requestCollections).toEqual(['warehouseMovements']);
    expect(plan.activeCollections).toEqual([]);
    expect(plan.inactiveCollections).toEqual(['warehouseMovements']);
  });

  it('atualiza o Diário sem confirmar um Aditivo local ainda pendente', () => {
    const confirmed = project();
    const local = { ...confirmed, additives: [{
      id: 'aditivo-local', name: 'Rascunho', importedAt: '2026-10-20', compositions: [],
    }] } as Project;
    const remote = project('Obra', 'Atualizado por outro usuário');
    const result = reconcileRemoteProjectSnapshot({
      local, remote, savedProjectJson: serializeProject(confirmed), collections: ['dailyReports'],
    });

    expect(result.project.dailyReports?.[0]?.observations).toBe('Atualizado por outro usuário');
    expect(result.project.additives).toEqual(local.additives);
    expect(JSON.parse(result.confirmedBaselineJson).additives).toEqual([]);
    expect(result.hasPendingLocalChanges).toBe(true);
  });

  it('não substitui as coleções da tela ao receber apenas metadados', () => {
    const local = project();
    const remote = { ...project('Nome remoto', 'Diário parcial'), additives: [] };
    const result = reconcileRemoteProjectSnapshot({
      local, remote, savedProjectJson: serializeProject(local), collections: [], metadataOnly: true,
    });

    expect(result.project.name).toBe('Nome remoto');
    expect(result.project.dailyReports).toEqual(local.dailyReports);
    expect(result.hasPendingLocalChanges).toBe(false);
  });

  it('não afirma que uma edição foi confirmada sem uma base salva conhecida', () => {
    const local = project('Edição local');
    const result = reconcileRemoteProjectSnapshot({
      local, remote: project(), savedProjectJson: null, collections: ['dailyReports'],
    });
    expect(result.project.name).toBe('Edição local');
    expect(result.hasPendingLocalChanges).toBe(true);
  });
});
