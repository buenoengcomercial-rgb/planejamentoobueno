import { flushSync } from 'react-dom';
import type { MutableRefObject } from 'react';
import { toast } from 'sonner';
import type { AppView, Project } from '@/types/project';
import type { SaveStatus } from '@/components/SaveStatusIndicator';
import { CloudProjectConflictError } from '@/lib/cloudProjects';
import { getPendingFormNames } from '@/lib/pendingFormNavigation';
import { flushPendingEditCommits } from '@/lib/pendingEditCommits';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { canAccessAppView, type OrgRole } from '@/lib/organizations';

type PendingProjectDraft = { project: Project; baseUpdatedAt: string | null };

export interface PendingSaveGuardContext {
  userId: string | undefined;
  orgId: string | undefined;
  project: Project | null;
  initialLoadRef: MutableRefObject<boolean>;
  canPersistProject: boolean;
  productionCaptureBusyRef: MutableRefObject<boolean>;
  conflictDetectedRef: MutableRefObject<boolean>;
  warehouseClientOperationInFlightRef: MutableRefObject<Promise<unknown> | null>;
  pendingDailyReportSavesRef: MutableRefObject<number>;
  dailyReportSaveQueueRef: MutableRefObject<Promise<unknown>>;
  warehouseOperationInFlightRef: MutableRefObject<Promise<unknown> | null>;
  warehouseScopedOperationInFlightRef: MutableRefObject<Promise<unknown> | null>;
  saveTimerRef: MutableRefObject<number | null>;
  inFlightSaveRef: MutableRefObject<Promise<void> | null>;
  partialSyncPendingRef: MutableRefObject<{ projectId: string } | null>;
  rawProjectRef: MutableRefObject<Project | null>;
  lastSavedProjectJsonRef: MutableRefObject<string | null>;
  requireCloudConfirmation?: boolean;
  persistProject: (project: Project, orgId: string) => Promise<unknown>;
  handleCloudConflict: (project: Project) => Promise<void>;
  setSaveStatus: (status: SaveStatus) => void;
}

/** Aguarda apenas as gravações responsáveis pela obra que será deixada. */
export async function flushPendingProjectSave(context: PendingSaveGuardContext): Promise<boolean> {
  const {
    userId, orgId, project, initialLoadRef, canPersistProject, productionCaptureBusyRef,
    conflictDetectedRef, warehouseClientOperationInFlightRef, pendingDailyReportSavesRef,
    dailyReportSaveQueueRef, warehouseOperationInFlightRef, warehouseScopedOperationInFlightRef,
    saveTimerRef, inFlightSaveRef, partialSyncPendingRef, rawProjectRef,
    lastSavedProjectJsonRef, requireCloudConfirmation,
    persistProject, handleCloudConflict, setSaveStatus,
  } = context;

  const confirmLatestProject = async (): Promise<boolean> => {
    if (conflictDetectedRef.current || partialSyncPendingRef.current?.projectId === project?.id) return false;
    if (!requireCloudConfirmation || !project) return true;
    const latest = rawProjectRef.current;
    if (!latest || latest.id !== project.id) return false;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (serializeProject(latest) === lastSavedProjectJsonRef.current) return true;
    setSaveStatus('saving');
    try {
      await persistProject(latest, orgId!);
      const current = rawProjectRef.current;
      if (current?.id === project.id && serializeProject(current) === lastSavedProjectJsonRef.current
        && !conflictDetectedRef.current && partialSyncPendingRef.current?.projectId !== project.id) return true;
      setSaveStatus('pending');
      toast.warning('A edição mais recente ainda não foi confirmada na nuvem. Tente sair novamente.');
      return false;
    } catch (error) {
      console.warn(error);
      if (error instanceof CloudProjectConflictError) await handleCloudConflict(latest);
      else {
        setSaveStatus(navigator.onLine ? 'error' : 'offline');
        toast.error('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
      }
      return false;
    }
  };

  if (productionCaptureBusyRef.current) { toast.warning('Aguarde a confirmação conjunta da captura antes de sair desta área.'); return false; }
  if (!userId || !orgId || !project || !initialLoadRef.current || !canPersistProject) return true;
  if (conflictDetectedRef.current) {
    setSaveStatus('conflict');
    toast.warning('Resolva a divergência entre a cópia local e a nuvem antes de sair desta área.');
    return false;
  }

  // Uma retirada com fotos começa antes da RPC. Aguarde upload, transação e Diário.
  if (warehouseClientOperationInFlightRef.current) {
    try { await warehouseClientOperationInFlightRef.current; } catch { return false; }
    if (conflictDetectedRef.current) return false;
  }
  if (pendingDailyReportSavesRef.current > 0) {
    try { await dailyReportSaveQueueRef.current; } catch { return false; }
    if (conflictDetectedRef.current) return false;
  }
  if (warehouseOperationInFlightRef.current) {
    try { await warehouseOperationInFlightRef.current; } catch { return false; }
    if (conflictDetectedRef.current) return false;
  }
  if (warehouseScopedOperationInFlightRef.current) {
    try { await warehouseScopedOperationInFlightRef.current; } catch { return false; }
    if (conflictDetectedRef.current) return false;
  }

  while (pendingDailyReportSavesRef.current > 0 || inFlightSaveRef.current) {
    if (pendingDailyReportSavesRef.current > 0) {
      try { await dailyReportSaveQueueRef.current; } catch { return false; }
      if (conflictDetectedRef.current) return false;
      continue;
    }
    try {
      await inFlightSaveRef.current;
    } catch (error) {
      if (error instanceof CloudProjectConflictError && rawProjectRef.current && !conflictDetectedRef.current) {
        await handleCloudConflict(rawProjectRef.current);
      }
      return false;
    }
  }

  // Keep the scheduled edit if the active write fails before the flush.
  const timer = saveTimerRef.current;
  if (timer !== null) {
    window.clearTimeout(timer);
    saveTimerRef.current = null;
  }
  if (timer !== null && !requireCloudConfirmation && !conflictDetectedRef.current
    && partialSyncPendingRef.current?.projectId !== project.id) {
    const latest = rawProjectRef.current;
    if (latest?.id !== project.id) return false;
    setSaveStatus('saving');
    try {
      await persistProject(latest, orgId);
      return confirmLatestProject();
    } catch (error) {
      console.warn(error);
      if (error instanceof CloudProjectConflictError) {
        await handleCloudConflict(latest);
      } else {
        setSaveStatus(navigator.onLine ? 'error' : 'offline');
        toast.error('Erro ao salvar na nuvem. Sua alteração ficou apenas neste navegador.');
      }
      return false;
    }
  }

  if (partialSyncPendingRef.current?.projectId === project.id) {
    setSaveStatus(navigator.onLine ? 'error' : 'offline');
    toast.warning('Confirme a sincronização detalhada em “Tentar novamente” antes de sair desta área.');
    return false;
  }
  return confirmLatestProject();
}

export async function runProtectedProjectNavigation<T>(
  navigationInFlightRef: MutableRefObject<boolean>,
  flushPendingSave: () => Promise<boolean>,
  action: () => Promise<T>,
): Promise<T | undefined> {
  if (getPendingFormNames().length > 0) {
    toast.warning('Conclua ou descarte o formulário em preenchimento antes de trocar de obra ou sair desta área.');
    return undefined;
  }
  if (navigationInFlightRef.current) {
    toast.warning('Aguarde a navegação atual terminar.');
    return undefined;
  }
  navigationInFlightRef.current = true;
  try {
    if (!(await flushPendingSave())) return undefined;
    return await action();
  } finally {
    navigationInFlightRef.current = false;
  }
}

export interface ProjectViewNavigationContext {
  role: OrgRole | undefined;
  currentView: AppView;
  warehouseClientOperationInFlightRef: MutableRefObject<Promise<unknown> | null>;
  warehouseOperationInFlightRef: MutableRefObject<Promise<unknown> | null>;
  warehouseScopedOperationInFlightRef: MutableRefObject<Promise<unknown> | null>;
  navigationInFlightRef: MutableRefObject<boolean>;
  flushPendingAdditiveSave: () => Promise<boolean>;
  pendingDraftRef: MutableRefObject<PendingProjectDraft | null>;
  conflictDetectedRef: MutableRefObject<boolean>;
  cancelScheduledDraft: (projectId: string) => void;
  writeProtectedProjectDraft: (project: Project, baseUpdatedAt: string | null) => void;
  setProductionWorkspaceInitialTab: (tab: 'production' | 'dailyReport') => void;
  setDailyReportInitialFilter: (filter: string | undefined) => void;
  setCurrentView: (view: AppView) => void;
  setSidebarOpen: (open: boolean) => void;
  confirmDiscardPendingForm: (
    options: { title: string; description: string; cancelLabel: string; confirmLabel: string },
    onConfirm: () => void,
  ) => void;
}

/** Troca de aba sem transformar preferência visual em gravação da obra. */
export function navigateToProjectView(context: ProjectViewNavigationContext, nextView: AppView): void {
  const {
    role, currentView, warehouseClientOperationInFlightRef, warehouseOperationInFlightRef,
    warehouseScopedOperationInFlightRef, navigationInFlightRef, flushPendingAdditiveSave,
    pendingDraftRef, conflictDetectedRef,
    cancelScheduledDraft, writeProtectedProjectDraft, setProductionWorkspaceInitialTab,
    setDailyReportInitialFilter, setCurrentView, setSidebarOpen, confirmDiscardPendingForm,
  } = context;
  if (role && !canAccessAppView(role, nextView)) return;
  if (warehouseClientOperationInFlightRef.current || warehouseOperationInFlightRef.current || warehouseScopedOperationInFlightRef.current) {
    toast.warning('Aguarde a confirmação da operação do Almoxarifado na nuvem.');
    return;
  }
  if (nextView === currentView) return;
  flushSync(() => { flushPendingEditCommits(); });
  const pendingDraft = pendingDraftRef.current;
  if (pendingDraft && !conflictDetectedRef.current) {
    cancelScheduledDraft(pendingDraft.project.id);
    writeProtectedProjectDraft(pendingDraft.project, pendingDraft.baseUpdatedAt);
  }
  const switchView = () => {
    if (nextView === 'tasks') setProductionWorkspaceInitialTab('production');
    if (nextView === 'dailyReport') {
      setProductionWorkspaceInitialTab('dailyReport');
      setDailyReportInitialFilter(undefined);
    }
    setCurrentView(nextView);
    setSidebarOpen(false);
  };
  const switchAfterSave = () => {
    if (currentView !== 'additiveSchedule') { switchView(); return; }
    if (navigationInFlightRef.current) {
      toast.warning('Aguarde a confirmação do Cronograma do Aditivo antes de navegar.');
      return;
    }
    navigationInFlightRef.current = true;
    void (async () => {
      try {
        if (await flushPendingAdditiveSave()) switchView();
      } catch (error) {
        console.warn(error);
        toast.error('Não foi possível confirmar o Cronograma do Aditivo na nuvem. A edição continua preservada.');
      } finally {
        navigationInFlightRef.current = false;
      }
    })();
  };
  const forms = getPendingFormNames();
  if (forms.length > 0) {
    confirmDiscardPendingForm({
      title: 'Sair com formulário em preenchimento?',
      description: `Os dados de ${forms.join(', ')} ainda não foram confirmados.`,
      cancelLabel: 'Continuar preenchendo',
      confirmLabel: 'Descartar e sair',
    }, switchAfterSave);
    return;
  }
  switchAfterSave();
}
