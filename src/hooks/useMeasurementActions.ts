import { useCallback, type MutableRefObject } from 'react';
import type {
  Project,
  Task,
  ContractInfo,
  SavedMeasurement,
  MeasurementSnapshotItem,
  MeasurementStatus,
  MeasurementChangeLog,
} from '@/types/project';
import { trunc2, calculateUnitPriceWithBDI } from '@/lib/measurementCalculations';
import { logToProject, type AuditUserInfo } from '@/lib/audit';
import { toast } from '@/hooks/use-toast';
import { isoAddDays, suggestPeriodForNext, getProjectStartDate } from '@/components/measurement/measurementFormat';
import { buildDailyReportSnapshot, type DailyReportPeriodSummary } from '@/lib/dailyReportSummary';
import type { Row } from '@/components/measurement/types';

export interface UseMeasurementActionsParams {
  project: Project;
  projectRef: MutableRefObject<Project>;
  onProjectChange: (project: Project) => void;
  auditUser: AuditUserInfo;

  // medição ativa
  activeMeasurement: SavedMeasurement | null;
  isLocked: boolean;
  isSnapshotMode: boolean;
  setActiveId: (id: string) => void;

  // dados calculados
  rows: Row[];
  measurements: SavedMeasurement[];
  dailyReportsSummary: DailyReportPeriodSummary;

  // validação (para bloquear geração)
  validationSummary: { hasBlocking: boolean };

  // efetivos para cálculo no modo snapshot
  effStart: string;
  effEnd: string;
  effBdi: number;
  effBdiFactor: number;

  // estados do useMeasurementState
  startDate: string;
  endDate: string;
  today: string;
  monthAgo: string;
  bdiPercent: number;
  bdiFactor: number;
  contractor: string;
  contracted: string;
  contractNumber: string;
  contractObject: string;
  location: string;
  budgetSource: string;
  measurementNumber: string;
  editReason: string;

  // setters
  setStartDate: (v: string) => void;
  setEndDate: (v: string) => void;
  setChapterFilter: (v: string) => void;
  setSearch: (v: string) => void;
  setMeasurementNumber: (v: string) => void;
  setConfirmGenerate: (v: boolean) => void;
  setConfirmEdit: (v: boolean) => void;
  setConfirmDelete: (v: boolean) => void;
  setEditReason: (v: string) => void;
}

/**
 * Centraliza ações/eventos da Medição (persistência de contrato, edição manual,
 * geração de medição/snapshot, mudança de status, exclusão).
 *
 * IMPORTANTE: NÃO altera cálculos, snapshot, validação ou auditoria.
 * É uma extração 1:1 do que estava em Measurement.tsx.
 */
export function useMeasurementActions(params: UseMeasurementActionsParams) {
  const {
    project, projectRef, onProjectChange, auditUser,
    activeMeasurement, isLocked, isSnapshotMode, setActiveId,
    rows, measurements, dailyReportsSummary, validationSummary,
    effStart, effEnd, effBdi, effBdiFactor,
    startDate, endDate, today, monthAgo,
    bdiPercent, bdiFactor,
    contractor, contracted, contractNumber, contractObject, location, budgetSource,
    measurementNumber, editReason,
    setStartDate, setEndDate, setChapterFilter, setSearch, setMeasurementNumber,
    setConfirmGenerate, setConfirmEdit, setConfirmDelete, setEditReason,
  } = params;

  // ───────── Cabeçalho contratual ─────────
  const persistContractInfo = (next: Partial<ContractInfo>) => {
    const latestProject = projectRef.current;
    onProjectChange({
      ...latestProject,
      contractInfo: { ...(latestProject.contractInfo || {}), ...next },
    });
  };

  // ───────── Edição em modo "live" (EAP) ─────────
  const updateTaskField = (taskId: string, patch: Partial<Task>) => {
    if (isLocked) return;
    onProjectChange({
      ...project,
      phases: project.phases.map(p => ({
        ...p,
        tasks: p.tasks.map(t => (t.id === taskId ? { ...t, ...patch } : t)),
      })),
    });
  };

  // ───────── Snapshot (medição salva) ─────────
  const updateMeasurement = useCallback(
    (id: string, patch: (m: SavedMeasurement) => SavedMeasurement) => {
      onProjectChange({
        ...project,
        measurements: (project.measurements || []).map(m => (m.id === id ? patch(m) : m)),
      });
    },
    [project, onProjectChange],
  );

  const extractLogValues = (
    item: MeasurementSnapshotItem,
    patch: Partial<MeasurementSnapshotItem>,
  ) => {
    const out: Record<string, unknown> = {};
    Object.keys(patch).forEach(k => {
      const key = k as keyof MeasurementSnapshotItem;
      out[k] = item[key];
    });
    return out;
  };

  const patchSnapshotItem = (
    taskId: string,
    patch: Partial<MeasurementSnapshotItem>,
    fieldLabel: string,
  ) => {
    if (!activeMeasurement) return;
    if (isLocked) return;
    const existing = activeMeasurement.items.find(i => i.taskId === taskId);
    const log: MeasurementChangeLog = {
      at: new Date().toISOString(),
      field: fieldLabel,
      itemId: taskId,
      previous: existing ? JSON.stringify(extractLogValues(existing, patch)) : '',
      next: JSON.stringify(patch),
      reason: editReason || undefined,
    };
    updateMeasurement(activeMeasurement.id, m => ({
      ...m,
      items: m.items.map(i => (i.taskId === taskId ? { ...i, ...patch } : i)),
      history: [...(m.history || []), log],
    }));
  };

  // ───────── Edição de preço unitário ─────────
  const updateUnitPriceNoBDI = (taskId: string, value: number) => {
    const noBDI = trunc2(value);
    if (isSnapshotMode) {
      patchSnapshotItem(
        taskId,
        { unitPriceNoBDI: noBDI, unitPriceWithBDI: calculateUnitPriceWithBDI(noBDI, effBdi) },
        'Valor unit. s/ BDI',
      );
    } else {
      updateTaskField(taskId, {
        unitPriceNoBDI: noBDI,
        unitPrice: calculateUnitPriceWithBDI(noBDI, bdiPercent),
      });
    }
  };

  const updateUnitPriceWithBDI = (taskId: string, value: number) => {
    if (isSnapshotMode) {
      patchSnapshotItem(
        taskId,
        { unitPriceWithBDI: value, unitPriceNoBDI: value / effBdiFactor },
        'Valor unit. c/ BDI',
      );
    } else {
      updateTaskField(taskId, { unitPrice: value, unitPriceNoBDI: value / bdiFactor });
    }
  };

  // ───────── Edição manual de quantidade do período (live) ─────────
  const setManualPeriodQuantity = (taskId: string, value: number) => {
    if (isSnapshotMode) return;
    const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
    const manualId = `manual-measurement-${effStart}-${effEnd}`;
    onProjectChange({
      ...project,
      phases: project.phases.map(p => ({
        ...p,
        tasks: p.tasks.map(t => {
          if (t.id !== taskId) return t;
          const others = (t.dailyLogs || []).filter(l => l.id !== manualId);
          if (safeValue <= 0) return { ...t, dailyLogs: others };
          return {
            ...t,
            dailyLogs: [
              ...others,
              {
                id: manualId,
                date: effEnd,
                plannedQuantity: 0,
                actualQuantity: safeValue,
                notes: 'Lançamento manual via Planilha de Medição',
              },
            ],
          };
        }),
      })),
    });
  };

  // ───────── Gerar nova medição (snapshot a partir do live) ─────────
  const generateMeasurement = () => {
    if (validationSummary.hasBlocking) {
      toast({
        title: 'Não é possível gerar a medição',
        description: 'Corrija os erros listados no painel de validação antes de prosseguir.',
        variant: 'destructive',
      });
      setConfirmGenerate(false);
      return;
    }
    const number =
      Number(measurementNumber) || (measurements[measurements.length - 1]?.number || 0) + 1;
    const items: MeasurementSnapshotItem[] = rows.map(r => ({
      item: r.item,
      phaseId: r.phaseId,
      phaseChain: r.phaseChain,
      taskId: r.taskId,
      description: r.description,
      unit: r.unit,
      itemCode: r.itemCode,
      priceBank: r.priceBank,
      qtyContracted: r.qtyContracted,
      unitPriceNoBDI: r.unitPriceNoBDI,
      unitPriceWithBDI: r.unitPriceWithBDI,
      qtyProposed: r.qtyPeriod,
      qtyPriorAccum: r.qtyPriorAccum,
    }));

    const snapshot: SavedMeasurement = {
      id: `meas-${Date.now()}`,
      number,
      startDate,
      endDate,
      issueDate: today,
      status: 'generated',
      bdiPercent,
      items,
      generatedAt: new Date().toISOString(),
      contractSnapshot: {
        contractor,
        contracted,
        contractNumber,
        contractObject,
        location,
        budgetSource,
        bdiPercent,
        nextMeasurementNumber: number + 1,
      },
      history: [],
      dailyReportSnapshot: buildDailyReportSnapshot(dailyReportsSummary),
    };

    const nextStartIso = isoAddDays(endDate, 1);
    const nextEndIso = isoAddDays(nextStartIso, 29);
    const nextNumber = number + 1;
    const latestProject = projectRef.current;
    const nextProject: Project = {
      ...latestProject,
      contractInfo: {
        ...(latestProject.contractInfo || {}),
        nextMeasurementNumber: nextNumber,
      },
      measurements: [...(latestProject.measurements || []), snapshot],
      measurementDraft: {
        number: nextNumber,
        startDate: nextStartIso,
        endDate: nextEndIso,
        chapterFilter: 'all',
        search: '',
      },
    };
    const nextProjectWithLog = logToProject(nextProject, {
      ...auditUser,
      entityType: 'measurement',
      entityId: snapshot.id,
      action: 'created',
      title: `Medição nº ${number} gerada`,
      metadata: {
        number,
        startDate,
        endDate,
        bdiPercent,
        itemsCount: items.length,
      },
    });
    projectRef.current = nextProjectWithLog;
    onProjectChange(nextProjectWithLog);
    setStartDate(nextStartIso);
    setEndDate(nextEndIso);
    setChapterFilter('all');
    setSearch('');
    setMeasurementNumber(String(nextNumber));
    setActiveId('live');
    setConfirmGenerate(false);
    toast({
      title: `Medição nº ${number} criada`,
      description: `Previsão viva — atualiza com apontamentos. Preparando ${nextNumber}ª Medição.`,
    });
  };

  // ───────── Liberar para ajuste / aprovar / reprovar / enviar ─────────
  /**
   * Libera edição controlada de uma medição reprovada.
   * Mantém status='rejected' e marca editUnlocked=true para destravar o snapshot.
   */
  const unlockForEdit = () => {
    if (!activeMeasurement) return;
    updateMeasurement(activeMeasurement.id, m => ({
      ...m,
      editUnlocked: true,
      history: [
        ...(m.history || []),
        {
          at: new Date().toISOString(),
          field: 'editUnlocked',
          previous: String(!!m.editUnlocked),
          next: 'true',
          reason: editReason || 'Liberada para ajustes',
        },
      ],
    }));
    setConfirmEdit(false);
    setEditReason('');
    toast({
      title: 'Medição aberta para ajustes',
      description: 'Ajuste os campos liberados e clique em "Reenviar p/ Fiscal".',
    });
  };

  /**
   * Reenvia para fiscalização uma medição que estava reprovada e foi ajustada.
   * Re-congela o snapshot a partir das linhas atuais e volta status para in_review.
   */
  const resendForReview = () => {
    if (!activeMeasurement) return;
    const frozenItems: MeasurementSnapshotItem[] = rows.map(r => ({
      item: r.item,
      phaseId: r.phaseId,
      phaseChain: r.phaseChain,
      taskId: r.taskId,
      description: r.description,
      unit: r.unit,
      itemCode: r.itemCode,
      priceBank: r.priceBank,
      qtyContracted: r.qtyContracted,
      unitPriceNoBDI: r.unitPriceNoBDI,
      unitPriceWithBDI: r.unitPriceWithBDI,
      qtyProposed: r.qtyPeriod,
      qtyPriorAccum: r.qtyPriorAccum,
      notes: r.notes,
    }));
    updateMeasurement(activeMeasurement.id, m => ({
      ...m,
      items: frozenItems,
      dailyReportSnapshot: buildDailyReportSnapshot(dailyReportsSummary),
      status: 'in_review',
      editUnlocked: false,
      history: [
        ...(m.history || []),
        {
          at: new Date().toISOString(),
          field: 'status',
          previous: m.status,
          next: 'in_review',
          reason: 'Reenviada para fiscalização após ajustes',
        },
      ],
    }));
    toast({ title: 'Medição reenviada para fiscalização' });
  };

  const setStatus = (next: MeasurementStatus) => {
    if (!activeMeasurement) return;
    const previous = activeMeasurement.status;
    updateMeasurement(activeMeasurement.id, m => ({
      ...m,
      status: next,
      // Ao reprovar a partir do fiscal, mantém snapshot congelado (editUnlocked=false)
      // até que o usuário clique em "Editar Medição".
      editUnlocked: next === 'rejected' ? false : m.editUnlocked,
      history: [
        ...(m.history || []),
        { at: new Date().toISOString(), field: 'status', previous: m.status, next },
      ],
    }));
    const actionMap: Record<
      MeasurementStatus,
      { action: Parameters<typeof logToProject>[1]['action']; title: string } | null
    > = {
      draft: null,
      generated: { action: 'created', title: 'Medição gerada' },
      in_review: { action: 'submitted_for_review', title: 'Medição enviada para análise fiscal' },
      approved: { action: 'approved', title: 'Medição aprovada' },
      rejected: { action: 'rejected', title: 'Medição reprovada — liberada para ajuste' },
    };
    const cfg = actionMap[next];
    if (cfg) {
      onProjectChange(
        logToProject(projectRef.current, {
          ...auditUser,
          entityType: 'measurement',
          entityId: activeMeasurement.id,
          action: cfg.action,
          title: cfg.title,
          metadata: {
            number: activeMeasurement.number,
            previousStatus: previous,
            nextStatus: next,
          },
        }),
      );
    }
  };

  const deleteMeasurement = () => {
    if (!activeMeasurement) return;
    onProjectChange({
      ...project,
      measurements: (project.measurements || []).filter(m => m.id !== activeMeasurement.id),
    });
    setActiveId('live');
    setConfirmDelete(false);
    toast({ title: 'Medição excluída' });
  };

  const newMeasurementDraft = () => {
    const last = measurements[measurements.length - 1];
    const suggested = suggestPeriodForNext(measurements, today, monthAgo, getProjectStartDate(projectRef.current));
    setStartDate(suggested.startDate);
    setEndDate(suggested.endDate);
    setMeasurementNumber(String((last?.number || 0) + 1));
    setActiveId('live');
  };

  return {
    persistContractInfo,
    updateTaskField,
    updateMeasurement,
    patchSnapshotItem,
    updateUnitPriceNoBDI,
    updateUnitPriceWithBDI,
    setManualPeriodQuantity,
    generateMeasurement,
    unlockForEdit,
    resendForReview,
    setStatus,
    deleteMeasurement,
    newMeasurementDraft,
  };
}
