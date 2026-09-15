import { describe, expect, it } from 'vitest';
import {
  PROJECT_COLLECTION_KEYS,
  normalizeProjectCollections,
  projectCollectionsForView,
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
});
