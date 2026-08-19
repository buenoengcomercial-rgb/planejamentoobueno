import { describe, expect, it } from 'vitest';
import type { AppView } from '@/types/project';
import {
  canAccessAppView,
  canDeleteProject,
  canEditProject,
  canEditWarehouse,
  ORG_ROLE_OPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
} from './organizations';

describe('função Almoxarife', () => {
  it('aparece entre as funções disponíveis com descrição operacional', () => {
    expect(ORG_ROLE_OPTIONS).toContain('warehouse_operator');
    expect(ROLE_LABELS.warehouse_operator).toBe('Almoxarife');
    expect(ROLE_PERMISSIONS.warehouse_operator).toContain('Acessar somente o Almoxarifado');
  });

  it('edita o Almoxarifado sem receber permissão geral ou exclusão de obra', () => {
    expect(canEditWarehouse('warehouse_operator')).toBe(true);
    expect(canEditProject('warehouse_operator')).toBe(false);
    expect(canDeleteProject('warehouse_operator')).toBe(false);
  });

  it('recusa todas as áreas da aplicação exceto o Almoxarifado', () => {
    const views: AppView[] = ['dashboard', 'management', 'gantt', 'tasks', 'measurement', 'dailyReport', 'additive', 'additiveSchedule', 'realCost', 'materials'];
    views.forEach(view => expect(canAccessAppView('warehouse_operator', view)).toBe(false));
    expect(canAccessAppView('warehouse_operator', 'warehouse')).toBe(true);
    expect(canAccessAppView('engineer', 'dashboard')).toBe(true);
  });
});
