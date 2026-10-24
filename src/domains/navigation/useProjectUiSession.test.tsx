import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppView } from '@/types/project';
import { readAppUiSession } from '@/lib/appUiSession';
import { useProjectUiSession } from './useProjectUiSession';

const key = 'obraplanner:ui-session';
const main = document.createElement('main');
const mainScrollRef = { current: main };
const setCurrentView = vi.fn();

function options(projectId: string, currentView: AppView = 'dashboard', routeView?: string) {
  return {
    projectId, currentView, routeView, setCurrentView,
    role: 'owner' as const, bootLoading: false, mainScrollRef,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  main.scrollTo = vi.fn();
});

afterEach(() => vi.restoreAllMocks());

describe('sessão visual da obra', () => {
  it('persiste a aba e a rolagem, sem depender da gravação da obra', () => {
    const { rerender } = renderHook(({ projectId, currentView, routeView }) => useProjectUiSession(
      options(projectId, currentView, routeView),
    ), { initialProps: { projectId: 'obra-1', currentView: 'dashboard' as AppView, routeView: 'dashboard' } });

    rerender({ projectId: 'obra-1', currentView: 'measurement', routeView: 'medicao' });
    expect(readAppUiSession()).toMatchObject({ projectId: 'obra-1', view: 'measurement' });

    Object.defineProperty(main, 'scrollTop', { configurable: true, value: 180 });
    Object.defineProperty(main, 'scrollLeft', { configurable: true, value: 35 });
    act(() => main.dispatchEvent(new Event('scroll')));
    expect(readAppUiSession()).toMatchObject({
      projectId: 'obra-1', view: 'measurement', mainScrollTop: 180, mainScrollLeft: 35,
    });
  });

  it('restaura a posição somente da obra correspondente e respeita a rota explícita', () => {
    localStorage.setItem(key, JSON.stringify({
      version: 1, projectId: 'obra-1', view: 'measurement',
      mainScrollTop: 240, mainScrollLeft: 10, updatedAt: '2026-10-24T00:00:00Z',
    }));
    const { rerender } = renderHook(({ projectId, routeView }) => useProjectUiSession(
      options(projectId, 'dashboard', routeView),
    ), { initialProps: { projectId: 'obra-2', routeView: 'dashboard' } });
    expect(main.scrollTo).not.toHaveBeenCalled();

    rerender({ projectId: 'obra-1', routeView: 'dashboard' });
    expect(setCurrentView).not.toHaveBeenCalled();
    expect(main.scrollTo).toHaveBeenCalledWith({ top: 240, left: 10 });
  });

  it('retoma a aba lembrada quando a URL não indica uma aba', () => {
    localStorage.setItem(key, JSON.stringify({
      version: 1, projectId: 'obra-1', view: 'measurement',
      updatedAt: '2026-10-24T00:00:00Z',
    }));
    renderHook(() => useProjectUiSession(options('obra-1')));
    expect(setCurrentView).toHaveBeenCalledWith('measurement');
    expect(main.scrollTo).not.toHaveBeenCalled();
  });

  it('não abre a aba lembrada quando o perfil perdeu acesso', () => {
    localStorage.setItem(key, JSON.stringify({
      version: 1, projectId: 'obra-1', view: 'measurement',
      updatedAt: '2026-10-24T00:00:00Z',
    }));
    renderHook(() => useProjectUiSession({
      ...options('obra-1'), role: 'warehouse_operator',
    }));
    expect(setCurrentView).not.toHaveBeenCalled();
  });
});
