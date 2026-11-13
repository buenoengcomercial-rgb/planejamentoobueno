import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { planRealtimeProjectRefresh, rebaseStoredProjectDraft, reconcileRemoteProjectSnapshot } from './remoteProjectReconciliation';

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
    expect(result.conflict).toBe(false);
  });

  it('mescla duas linhas diferentes da mesma coleção sem descartar o rascunho', () => {
    const confirmed = project();
    const local = { ...confirmed, dailyReports: [
      ...confirmed.dailyReports!, { id: 'diario-2', date: '2026-10-21', observations: 'Local' },
    ] } as Project;
    const remote = project('Obra', 'Remoto');
    const result = reconcileRemoteProjectSnapshot({
      local, remote, savedProjectJson: serializeProject(confirmed), collections: ['dailyReports'],
    });
    expect(result.conflict).toBe(false);
    expect(result.project.dailyReports?.map(report => report.observations)).toEqual(['Remoto', 'Local']);
    expect(result.hasPendingLocalChanges).toBe(true);
  });

  it('mescla campos diferentes da mesma linha', () => {
    const confirmed = project();
    const local = project();
    local.dailyReports![0].occurrences = 'Ocorrência local';
    const remote = project('Obra', 'Observação remota');
    const result = reconcileRemoteProjectSnapshot({
      local, remote, savedProjectJson: serializeProject(confirmed), collections: ['dailyReports'],
    });
    expect(result.conflict).toBe(false);
    expect(result.project.dailyReports?.[0]).toMatchObject({
      observations: 'Observação remota', occurrences: 'Ocorrência local',
    });
  });

  it('protege colisão no mesmo campo da mesma entidade', () => {
    const confirmed = project();
    const local = project('Obra', 'Texto local');
    const remote = project('Obra', 'Texto remoto');
    const result = reconcileRemoteProjectSnapshot({
      local, remote, savedProjectJson: serializeProject(confirmed), collections: ['dailyReports'],
    });
    expect(result.conflict).toBe(true);
    expect(result.project).toBe(local);
    expect(result.confirmedBaselineJson).toBe(serializeProject(confirmed));
  });

  it('rebaseia rascunho recuperado após mudança de versão em outro domínio', () => {
    const baseline = project();
    const local = { ...baseline, additives: [{ id: 'aditivo-local', name: 'Local' }] } as Project;
    const remote = project('Nome remoto');
    const merged = rebaseStoredProjectDraft(baseline, local, remote, ['dailyReports', 'additives']);
    expect(merged?.name).toBe('Nome remoto');
    expect(merged?.additives).toEqual(local.additives);
  });

  it('não rebaseia rascunho recuperado com colisão de metadados', () => {
    expect(rebaseStoredProjectDraft(project(), project('Local'), project('Remoto'), ['dailyReports'])).toBeNull();
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
    expect(result.conflict).toBe(true);
  });
});
