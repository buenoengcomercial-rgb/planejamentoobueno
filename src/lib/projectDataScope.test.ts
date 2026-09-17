import { describe, expect, it } from 'vitest';
import {
  PROJECT_COLLECTION_KEYS,
  normalizeProjectCollections,
  projectAreasForCollections,
  projectCollectionsForView,
  projectCollectionsForRealtimeTable,
  readWarehouseTab,
} from '@/lib/projectDataScope';

describe('escopos progressivos de dados da obra', () => {
  it('abre o Dashboard sem carregar históricos operacionais pesados', () => {
    const scope = projectCollectionsForView('dashboard');

    expect(scope).toEqual(expect.arrayContaining([
      'eapChapters',
      'tasks',
      'measurements',
      'additives',
      'budgetItems',
      'materialComparisons',
      'analyticCompositions',
    ]));
    expect(scope).not.toContain('warehouseRequisitions');
    expect(scope).not.toContain('warehouseMovements');
    expect(scope).not.toContain('auditLogs');
    expect(scope).not.toContain('dailyReports');
    expect(scope.length).toBeLessThan(PROJECT_COLLECTION_KEYS.length / 2);
  });

  it('carrega na aba Retiradas somente o necessário para saldo, histórico e cautelas', () => {
    const scope = projectCollectionsForView('warehouse', 'requisicoes');

    expect(scope).toEqual(expect.arrayContaining([
      'warehouseMovements',
      'warehouseRequisitions',
      'warehouseCustody',
      'stockMovements',
      'eapChapters',
      'tasks',
      'dailyReports',
      'auditLogs',
    ]));
    expect(scope).not.toContain('budgetItems');
    expect(scope).not.toContain('analyticCompositions');
    expect(scope).not.toContain('additives');
    expect(scope.length).toBeLessThanOrEqual(PROJECT_COLLECTION_KEYS.length / 2);
  });

  it('mantém capítulos e tarefas como uma fotografia indivisível', () => {
    expect(normalizeProjectCollections(['tasks'])).toEqual(['eapChapters', 'tasks']);
    expect(normalizeProjectCollections(['eapChapters'])).toEqual(['eapChapters', 'tasks']);
  });

  it('traduz eventos remotos em coleções e áreas sem misturar domínios', () => {
    expect(projectCollectionsForRealtimeTable('warehouse_requisitions')).toEqual([
      'warehouseRequisitions',
    ]);
    expect(projectCollectionsForRealtimeTable('tasks')).toEqual(['eapChapters', 'tasks']);
    expect(projectCollectionsForRealtimeTable('projects')).toEqual([]);
    expect(projectCollectionsForRealtimeTable('tabela_desconhecida')).toEqual([]);

    expect(projectAreasForCollections([
      'warehouseRequisitions',
      'dailyReports',
      'tasks',
    ])).toEqual(['Almoxarifado', 'Diário de Obra', 'Planejamento e campo']);
  });

  it('carrega anexos legados apenas ao Proprietário e somente na manutenção', () => {
    expect(projectCollectionsForView('warehouse', 'manutencao')).toEqual(expect.arrayContaining([
      'warehouseRequisitions',
      'warehouseCustody',
      'dailyReports',
    ]));
    expect(projectCollectionsForView('warehouse', 'manutencao')).not.toContain('budgetItems');

    window.sessionStorage.setItem('obraplanner:warehouse-tab:obra-teste', 'manutencao');
    expect(readWarehouseTab('obra-teste', true, false)).toBe('painel');
    expect(readWarehouseTab('obra-teste', true, true)).toBe('manutencao');
  });
});
