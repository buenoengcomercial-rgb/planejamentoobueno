import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { toast } from 'sonner';
import type { DailyReport, Project } from '@/types/project';
import type { SaveStatus } from '@/components/SaveStatusIndicator';
import type { CloudProjectMeta, CloudProjectVersion } from '@/lib/cloudProjects';
import { getCloudProjectVersion } from '@/lib/cloudProjects';
import { getMissingProjectCollections } from '@/lib/projectSync';
import { WAREHOUSE_REMOTE_SYNC_COLLECTIONS, type ProjectCollectionKey } from '@/lib/projectDataScope';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { warehouseEditBaseline } from '@/lib/warehouseEditBaseline';
import { acknowledgeWarehouseOutbox, resolveWarehouseRequisitionPending } from '@/lib/warehouseOperationOutbox';
import { commitWarehouseOperation, mergeWarehouseCloudCommit, type WarehouseCloudCommitResult, type WarehouseCloudOperation } from '@/lib/warehouseCloudCommit';
import type { WarehouseScopedCommitResult, WarehouseScopedDomain } from '@/lib/warehouseScopedCommit';
import { saveOpenDailyReport } from '@/lib/dailyReportCloudSync';
import { reportForDate, replaceReportForDate, replaceSavedDailyReport } from '@/domains/dailyReport/dailyReportProject';

type WarehousePrepareScope = WarehouseScopedDomain | 'requisition';

export const WAREHOUSE_OPERATION_COLLECTIONS: Record<WarehousePrepareScope, readonly ProjectCollectionKey[]> = {
  receipt: ['warehouseMovements', 'stockMovements'],
  custody: ['warehouseMovements', 'stockMovements', 'warehouseCustody'],
  inventory: ['warehouseMovements', 'stockMovements'],
  adjustment: ['warehouseMovements', 'stockMovements'],
  catalog: ['warehouseMovements', 'stockMovements'],
  requisition: ['warehouseMovements', 'warehouseRequisitions', 'stockMovements', 'dailyReports'],
};

export interface WarehouseOperationCoordinatorDeps {
  project: Project | null;
  orgId: string | undefined;
  userId: string | undefined;
  warehouseEditor: boolean;
  rawProjectRef: MutableRefObject<Project | null>;
  productionCaptureBusyRef: MutableRefObject<boolean>;
  conflictDetectedRef: MutableRefObject<boolean>;
  saveTimerRef: MutableRefObject<number | null>;
  inFlightSaveRef: MutableRefObject<Promise<void> | null>;
  partialSyncPendingRef: MutableRefObject<{ projectId: string } | null>;
  currentWarehouseVersionRef: MutableRefObject<number | null>;
  lastObservedWarehouseVersionRef: MutableRefObject<number | null>;
  currentProjectUpdatedAtRef: MutableRefObject<string | null>;
  lastSavedProjectJsonRef: MutableRefObject<string | null>;
  ownWarehouseRealtimeRowsRef: MutableRefObject<Map<string, number>>;
  skipNextAutoSaveRef: MutableRefObject<boolean>;
  dailyReportSaveQueueRef: MutableRefObject<Promise<unknown>>;
  navigationInFlightRef: MutableRefObject<boolean>;
  warehouseClientOperationInFlightRef: MutableRefObject<Promise<unknown> | null>;
  warehouseOperationInFlightRef: MutableRefObject<Promise<WarehouseCloudCommitResult> | null>;
  warehouseScopedOperationInFlightRef: MutableRefObject<Promise<Project> | null>;
  warehouseLockedRouteRef: MutableRefObject<string | null>;
  currentRouteRef: MutableRefObject<string>;
  persistProject: (project: Project, orgId: string) => Promise<void>;
  refreshRemoteCollectionsInBackground: (project: Project, collections: readonly ProjectCollectionKey[], version?: CloudProjectVersion) => Promise<Project | null>;
  discardProjectDraft: (projectId: string) => void;
  scheduleProjectDraft: (project: Project, baseUpdatedAt: string | null) => void;
  mergeConfirmedDailyReportIntoPartialSync: (projectId: string, date: string, report: DailyReport | null) => void;
  clearLocalProjectCollections: (projectId: string, collections: readonly ProjectCollectionKey[]) => void;
  setRawProject: Dispatch<SetStateAction<Project | null>>;
  setCloudList: Dispatch<SetStateAction<CloudProjectMeta[]>>;
  setCurrentProjectUpdatedAt: Dispatch<SetStateAction<string | null>>;
  setLastCloudConfirmedAt: Dispatch<SetStateAction<string | null>>;
  setSaveStatus: Dispatch<SetStateAction<SaveStatus>>;
  setDailyReportSaveErrors: Dispatch<SetStateAction<Record<string, string>>>;
}

/** Coordinates warehouse-only transactions without handing their writes to the project autosave. */
export function useWarehouseOperationCoordinator({
  project, orgId, userId, warehouseEditor, rawProjectRef, productionCaptureBusyRef,
  conflictDetectedRef, saveTimerRef, inFlightSaveRef, partialSyncPendingRef,
  currentWarehouseVersionRef, lastObservedWarehouseVersionRef, currentProjectUpdatedAtRef,
  lastSavedProjectJsonRef, ownWarehouseRealtimeRowsRef, skipNextAutoSaveRef,
  dailyReportSaveQueueRef, navigationInFlightRef, warehouseClientOperationInFlightRef,
  warehouseOperationInFlightRef, warehouseScopedOperationInFlightRef, warehouseLockedRouteRef,
  currentRouteRef, persistProject, refreshRemoteCollectionsInBackground, discardProjectDraft,
  scheduleProjectDraft, mergeConfirmedDailyReportIntoPartialSync, clearLocalProjectCollections,
  setRawProject, setCloudList, setCurrentProjectUpdatedAt, setLastCloudConfirmedAt,
  setSaveStatus, setDailyReportSaveErrors,
}: WarehouseOperationCoordinatorDeps) {
  const prepareWarehouseCloudOperation = useCallback(async (scope: WarehousePrepareScope) => {
    if (productionCaptureBusyRef.current) throw new Error('Aguarde a captura em andamento antes de salvar outra operação.');
    if (!userId || !orgId || !warehouseEditor) throw new Error('Você não tem permissão para salvar o Almoxarifado.');
    if (conflictDetectedRef.current) throw new Error('Atualize a obra antes de salvar o Almoxarifado.');
    const active = rawProjectRef.current;
    if (!active) throw new Error('Nenhuma obra está aberta para registrar a operação.');
    const missingWarehouseData = getMissingProjectCollections(
      active.id,
      WAREHOUSE_OPERATION_COLLECTIONS[scope],
    );
    if (missingWarehouseData.length > 0) {
      throw new Error('Aguarde o carregamento dos dados do Almoxarifado antes de confirmar a operação.');
    }

    // Nunca deixe um autosave geral concorrer com a transação do estoque. Uma
    // alteração anterior é confirmada primeiro; depois disso, somente a RPC
    // específica pode escrever o Almoxarifado.
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      const pending = rawProjectRef.current;
      if (pending) await persistProject(pending, orgId);
    }
    if (inFlightSaveRef.current) await inFlightSaveRef.current;
    if (rawProjectRef.current?.id !== active.id) {
      throw new Error('A obra aberta mudou durante a preparação. Reabra o Almoxarifado e tente novamente.');
    }
    if (conflictDetectedRef.current) throw new Error('Atualize a obra antes de salvar o Almoxarifado.');
    if (partialSyncPendingRef.current?.projectId === active.id) {
      throw new Error('Confirme a sincronização detalhada em “Tentar novamente” antes de operar o Almoxarifado.');
    }

    if (currentWarehouseVersionRef.current == null) {
      const remote = await getCloudProjectVersion(active.id);
      if (rawProjectRef.current?.id !== active.id) {
        throw new Error('A obra aberta mudou durante a preparação. Reabra o Almoxarifado e tente novamente.');
      }
      if (!remote) {
        throw new Error('A versão do Almoxarifado mudou. Atualize a obra antes de continuar.');
      }
      if (remote.warehouseVersion == null) {
        throw new Error('A atualização segura do Almoxarifado ainda não foi instalada no servidor. Nada foi gravado.');
      }
      currentWarehouseVersionRef.current = remote.warehouseVersion;
      lastObservedWarehouseVersionRef.current = remote.warehouseVersion;
    }
  }, [conflictDetectedRef, currentWarehouseVersionRef, inFlightSaveRef, lastObservedWarehouseVersionRef, orgId, partialSyncPendingRef, persistProject, productionCaptureBusyRef, rawProjectRef, saveTimerRef, userId, warehouseEditor]);

  const prepareWarehouseRequisitionOperation = useCallback(
    () => prepareWarehouseCloudOperation('requisition'),
    [prepareWarehouseCloudOperation],
  );

  const applyWarehouseCloudConfirmation = useCallback(async (confirmation: WarehouseCloudCommitResult) => {
    const active = rawProjectRef.current;
    if (!active || active.id !== confirmation.project.id) {
      throw new Error('A retirada foi confirmada, mas outra obra está aberta. Reabra a obra para conferir o histórico.');
    }
    if ((lastObservedWarehouseVersionRef.current ?? -1) > confirmation.warehouseVersion) {
      const version = await getCloudProjectVersion(active.id);
      const refreshed = version && await refreshRemoteCollectionsInBackground(active, WAREHOUSE_REMOTE_SYNC_COLLECTIONS, version);
      if (!refreshed || version?.warehouseVersion == null || !version.warehouseUpdatedAt) {
        throw new Error('A retirada foi confirmada, mas outra operação chegou depois. Confira a tentativa pendente para atualizar a tela.');
      }
      confirmation.project = refreshed;
      confirmation.projectUpdatedAt = version.updatedAt;
      confirmation.warehouseUpdatedAt = version.warehouseUpdatedAt;
      confirmation.warehouseVersion = version.warehouseVersion;
    }

    // A resposta da RPC do Almoxarifado é a confirmação oficial da retirada,
    // movimentos e auditoria. Um espelho legado no Diário jamais pode segurar
    // este ponto nem transformar uma confirmação em aparente falha.
    if (rawProjectRef.current?.id !== confirmation.project.id) {
      setCloudList(previous => previous.map(meta => meta.id === confirmation.project.id
        ? { ...meta, updatedAt: confirmation.projectUpdatedAt }
        : meta));
      throw new Error('A retirada foi salva na nuvem, mas outra obra está aberta. Reabra a obra original para conferi-la.');
    }

    const parseSavedBaseline = () => {
      if (!lastSavedProjectJsonRef.current) return active;
      try { return JSON.parse(lastSavedProjectJsonRef.current) as Project; }
      catch { return active; }
    };
    const savedBaseline = mergeWarehouseCloudCommit(parseSavedBaseline(), confirmation);
    const savedBaselineJson = serializeProject(savedBaseline);
    lastSavedProjectJsonRef.current = savedBaselineJson;

    const expiresAt = Date.now() + 10_000;
    ownWarehouseRealtimeRowsRef.current.set(`warehouse_requisitions:${confirmation.acknowledgement.requisitionId}`, expiresAt);
    confirmation.acknowledgement.movementIds.forEach(id => {
      ownWarehouseRealtimeRowsRef.current.set(`warehouse_movements:${id}`, expiresAt);
    });
    confirmation.acknowledgement.auditLogIds.forEach(id => {
      ownWarehouseRealtimeRowsRef.current.set(`audit_logs:${id}`, expiresAt);
    });
    currentWarehouseVersionRef.current = confirmation.warehouseVersion;
    lastObservedWarehouseVersionRef.current = confirmation.warehouseVersion;
    currentProjectUpdatedAtRef.current = confirmation.projectUpdatedAt;
    setCurrentProjectUpdatedAt(confirmation.projectUpdatedAt);
    setLastCloudConfirmedAt(confirmation.committedAt);
    setCloudList(previous => previous.map(meta => meta.id === confirmation.project.id
      ? { ...meta, updatedAt: confirmation.projectUpdatedAt }
      : meta));

    setRawProject(current => {
      if (!current || current.id !== confirmation.project.id) return current;
      const merged = mergeWarehouseCloudCommit(current, confirmation);
      const fullyConfirmed = serializeProject(merged) === savedBaselineJson;
      if (fullyConfirmed) {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        discardProjectDraft(merged.id);
        skipNextAutoSaveRef.current = true;
        setSaveStatus('saved');
      } else {
        scheduleProjectDraft(merged, confirmation.projectUpdatedAt);
        setSaveStatus('saving');
      }
      rawProjectRef.current = merged;
      return merged;
    });

    // O Diário é uma projeção complementar de registros antigos. Ele é
    // conciliado depois da confirmação, em fila própria, sem repetir a baixa
    // nem travar o modal de retirada/correção se estiver indisponível.
    const dailyChanges = confirmation.dailyReportChanges.filter(change => !!change.before || !!change.after);
    if (dailyChanges.length > 0) {
      const reconcileDailyMirror = async () => {
        for (const change of dailyChanges) {
          const reference = change.after ?? change.before!;
          const emptyReport: DailyReport = {
            id: reference.id,
            date: reference.date,
            teamsPresent: [],
            equipment: [],
            attachments: [],
            createdAt: reference.createdAt,
            updatedAt: reference.updatedAt,
          };
          const beforeReport = change.before ?? emptyReport;
          const afterReport = change.after ?? emptyReport;
          const request = dailyReportSaveQueueRef.current
            .catch(() => undefined)
            .then(() => saveOpenDailyReport(confirmation.project.id, beforeReport, afterReport));
          dailyReportSaveQueueRef.current = request.then(() => undefined);
          try {
            const saved = await request;
            mergeConfirmedDailyReportIntoPartialSync(confirmation.project.id, change.date, saved.report);
            lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, change.date, saved.report);
            clearLocalProjectCollections(confirmation.project.id, ['dailyReports']);
            setRawProject(current => {
              if (!current || current.id !== confirmation.project.id) return current;
              const currentReport = reportForDate(current, change.date);
              // Não sobrescreve uma edição de Diário feita após a retirada.
              if (currentReport && JSON.stringify(currentReport) !== JSON.stringify(afterReport)) return current;
              const next = replaceReportForDate(current, change.date, saved.report);
              rawProjectRef.current = next;
              return next;
            });
          } catch (error) {
            console.warn('Retirada confirmada; falhou apenas a projeção complementar no Diário.', error);
            setDailyReportSaveErrors(errors => ({
              ...errors,
              [change.date]: 'A retirada foi salva. O espelho deste Diário será reconciliado ao abrir a área.',
            }));
            toast.warning('Retirada salva na nuvem. O espelho do Diário será reconciliado separadamente.');
          }
        }
      };
      void reconcileDailyMirror();
    }
  }, [clearLocalProjectCollections, currentProjectUpdatedAtRef, currentWarehouseVersionRef, dailyReportSaveQueueRef, discardProjectDraft, lastObservedWarehouseVersionRef, lastSavedProjectJsonRef, mergeConfirmedDailyReportIntoPartialSync, ownWarehouseRealtimeRowsRef, rawProjectRef, refreshRemoteCollectionsInBackground, saveTimerRef, scheduleProjectDraft, setCloudList, setCurrentProjectUpdatedAt, setDailyReportSaveErrors, setLastCloudConfirmedAt, setRawProject, setSaveStatus, skipNextAutoSaveRef]);

  const commitWarehouseRequisitionNow = useCallback((
    before: Project,
    after: Project,
    operation: WarehouseCloudOperation,
  ): Promise<WarehouseCloudCommitResult> => {
    if (navigationInFlightRef.current && !warehouseClientOperationInFlightRef.current) {
      return Promise.reject(new Error('A navegação já foi iniciada. Aguarde a próxima tela abrir antes de registrar a operação.'));
    }
    if (warehouseOperationInFlightRef.current) {
      return Promise.reject(new Error('Aguarde a operação atual do Almoxarifado ser confirmada na nuvem.'));
    }
    const ownsRouteLock = !warehouseLockedRouteRef.current;
    if (ownsRouteLock) warehouseLockedRouteRef.current = currentRouteRef.current;
    const request = (async () => {
      await prepareWarehouseCloudOperation('requisition');
      if (rawProjectRef.current?.id !== before.id) {
        throw new Error('A obra aberta mudou antes da confirmação. Nenhuma nova operação foi iniciada.');
      }
      if (userId && await resolveWarehouseRequisitionPending(userId, before.id, operation.requisitionId, operation.operationKey, async () => {
        const current = rawProjectRef.current;
        const version = current && await getCloudProjectVersion(current.id);
        if (!current || !version || !await refreshRemoteCollectionsInBackground(current, WAREHOUSE_REMOTE_SYNC_COLLECTIONS, version)) {
          throw new Error('A tentativa anterior foi confirmada; aguarde a atualização da obra antes de continuar.');
        }
      })) {
        throw Object.assign(new Error('A tentativa anterior desta retirada foi confirmada. Sua edição foi preservada; revise e salve novamente.'), {
          definitiveRejection: true, confirmedProject: rawProjectRef.current,
        });
      }
      const confirmation = await commitWarehouseOperation(before, after, operation, userId);
      await applyWarehouseCloudConfirmation(confirmation);
      acknowledgeWarehouseOutbox(userId, before.id, operation.operationKey);
      return confirmation;
    })();
    warehouseOperationInFlightRef.current = request;
    return request.finally(() => {
      if (warehouseOperationInFlightRef.current === request) {
        warehouseOperationInFlightRef.current = null;
      }
      if (ownsRouteLock && !warehouseClientOperationInFlightRef.current && !warehouseScopedOperationInFlightRef.current) {
        warehouseLockedRouteRef.current = null;
      }
    });
  }, [applyWarehouseCloudConfirmation, currentRouteRef, navigationInFlightRef, prepareWarehouseCloudOperation, rawProjectRef, refreshRemoteCollectionsInBackground, userId, warehouseClientOperationInFlightRef, warehouseLockedRouteRef, warehouseOperationInFlightRef, warehouseScopedOperationInFlightRef]);

  const runCriticalWarehouseClientOperation = useCallback(<T,>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (navigationInFlightRef.current) {
      return Promise.reject(new Error('A navegação já foi iniciada. Aguarde a próxima tela abrir antes de registrar a operação.'));
    }
    if (warehouseClientOperationInFlightRef.current) {
      return Promise.reject(new Error('Aguarde a operação atual do Almoxarifado ser confirmada na nuvem.'));
    }
    const ownsRouteLock = !warehouseLockedRouteRef.current;
    if (ownsRouteLock) warehouseLockedRouteRef.current = currentRouteRef.current;
    const request = Promise.resolve().then(operation);
    warehouseClientOperationInFlightRef.current = request;
    return request.finally(() => {
      if (warehouseClientOperationInFlightRef.current === request) {
        warehouseClientOperationInFlightRef.current = null;
      }
      if (ownsRouteLock && !warehouseOperationInFlightRef.current && !warehouseScopedOperationInFlightRef.current) {
        warehouseLockedRouteRef.current = null;
      }
    });
  }, [currentRouteRef, navigationInFlightRef, warehouseClientOperationInFlightRef, warehouseLockedRouteRef, warehouseOperationInFlightRef, warehouseScopedOperationInFlightRef]);

  const commitWarehouseScopedNow = useCallback((next: Project, domain: WarehouseScopedDomain, expectedBase?: Project): Promise<Project> => {
    // Capture the form's baseline before preparation can hydrate newer remote values.
    const currentBase = project ?? rawProjectRef.current;
    const submittedBase = expectedBase && currentBase ? warehouseEditBaseline(expectedBase, currentBase, next) : currentBase;
    if (navigationInFlightRef.current) {
      return Promise.reject(new Error('A navegação já foi iniciada. Aguarde a próxima tela abrir antes de registrar a operação.'));
    }
    if (warehouseScopedOperationInFlightRef.current) {
      return Promise.reject(new Error('Aguarde a operação atual do Almoxarifado ser confirmada na nuvem.'));
    }
    const ownsRouteLock = !warehouseLockedRouteRef.current;
    if (ownsRouteLock) warehouseLockedRouteRef.current = currentRouteRef.current;
    const request = (async () => {
      await prepareWarehouseCloudOperation(domain);

      const before = submittedBase;
      if (!before || before.id !== next.id || rawProjectRef.current?.id !== before.id) throw new Error('A operação não pertence à obra aberta.');
      if (currentWarehouseVersionRef.current == null) {
        const remote = await getCloudProjectVersion(before.id);
        if (rawProjectRef.current?.id !== before.id) {
          throw new Error('A obra aberta mudou durante a preparação. Reabra o Almoxarifado e tente novamente.');
        }
        if (!remote) {
          throw new Error('A versão do Almoxarifado mudou. Atualize a obra antes de continuar.');
        }
        if (remote.warehouseVersion == null) {
          throw new Error('A atualização segura do Almoxarifado ainda não foi instalada no servidor. Nada foi gravado.');
        }
        currentWarehouseVersionRef.current = remote.warehouseVersion;
        lastObservedWarehouseVersionRef.current = remote.warehouseVersion;
      }

      const scopedNext: Project = {
        ...before,
        warehouse: next.warehouse,
        auditLogs: next.auditLogs,
        stockMovements: next.stockMovements,
        materialPriceHistory: next.materialPriceHistory,
        dailyReports: next.dailyReports,
      };
      setSaveStatus('saving');
      const { commitWarehouseScopedOperation, mergeWarehouseScopedCommit } = await import('@/lib/warehouseScopedCommit');
      let result: WarehouseScopedCommitResult;
      try {
        result = await commitWarehouseScopedOperation(
          before,
          scopedNext,
          currentWarehouseVersionRef.current,
          '',
          domain,
          userId,
        );
      } catch (error) {
        setSaveStatus(navigator.onLine ? 'error' : 'offline');
        throw error;
      }

      if (rawProjectRef.current?.id !== result.project.id) {
        setCloudList(previous => previous.map(meta => meta.id === result.project.id
          ? { ...meta, updatedAt: result.projectUpdatedAt }
          : meta));
        return result.project;
      }
      if ((lastObservedWarehouseVersionRef.current ?? -1) > result.warehouseVersion) {
        const active = rawProjectRef.current;
        const version = await getCloudProjectVersion(active.id);
        const refreshed = version && await refreshRemoteCollectionsInBackground(active, WAREHOUSE_REMOTE_SYNC_COLLECTIONS, version);
        if (!refreshed || version?.warehouseVersion == null || !version.warehouseUpdatedAt) {
          throw new Error('A operação foi confirmada, mas há uma versão posterior. Confira a tentativa pendente para atualizar a tela.');
        }
        result.project = refreshed; result.projectUpdatedAt = version.updatedAt;
        result.warehouseUpdatedAt = version.warehouseUpdatedAt; result.warehouseVersion = version.warehouseVersion;
      }

      const parseSavedBaseline = () => {
        if (!lastSavedProjectJsonRef.current) return before;
        try { return JSON.parse(lastSavedProjectJsonRef.current) as Project; }
        catch { return before; }
      };
      const savedBaseline = mergeWarehouseScopedCommit(parseSavedBaseline(), result);
      const savedBaselineJson = serializeProject(savedBaseline);
      lastSavedProjectJsonRef.current = savedBaselineJson;

      const expiresAt = Date.now() + 10_000;
      result.affectedMovementIds.forEach(id => ownWarehouseRealtimeRowsRef.current.set(`warehouse_movements:${id}`, expiresAt));
      result.affectedCustodyIds.forEach(id => ownWarehouseRealtimeRowsRef.current.set(`warehouse_custody:${id}`, expiresAt));
      result.affectedAuditIds.forEach(id => ownWarehouseRealtimeRowsRef.current.set(`audit_logs:${id}`, expiresAt));
      currentWarehouseVersionRef.current = result.warehouseVersion;
      lastObservedWarehouseVersionRef.current = result.warehouseVersion;
      currentProjectUpdatedAtRef.current = result.projectUpdatedAt;
      setCurrentProjectUpdatedAt(result.projectUpdatedAt);
      setLastCloudConfirmedAt(result.committedAt);
      setCloudList(previous => previous.map(meta => meta.id === result.project.id ? { ...meta, updatedAt: result.projectUpdatedAt } : meta));

      let applied = result.project;
      setRawProject(current => {
        if (!current || current.id !== result.project.id) return current;
        applied = mergeWarehouseScopedCommit(current, result);
        const fullyConfirmed = serializeProject(applied) === savedBaselineJson;
        if (fullyConfirmed) {
          discardProjectDraft(applied.id);
          skipNextAutoSaveRef.current = true;
          setSaveStatus('saved');
        } else {
          scheduleProjectDraft(applied, result.projectUpdatedAt);
          setSaveStatus('saving');
        }
        rawProjectRef.current = applied;
        return applied;
      });
      acknowledgeWarehouseOutbox(userId, before.id, result.operationKey);
      return applied;
    })();
    warehouseScopedOperationInFlightRef.current = request;
    return request.finally(() => {
      if (warehouseScopedOperationInFlightRef.current === request) {
        warehouseScopedOperationInFlightRef.current = null;
      }
      if (ownsRouteLock && !warehouseClientOperationInFlightRef.current && !warehouseOperationInFlightRef.current) {
        warehouseLockedRouteRef.current = null;
      }
    });
  }, [currentProjectUpdatedAtRef, currentRouteRef, currentWarehouseVersionRef, discardProjectDraft, lastObservedWarehouseVersionRef, lastSavedProjectJsonRef, navigationInFlightRef, ownWarehouseRealtimeRowsRef, prepareWarehouseCloudOperation, project, rawProjectRef, refreshRemoteCollectionsInBackground, scheduleProjectDraft, setCloudList, setCurrentProjectUpdatedAt, setLastCloudConfirmedAt, setRawProject, setSaveStatus, skipNextAutoSaveRef, userId, warehouseClientOperationInFlightRef, warehouseLockedRouteRef, warehouseOperationInFlightRef, warehouseScopedOperationInFlightRef]);

  return { prepareWarehouseCloudOperation, prepareWarehouseRequisitionOperation, applyWarehouseCloudConfirmation, commitWarehouseRequisitionNow, runCriticalWarehouseClientOperation, commitWarehouseScopedNow };
}
