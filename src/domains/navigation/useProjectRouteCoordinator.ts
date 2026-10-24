import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { toast } from 'sonner';
import type { AppView } from '@/types/project';
import { ROUTE_VIEW, VIEW_ROUTE } from '@/lib/appUiSession';
import { canAccessAppView } from '@/lib/organizations';

interface ProjectRouteOptions {
  routeView?: string;
  pathname: string;
  search: string;
  navigate: NavigateFunction;
  role?: Parameters<typeof canAccessAppView>[0];
  restrictedFallbackView: AppView;
  currentView: AppView;
  safeCurrentView: AppView;
  projectId: string | null;
  warehouseLockedRouteRef: RefObject<string | null>;
  setCurrentView: Dispatch<SetStateAction<AppView>>;
  setDailyReportInitialDate: Dispatch<SetStateAction<string | undefined>>;
  setDailyReportInitialFilter: Dispatch<SetStateAction<string | undefined>>;
  setDailyReportNavKey: Dispatch<SetStateAction<number>>;
  setProductionWorkspaceInitialTab: Dispatch<SetStateAction<'production' | 'dailyReport'>>;
}

/** Mantém URL, área ativa e atalhos do Diário coerentes sem alterar dados da obra. */
export function useProjectRouteCoordinator({
  routeView, pathname, search, navigate, role, restrictedFallbackView,
  currentView, safeCurrentView, projectId, warehouseLockedRouteRef,
  setCurrentView, setDailyReportInitialDate, setDailyReportInitialFilter,
  setDailyReportNavKey, setProductionWorkspaceInitialTab,
}: ProjectRouteOptions) {
  useEffect(() => {
    const requestedView = routeView ? ROUTE_VIEW[routeView] : undefined;
    const routedView = requestedView && role && !canAccessAppView(role, requestedView)
      ? restrictedFallbackView
      : requestedView;
    const lockedWarehouseRoute = warehouseLockedRouteRef.current;
    const browserRoute = `${pathname}${search}`;
    if (lockedWarehouseRoute && browserRoute !== lockedWarehouseRoute) {
      navigate(lockedWarehouseRoute, { replace: true });
      toast.warning('Aguarde a confirmação da operação do Almoxarifado na nuvem.');
      return;
    }
    if (routedView) setCurrentView(previous => previous === routedView ? previous : routedView);
    if (routedView === 'dailyReport') {
      const date = new URLSearchParams(search).get('data') || undefined;
      if (date) {
        setDailyReportInitialDate(date);
        setDailyReportNavKey(key => key + 1);
      } else {
        // Acesso comum ao Diário não herda o filtro do atalho da Medição.
        setDailyReportInitialFilter(undefined);
      }
      setProductionWorkspaceInitialTab('dailyReport');
    }
  }, [routeView, pathname, search, navigate, role, restrictedFallbackView,
    warehouseLockedRouteRef, setCurrentView, setDailyReportInitialDate,
    setDailyReportInitialFilter, setDailyReportNavKey, setProductionWorkspaceInitialTab]);

  useEffect(() => {
    const restoreWarehouseRoute = () => {
      const lockedWarehouseRoute = warehouseLockedRouteRef.current;
      if (!lockedWarehouseRoute) return;
      navigate(lockedWarehouseRoute, { replace: true });
      toast.warning('Aguarde a confirmação da operação do Almoxarifado na nuvem.');
    };
    window.addEventListener('popstate', restoreWarehouseRoute);
    return () => window.removeEventListener('popstate', restoreWarehouseRoute);
  }, [navigate, warehouseLockedRouteRef]);

  useEffect(() => {
    if (role && !canAccessAppView(role, currentView)) setCurrentView(restrictedFallbackView);
  }, [currentView, restrictedFallbackView, role, setCurrentView]);

  useEffect(() => {
    if (!projectId) return;
    const route = `/obras/${projectId}/${VIEW_ROUTE[safeCurrentView]}`;
    const keepSearch = safeCurrentView === 'management'
      || safeCurrentView === 'dailyReport'
      || (safeCurrentView === 'tasks' && new URLSearchParams(search).has('atividade'));
    const target = `${route}${keepSearch ? search : ''}`;
    if (`${pathname}${search}` !== target) navigate(target, { replace: true });
  }, [safeCurrentView, pathname, search, navigate, projectId]);
}
