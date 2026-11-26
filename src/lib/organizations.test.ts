import { describe, expect, it } from 'vitest';
import type { AppView } from '@/types/project';
import {
  canAccessAppView,
  canDeleteProject,
  canEditDailyReport,
  canEditProject,
  canEditWarehouse,
  getRestrictedFallbackView,
  ORG_ROLE_OPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
} from './organizations';

describe('função Almoxarife', () => {
  it('limita Fiscalização à consulta do Diário e ao registro fiscal separado', () => {
    expect(ORG_ROLE_OPTIONS).toContain('fiscal');
    expect(ROLE_LABELS.fiscal).toBe('Fiscalização');
    expect(ROLE_PERMISSIONS.fiscal).toContain('Registrar apontamentos e fotos da fiscalização');
    const otherViews: AppView[] = ['dashboard', 'management', 'gantt', 'physicalFinancial', 'tasks', 'measurement', 'additive', 'additiveSchedule', 'realCost', 'materials', 'warehouse'];
    otherViews.forEach(view => expect(canAccessAppView('fiscal', view)).toBe(false));
    expect(canAccessAppView('fiscal', 'dailyReport')).toBe(true);
    expect(getRestrictedFallbackView('fiscal')).toBe('dailyReport');
    expect(canEditDailyReport('fiscal')).toBe(false);
    expect(canEditProject('fiscal')).toBe(false);
    expect(canEditWarehouse('fiscal')).toBe(false);
  });
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

  it('reserva a exclusão de obras ao Proprietário', () => {
    expect(canDeleteProject('owner')).toBe(true);
    expect(canDeleteProject('admin')).toBe(false);
    expect(ROLE_PERMISSIONS.admin).not.toContain('Criar e excluir obras');
  });

  it('recusa todas as áreas da aplicação exceto o Almoxarifado', () => {
    const views: AppView[] = ['dashboard', 'management', 'gantt', 'tasks', 'measurement', 'dailyReport', 'additive', 'additiveSchedule', 'realCost', 'materials'];
    views.forEach(view => expect(canAccessAppView('warehouse_operator', view)).toBe(false));
    expect(canAccessAppView('warehouse_operator', 'warehouse')).toBe(true);
    expect(canAccessAppView('engineer', 'dashboard')).toBe(false);
    expect(canAccessAppView('engineer', 'realCost')).toBe(false);
    expect(canAccessAppView('engineer', 'gantt')).toBe(true);
  });

  it('reserva a Equipe de campo ao Diário de Obra, inclusive como rota de retorno', () => {
    const views: AppView[] = ['dashboard', 'management', 'gantt', 'tasks', 'measurement', 'additive', 'additiveSchedule', 'realCost', 'materials', 'warehouse'];
    views.forEach(view => expect(canAccessAppView('field_user', view)).toBe(false));
    expect(canAccessAppView('field_user', 'dailyReport')).toBe(true);
    expect(canEditDailyReport('field_user')).toBe(true);
    expect(getRestrictedFallbackView('field_user')).toBe('dailyReport');
    expect(ROLE_PERMISSIONS.field_user).toContain('Acessar somente o Diário de Obra');
  });

  it('reserva a conferência de custos fiscais ao Administrador e ao Proprietário', () => {
    expect(ROLE_PERMISSIONS.admin).toContain('Conferir frete e ICMS/DIFAL das entradas fiscais');
    expect(ROLE_PERMISSIONS.engineer).not.toContain('Conferir frete e ICMS/DIFAL das entradas fiscais');
  });
});
