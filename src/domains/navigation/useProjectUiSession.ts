import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { AppView } from '@/types/project';
import { canAccessAppView } from '@/lib/organizations';
import { readAppUiSession, writeAppUiSession } from '@/lib/appUiSession';

interface ProjectUiSessionOptions {
  projectId: string | null;
  currentView: AppView;
  setCurrentView: Dispatch<SetStateAction<AppView>>;
  routeView?: string;
  role?: Parameters<typeof canAccessAppView>[0];
  bootLoading: boolean;
  mainScrollRef: RefObject<HTMLElement | null>;
}

/** Guarda apenas a posição visual da obra; não participa do salvamento de dados. */
export function useProjectUiSession({
  projectId, currentView, setCurrentView, routeView, role, bootLoading, mainScrollRef,
}: ProjectUiSessionOptions) {
  const restoredSessionRef = useRef<string | null>(null);
  const saverReadyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    if (saverReadyRef.current !== projectId) {
      saverReadyRef.current = projectId;
      return;
    }

    writeAppUiSession({
      projectId, view: currentView,
      mainScrollTop: mainScrollRef.current?.scrollTop ?? 0,
      mainScrollLeft: mainScrollRef.current?.scrollLeft ?? 0,
      windowScrollX: window.scrollX, windowScrollY: window.scrollY,
    });
  }, [currentView, projectId, mainScrollRef]);

  useEffect(() => {
    if (!projectId) return;
    let rafId = 0;
    const persistScroll = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        writeAppUiSession({
          projectId, view: currentView,
          mainScrollTop: mainScrollRef.current?.scrollTop ?? 0,
          mainScrollLeft: mainScrollRef.current?.scrollLeft ?? 0,
          windowScrollX: window.scrollX, windowScrollY: window.scrollY,
        });
      });
    };

    const main = mainScrollRef.current;
    window.addEventListener('scroll', persistScroll, { passive: true });
    main?.addEventListener('scroll', persistScroll, { passive: true });
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', persistScroll);
      main?.removeEventListener('scroll', persistScroll);
    };
  }, [currentView, projectId, mainScrollRef]);

  useEffect(() => {
    if (bootLoading || !projectId) return;
    const session = readAppUiSession();
    if (!session || (session.projectId && session.projectId !== projectId)) return;
    const restoreKey = `${projectId}:${session.view ?? 'none'}:${session.updatedAt}`;
    if (restoredSessionRef.current === restoreKey) return;

    if (!routeView && session.view && session.view !== currentView && (!role || canAccessAppView(role, session.view))) {
      setCurrentView(session.view);
      return;
    }

    restoredSessionRef.current = restoreKey;
    window.requestAnimationFrame(() => {
      if (typeof session.windowScrollX === 'number' || typeof session.windowScrollY === 'number') {
        window.scrollTo(session.windowScrollX ?? 0, session.windowScrollY ?? 0);
      }
      mainScrollRef.current?.scrollTo({
        left: session.mainScrollLeft ?? 0,
        top: session.mainScrollTop ?? 0,
      });
    });
  }, [bootLoading, currentView, projectId, role, routeView, setCurrentView, mainScrollRef]);
}
