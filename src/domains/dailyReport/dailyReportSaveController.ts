import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { toast } from 'sonner';
import type { DailyReport, Project } from '@/types/project';
import type { SaveStatus } from '@/components/SaveStatusIndicator';
import type { ConfirmDeleteOptions } from '@/components/ConfirmDeleteDialog';
import { reportForDate, replaceReportForDate, replaceSavedDailyReport } from './dailyReportProject';
import { clearDailyReportDraft, protectDailyReportDraft, readDailyReportDrafts, type DailyReportDraft } from '@/lib/dailyReportDrafts';
import { loadOpenDailyReport, saveOpenDailyReport } from '@/lib/dailyReportCloudSync';

/** The shared project boundary stays in Index; only Diary data is written here. */
export interface DailyReportSaveContext {
  actorId: string | undefined;
  rawProjectRef: MutableRefObject<Project | null>;
  dailyReportDraftsRef: MutableRefObject<Record<string, DailyReportDraft>>;
  dailyReportSaveQueueRef: MutableRefObject<Promise<unknown>>;
  pendingDailyReportSavesRef: MutableRefObject<number>;
  lastSavedProjectJsonRef: MutableRefObject<string | null>;
  currentProjectUpdatedAtRef: MutableRefObject<string | null>;
  conflictDetectedRef: MutableRefObject<boolean>;
  partialSyncPendingRef: MutableRefObject<{ projectId: string } | null>;
  dailyReportRecoveryBusy: boolean;
  setDailyReportRecoveryBusy: Dispatch<SetStateAction<boolean>>;
  setDailyReportDrafts: Dispatch<SetStateAction<Record<string, DailyReportDraft>>>;
  setDailyReportSaveErrors: Dispatch<SetStateAction<Record<string, string>>>;
  setSaveStatus: Dispatch<SetStateAction<SaveStatus>>;
  setRawProject: Dispatch<SetStateAction<Project | null>>;
  mergeConfirmedDailyReportIntoPartialSync: (projectId: string, date: string, report: DailyReport | null) => void;
  clearLocalProjectCollections: (projectId: string, collections: Array<'dailyReports'>) => void;
  confirmDiscardPendingForm: (options: ConfirmDeleteOptions, action: () => void) => void;
}

/** Restores only this actor's drafts and preserves edits made while loading. */
export function useDailyReportDraftLoading(
  projectId: string | undefined,
  actorId: string | undefined,
  draftsRef: MutableRefObject<Record<string, DailyReportDraft>>,
  setDrafts: Dispatch<SetStateAction<Record<string, DailyReportDraft>>>,
  setErrors: Dispatch<SetStateAction<Record<string, string>>>,
): void {
  useEffect(() => {
    let active = true;
    setDrafts({});
    setErrors({});
    draftsRef.current = {};
    if (projectId && actorId) {
      void readDailyReportDrafts(projectId, actorId).then(drafts => {
        if (!active) return;
        const merged = { ...drafts, ...draftsRef.current };
        draftsRef.current = merged;
        setDrafts(merged);
      }).catch(() => {
        if (active) toast.warning('Não foi possível consultar os rascunhos deste aparelho. Mantenha esta aba aberta até confirmar suas edições.');
      });
    }
    return () => { active = false; };
  }, [projectId, actorId, draftsRef, setDrafts, setErrors]);
}

export function saveDailyReportEdits(before: Project, after: Project, context: DailyReportSaveContext): void {
  const { actorId, rawProjectRef, dailyReportDraftsRef, dailyReportSaveQueueRef, pendingDailyReportSavesRef, lastSavedProjectJsonRef, conflictDetectedRef, partialSyncPendingRef, currentProjectUpdatedAtRef, setDailyReportDrafts, setDailyReportSaveErrors, setSaveStatus, setRawProject, mergeConfirmedDailyReportIntoPartialSync, clearLocalProjectCollections } = context;
  if (!actorId) return;
  const dates = new Set([
    ...(before.dailyReports ?? []).map(report => report.date),
    ...(after.dailyReports ?? []).map(report => report.date),
  ]);
  dates.forEach(date => {
    const previous = reportForDate(before, date);
    const local = reportForDate(after, date);
    if (!local) return;
    const base: DailyReport = previous ?? {
      id: local.id,
      date: local.date,
      teamsPresent: [],
      equipment: [],
      attachments: [],
      createdAt: local.createdAt,
      updatedAt: local.updatedAt,
    };
    if (JSON.stringify(base) === JSON.stringify(local)) return;

    pendingDailyReportSavesRef.current += 1;
    setSaveStatus('saving');
    const expectedLocal = local;
    const recovery: DailyReportDraft = { revision: crypto.randomUUID(), base, local: expectedLocal };
    dailyReportDraftsRef.current = { ...dailyReportDraftsRef.current, [date]: recovery };
    setDailyReportDrafts(dailyReportDraftsRef.current);
    // Start protecting immediately, before waiting for earlier cloud saves.
    let draftProtected = true;
    const protectedDraft = protectDailyReportDraft(after.id, actorId, recovery);
    void protectedDraft.catch(() => undefined);
    const request = dailyReportSaveQueueRef.current.catch(() => undefined).then(async () => {
      await protectedDraft.catch(() => {
        draftProtected = false;
        if (rawProjectRef.current?.id !== after.id) return;
        const message = 'A edição está somente nesta aba até a confirmação da nuvem. Baixe o rascunho antes de fechar se a gravação falhar.';
        setDailyReportSaveErrors(errors => ({ ...errors, [date]: message }));
        toast.warning(message);
      });
      const result = await saveOpenDailyReport(after.id, base, expectedLocal);
      if (result.conflicts.length === 0) await clearDailyReportDraft(after.id, actorId, date, recovery.revision).catch(() => {
        toast.warning('Diário confirmado na nuvem. A limpeza da cópia local ainda precisa ser repetida.');
      });
      if (result.conflicts.length === 0 && rawProjectRef.current?.id === after.id && dailyReportDraftsRef.current[date]?.revision === recovery.revision) {
        const remaining = { ...dailyReportDraftsRef.current };
        delete remaining[date];
        dailyReportDraftsRef.current = remaining;
        setDailyReportDrafts(remaining);
      }
      mergeConfirmedDailyReportIntoPartialSync(after.id, date, result.report);
      if (result.conflicts.length === 0) setDailyReportSaveErrors(errors => {
        const next = { ...errors };
        delete next[date];
        return next;
      });
      lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, date, result.report);
      clearLocalProjectCollections(after.id, ['dailyReports']);
      setRawProject(current => {
        if (!current || current.id !== after.id) return current;
        const currentReport = reportForDate(current, date);
        // Uma edição mais recente já está na fila. Ela será conciliada contra
        // a versão confirmada ao chegar sua vez; não a sobrescreva agora.
        if (!currentReport || JSON.stringify(currentReport) !== JSON.stringify(expectedLocal)) return current;
        const next = replaceReportForDate(current, date, result.report);
        rawProjectRef.current = next;
        return next;
      });
      if (result.conflicts.length > 0) {
        setDailyReportSaveErrors(errors => ({ ...errors, [date]: 'Há campos divergentes. Compare a versão confirmada com o rascunho preservado.' }));
        toast.warning('A legenda ou campo já havia sido alterado em outro aparelho. Foi mantida a primeira edição salva e o rascunho foi preservado.');
      }
    });
    dailyReportSaveQueueRef.current = request;
    void request.catch(async error => {
      if (rawProjectRef.current?.id !== after.id) return;
      console.warn('Falha ao salvar o Diário diretamente.', error);
      const message = error instanceof Error ? error.message : 'Não foi possível salvar o Diário. Nenhuma alteração foi confirmada.';
      setDailyReportSaveErrors(errors => ({ ...errors, [date]: draftProtected ? message : `${message} A cópia está somente nesta aba. Baixe o rascunho antes de fechar.` }));
      setSaveStatus(navigator.onLine ? 'error' : 'offline');
      // Uma falha da gravação do Diário não autoriza apagar os arquivos já
      // recebidos pelo Storage: eles podem ser a única cópia das fotos.
      const confirmed = await loadOpenDailyReport(after.id, date).catch(() => null);
      lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, date, confirmed ?? base);
      setRawProject(current => {
        if (!current || current.id !== after.id) return current;
        const currentReport = reportForDate(current, date);
        if (!currentReport || JSON.stringify(currentReport) !== JSON.stringify(expectedLocal)) return current;
        const next = replaceReportForDate(current, date, confirmed ?? base);
        rawProjectRef.current = next;
        return next;
      });
      toast.error(message);
    }).finally(() => {
      pendingDailyReportSavesRef.current = Math.max(0, pendingDailyReportSavesRef.current - 1);
      if (pendingDailyReportSavesRef.current === 0) {
        setSaveStatus(conflictDetectedRef.current
          ? 'conflict'
          : partialSyncPendingRef.current?.projectId === after.id
            ? 'error'
            : Object.keys(dailyReportDraftsRef.current).length > 0 ? 'error' : 'saved');
      }
    });
  });
}

export async function recoverDailyReportDraft(date: string, discard: boolean, context: DailyReportSaveContext, discardConfirmed = false): Promise<void> {
  const { actorId, rawProjectRef, dailyReportDraftsRef, pendingDailyReportSavesRef, lastSavedProjectJsonRef, dailyReportRecoveryBusy, setDailyReportRecoveryBusy, setDailyReportDrafts, setDailyReportSaveErrors, setRawProject, confirmDiscardPendingForm } = context;
  const current = rawProjectRef.current;
  const draft = dailyReportDraftsRef.current[date];
  if (!current || !draft || !actorId || dailyReportRecoveryBusy || pendingDailyReportSavesRef.current > 0) return;
  if (discard && !discardConfirmed) {
    confirmDiscardPendingForm({ title: 'Descartar rascunho do Diário?', description: 'Somente a edição local pendente será descartada. O Diário confirmado e seus arquivos permanecem preservados.', confirmLabel: 'Descartar rascunho' }, () => void recoverDailyReportDraft(date, true, context, true));
    return;
  }
  setDailyReportRecoveryBusy(true);
  try {
    const confirmed = await loadOpenDailyReport(current.id, date);
    if (rawProjectRef.current?.id !== current.id) return;
    if (discard) {
      await clearDailyReportDraft(current.id, actorId, date, draft.revision);
      if (dailyReportDraftsRef.current[date]?.revision === draft.revision) {
        const latest = rawProjectRef.current;
        if (latest?.id === current.id) {
          const next = replaceReportForDate(latest, date, confirmed);
          rawProjectRef.current = next; setRawProject(next);
        }
        const next = { ...dailyReportDraftsRef.current }; delete next[date];
        dailyReportDraftsRef.current = next; setDailyReportDrafts(next);
        setDailyReportSaveErrors(errors => { const next = { ...errors }; delete next[date]; return next; });
      }
    } else {
      const result = await saveOpenDailyReport(current.id, draft.base, draft.local);
      if (rawProjectRef.current?.id !== current.id) return;
      if (result.conflicts.length > 0) {
        const latest = rawProjectRef.current;
        if (latest?.id === current.id) {
          const next = replaceReportForDate(latest, date, result.report);
          rawProjectRef.current = next; setRawProject(next);
        }
        toast.warning('Há campos divergentes. A versão confirmada foi preservada; compare o rascunho antes de descartá-lo.');
        return;
      }
      await clearDailyReportDraft(current.id, actorId, date, draft.revision);
      const latest = rawProjectRef.current;
      if (!latest || latest.id !== current.id) return;
      if (dailyReportDraftsRef.current[date]?.revision !== draft.revision) return;
      const next = replaceReportForDate(latest, date, result.report);
      rawProjectRef.current = next; setRawProject(next);
      lastSavedProjectJsonRef.current = replaceSavedDailyReport(lastSavedProjectJsonRef.current, date, result.report);
      const remaining = { ...dailyReportDraftsRef.current }; delete remaining[date];
      dailyReportDraftsRef.current = remaining; setDailyReportDrafts(remaining);
      setDailyReportSaveErrors(errors => { const next = { ...errors }; delete next[date]; return next; });
      toast.success('Diário confirmado.');
    }
  } catch (error) { toast.error(error instanceof Error ? error.message : 'Não foi possível recuperar o Diário.'); }
  finally { setDailyReportRecoveryBusy(false); }
}
