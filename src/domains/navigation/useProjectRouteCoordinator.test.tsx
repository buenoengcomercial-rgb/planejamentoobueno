import { act, renderHook } from '@testing-library/react';
import type { NavigateFunction } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppView } from '@/types/project';
import { useProjectRouteCoordinator } from './useProjectRouteCoordinator';

const { warning } = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: { warning } }));

const navigate = vi.fn() as unknown as NavigateFunction;
const setCurrentView = vi.fn();
const setDailyReportInitialDate = vi.fn();
const setDailyReportInitialFilter = vi.fn();
const setDailyReportNavKey = vi.fn();
const setProductionWorkspaceInitialTab = vi.fn();
const warehouseLockedRouteRef = { current: null as string | null };

function options(view: AppView = 'dashboard') {
  return {
    routeView: 'dashboard', pathname: '/obras/obra-1/dashboard', search: '',
    navigate, role: 'owner' as const, restrictedFallbackView: 'gantt' as AppView,
    currentView: view, safeCurrentView: view, projectId: 'obra-1',
    warehouseLockedRouteRef, setCurrentView, setDailyReportInitialDate,
    setDailyReportInitialFilter, setDailyReportNavKey, setProductionWorkspaceInitialTab,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  warehouseLockedRouteRef.current = null;
});

describe('coordenação das rotas da obra', () => {
  it('mantém a data do atalho do Diário sem carregar o filtro de uma visita comum', () => {
    const { rerender } = renderHook(props => useProjectRouteCoordinator(props), {
      initialProps: {
        ...options('dailyReport'), routeView: 'diario', pathname: '/obras/obra-1/diario', search: '?data=2026-10-24',
      },
    });
    expect(setDailyReportInitialDate).toHaveBeenCalledWith('2026-10-24');
    expect(setDailyReportNavKey).toHaveBeenCalled();
    expect(setDailyReportInitialFilter).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    rerender({ ...options('dailyReport'), routeView: 'diario', pathname: '/obras/obra-1/diario', search: '' });
    expect(setDailyReportInitialFilter).toHaveBeenCalledWith(undefined);
  });

  it('conserva o parâmetro de atividade na Produção e remove busca de outra área', () => {
    const { rerender } = renderHook(props => useProjectRouteCoordinator(props), {
      initialProps: {
        ...options('tasks'), routeView: 'producao', pathname: '/obras/obra-1/producao', search: '?atividade=t-1',
      },
    });
    expect(navigate).not.toHaveBeenCalled();
    rerender({ ...options('gantt'), routeView: 'cronograma', pathname: '/obras/obra-1/cronograma', search: '?atividade=t-1' });
    expect(navigate).toHaveBeenCalledWith('/obras/obra-1/cronograma', { replace: true });
  });

  it('impede mudança de rota e retorno do navegador enquanto o Almoxarifado está travado', () => {
    warehouseLockedRouteRef.current = '/obras/obra-1/almoxarifado';
    renderHook(() => useProjectRouteCoordinator({
      ...options('warehouse'), routeView: 'medicao', pathname: '/obras/obra-1/medicao',
    }));
    expect(navigate).toHaveBeenCalledWith('/obras/obra-1/almoxarifado', { replace: true });
    expect(setCurrentView).not.toHaveBeenCalled();
    const beforeBack = vi.mocked(navigate).mock.calls.length;
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(navigate).toHaveBeenCalledTimes(beforeBack + 1);
    expect(warning).toHaveBeenCalledWith('Aguarde a confirmação da operação do Almoxarifado na nuvem.');
  });

  it('redireciona perfil restrito para sua aba permitida', () => {
    renderHook(() => useProjectRouteCoordinator({
      ...options('warehouse'), routeView: 'medicao', pathname: '/obras/obra-1/medicao',
      role: 'warehouse_operator', restrictedFallbackView: 'warehouse', safeCurrentView: 'warehouse',
    }));
    expect(setCurrentView).toHaveBeenCalledWith(expect.any(Function));
    expect(navigate).toHaveBeenCalledWith('/obras/obra-1/almoxarifado', { replace: true });
  });
});
