import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Task, DailyProductionLog, DailyLaborEntry, type ProductionQuantityDetail } from '@/types/project';
import { ClipboardList, ListTree, Plus, Trash2, TrendingUp, TrendingDown, Users } from 'lucide-react';
import { motion } from 'framer-motion';
import { useConfirmDelete } from '@/components/ConfirmDeleteDialog';
import { getProductionQuantityLimit, maximumActualForDailyLog, validateDailyProductionLogs } from '@/lib/productionQuantityLimit';
import { registerPendingEditCommit } from '@/lib/pendingEditCommits';
import { registerPendingForm } from '@/lib/pendingFormNavigation';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ProductionQuantityDetails from '@/components/ProductionQuantityDetails';
import { detailTotal, isBlankDetailRow, withDetailValue, type DetailField } from '@/lib/productionQuantityDetails';
import { measureUnit, MEASURE_KINDS, type TakeoffMeasure, type TakeoffPlan } from '@/lib/planTakeoff';
import { lazyWithReload } from '@/lib/lazyWithReload';
import type { QuantityClipboard, QuantityClipboardMode } from '@/lib/productionQuantityReferences';

const PlanTakeoff = lazyWithReload(() => import('@/components/planTakeoff/PlanTakeoff'));
const DETAIL_SOURCE_FIELDS = { multiplier: 'multiplierSource', measuredQuantity: 'source', dimensionC: 'dimensionCSource', dimensionD: 'dimensionDSource' } as const;
const DETAIL_COLUMNS = { multiplier: 'A', measuredQuantity: 'B', dimensionC: 'C', dimensionD: 'D' } as const;

interface DailyLogsPanelProps {
  projectId?: string;
  task: Task;
  onChange: (logs: DailyProductionLog[]) => void;
  focusDate?: string;
  takeoffStorageKey?: string;
  chapterId?: string;
  readOnly?: boolean;
  onDetailChange?: (logId: string, rows: ProductionQuantityDetail[]) => { success: boolean; error?: string };
  quantityClipboard?: QuantityClipboard | null;
  onQuantityCopy?: (mode: QuantityClipboardMode, logId: string, row: ProductionQuantityDetail) => void;
  onQuantityPaste?: (logId: string, afterRowId?: string) => { success: boolean; error?: string };
  onPlanRecalibrate?: (planId: string, page: number, scale: number | null) => { success: boolean; error?: string };
  sharedTaskNames?: (recordId: string) => string[];
  onOpenDetailHistory?: (recordId: string) => void;
}

/** Status color por defasagem (planejado - realizado).
 * <= 0  → verde (no prazo / adiantado)
 * 0-20% → amarelo
 * > 20% → vermelho */
function statusForDelta(delta: number, planned: number): 'ok' | 'warn' | 'late' {
  if (delta <= 0 || planned <= 0) return 'ok';
  const ratio = delta / planned;
  if (ratio <= 0.2) return 'warn';
  return 'late';
}

const STATUS_BG: Record<string, string> = {
  ok: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  late: 'bg-destructive/10 text-destructive',
};

const EMPTY_DAILY_LOGS: DailyProductionLog[] = [];

type DraftValues = Record<string, string>;

function productionDraftKey(projectId: string | undefined, taskId: string): string | null {
  return projectId ? `obraplanner:production-field-draft:${projectId}:${taskId}` : null;
}

function readProductionDraft(key: string | null, logs: DailyProductionLog[]): DraftValues {
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const stored = JSON.parse(raw) as { base: string; drafts: DraftValues; savedAt: number };
    if (Date.now() - stored.savedAt > 24 * 60 * 60 * 1000 || stored.base !== JSON.stringify(logs)) return {};
    return stored.drafts ?? {};
  } catch {
    return {};
  }
}

const hasOwn = (values: DraftValues, key: string) => Object.prototype.hasOwnProperty.call(values, key);
const logDraftKey = (logId: string, field: 'date' | 'plannedQuantity' | 'actualQuantity' | 'notes') => `log:${logId}:${field}`;
const laborDraftKey = (logId: string, entryId: string, field: 'workerName' | 'role' | 'teamCode' | 'hours' | 'hourlyCost') => `labor:${logId}:${entryId}:${field}`;

function numberDraft(values: DraftValues, key: string, fallback: number): { value: number; valid: boolean } {
  if (!hasOwn(values, key)) return { value: fallback, valid: true };
  const value = Number(values[key]);
  return Number.isFinite(value) ? { value, valid: true } : { value: fallback, valid: false };
}

function applyDraftValues(logs: DailyProductionLog[], drafts: DraftValues): { logs: DailyProductionLog[]; hasInvalidNumber: boolean } {
  let hasInvalidNumber = false;
  const nextLogs = logs.map(log => {
    const planned = numberDraft(drafts, logDraftKey(log.id, 'plannedQuantity'), log.plannedQuantity);
    const actual = numberDraft(drafts, logDraftKey(log.id, 'actualQuantity'), log.actualQuantity);
    hasInvalidNumber ||= !planned.valid || !actual.valid;

    return {
      ...log,
      date: hasOwn(drafts, logDraftKey(log.id, 'date')) ? drafts[logDraftKey(log.id, 'date')] : log.date,
      plannedQuantity: planned.value,
      actualQuantity: actual.value,
      quantityDetailsAppliedTotal: hasOwn(drafts, logDraftKey(log.id, 'actualQuantity')) && actual.value !== log.actualQuantity ? undefined : log.quantityDetailsAppliedTotal,
      notes: hasOwn(drafts, logDraftKey(log.id, 'notes')) ? drafts[logDraftKey(log.id, 'notes')] : log.notes,
      laborEntries: log.laborEntries?.map(entry => {
        const hours = numberDraft(drafts, laborDraftKey(log.id, entry.id, 'hours'), entry.hours);
        const hourlyCost = numberDraft(drafts, laborDraftKey(log.id, entry.id, 'hourlyCost'), entry.hourlyCost);
        hasInvalidNumber ||= !hours.valid || !hourlyCost.valid;
        return {
          ...entry,
          workerName: hasOwn(drafts, laborDraftKey(log.id, entry.id, 'workerName')) ? drafts[laborDraftKey(log.id, entry.id, 'workerName')] : entry.workerName,
          role: hasOwn(drafts, laborDraftKey(log.id, entry.id, 'role')) ? drafts[laborDraftKey(log.id, entry.id, 'role')] : entry.role,
          teamCode: hasOwn(drafts, laborDraftKey(log.id, entry.id, 'teamCode')) ? drafts[laborDraftKey(log.id, entry.id, 'teamCode')] : entry.teamCode,
          hours: hours.value,
          hourlyCost: hourlyCost.value,
        };
      }),
    };
  });
  return { logs: nextLogs, hasInvalidNumber };
}

export default function DailyLogsPanel({ projectId, task, onChange, focusDate, takeoffStorageKey, chapterId, readOnly = false, onDetailChange, quantityClipboard, onQuantityCopy, onQuantityPaste, onPlanRecalibrate, sharedTaskNames, onOpenDetailHistory }: DailyLogsPanelProps) {
  const logs = task.dailyLogs ?? EMPTY_DAILY_LOGS;
  const storageKey = productionDraftKey(projectId, task.id);
  const { confirm, dialog: confirmDialog } = useConfirmDelete();
  const [productionError, setProductionError] = useState<string | null>(null);
  const [draftProtectionError, setDraftProtectionError] = useState(false);
  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const [planTarget, setPlanTarget] = useState<{ logId: string; rowId: string; field: DetailField } | null>(null);
  const deletedPlanSources = useRef(new Map<string, { logId: string; rowId: string; row: ProductionQuantityDetail }>());
  const [drafts, setDrafts] = useState<DraftValues>(() => readProductionDraft(storageKey, logs));
  const draftsRef = useRef<DraftValues>(drafts);
  const baseDuration = task.originalDuration ?? task.duration;
  const plannedDailyProduction = task.quantity && baseDuration > 0
    ? task.quantity / baseDuration
    : 0;

  const buildLog = (dateISO: string): DailyProductionLog => ({
    id: `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    date: dateISO,
    plannedQuantity: Math.round(plannedDailyProduction * 100) / 100,
    actualQuantity: 0,
  });

  const nextDayISO = (iso: string): string => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
    base.setDate(base.getDate() + 1);
    return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  };

  const updateDraft = useCallback((key: string, value: string) => {
    setProductionError(null);
    const next = { ...draftsRef.current, [key]: value };
    draftsRef.current = next;
    setDrafts(next);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ base: JSON.stringify(logs), drafts: next, savedAt: Date.now() }));
        setDraftProtectionError(false);
      } catch {
        setDraftProtectionError(true);
      }
    }
  }, [logs, storageKey]);

  const discardDraft = useCallback((key: string) => {
    setProductionError(null);
    if (!hasOwn(draftsRef.current, key)) return;
    const { [key]: _discarded, ...next } = draftsRef.current;
    draftsRef.current = next;
    setDrafts(next);
    if (storageKey) {
      try {
        if (Object.keys(next).length === 0) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, JSON.stringify({ base: JSON.stringify(logs), drafts: next, savedAt: Date.now() }));
      } catch { setDraftProtectionError(true); }
    }
  }, [logs, storageKey]);

  const inputValue = useCallback((key: string, saved: string | number | undefined) => (
    hasOwn(drafts, key) ? drafts[key] : String(saved ?? '')
  ), [drafts]);

  const resolveDrafts = useCallback((): DailyProductionLog[] | null => {
    const resolved = applyDraftValues(logs, draftsRef.current);
    if (resolved.hasInvalidNumber) {
      setProductionError('Informe um número válido antes de confirmar o lançamento.');
      return null;
    }
    const validation = validateDailyProductionLogs(task, resolved.logs);
    if (!validation.allowed) {
      setProductionError(validation.message ?? 'A produção informada ultrapassa a quantidade contratada.');
      return null;
    }
    return resolved.logs;
  }, [logs, task]);

  const commitResolvedLogs = useCallback((nextLogs: DailyProductionLog[]) => {
    const hasChanges = JSON.stringify(nextLogs) !== JSON.stringify(logs);
    draftsRef.current = {};
    setDrafts({});
    setProductionError(null);
    if (hasChanges) onChange(nextLogs);
  }, [logs, onChange]);

  const commitDrafts = useCallback(() => {
    if (Object.keys(draftsRef.current).length === 0) return true;
    const resolved = resolveDrafts();
    if (!resolved) return false;
    commitResolvedLogs(resolved);
    return true;
  }, [commitResolvedLogs, resolveDrafts]);

  useEffect(() => registerPendingEditCommit(`production:${projectId ?? ''}:${task.id}`, commitDrafts), [commitDrafts, projectId, task.id]);
  useEffect(() => registerPendingForm(
    `production:${projectId ?? ''}:${task.id}`,
    'apontamento diário',
    () => Object.keys(draftsRef.current).length > 0,
  ), [projectId, task.id]);

  const handleDeferredBlur = useCallback((event: FocusEvent<HTMLInputElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Element && nextTarget.closest('[data-daily-log-action]')) return;
    commitDrafts();
  }, [commitDrafts]);

  const handleDeferredKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>, key: string) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDrafts();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      discardDraft(key);
    }
  }, [commitDrafts, discardDraft]);

  const addLog = (requestedDate?: string) => {
    const currentLogs = resolveDrafts();
    if (!currentLogs || getProductionQuantityLimit(task, currentLogs).completed) return;
    const today = new Date().toISOString().split('T')[0];
    const lastDate = currentLogs.length > 0
      ? [...currentLogs].sort((a, b) => a.date.localeCompare(b.date))[currentLogs.length - 1].date
      : null;
    const date = requestedDate ?? (lastDate ? nextDayISO(lastDate) : today);
    const newLog = buildLog(date);
    commitResolvedLogs([...currentLogs, newLog]);
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-actual-input="${newLog.id}"]`);
      el?.focus();
      el?.select();
    }, 50);
  };

  useEffect(() => {
    if (!focusDate || !logs.some(log => log.date === focusDate)) return;
    const timer = window.setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-log-date="${focusDate}"]`);
      el?.focus();
      el?.select();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [focusDate, logs]);

  const addLaborEntry = (logId: string) => {
    const currentLogs = resolveDrafts();
    if (!currentLogs) return;
    const entry: DailyLaborEntry = {
      id: `labor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: '',
      workerName: '',
      teamCode: '',
      hours: 8,
      hourlyCost: 0,
    };
    commitResolvedLogs(currentLogs.map(log => log.id === logId
      ? { ...log, laborEntries: [...(log.laborEntries ?? []), entry] }
      : log));
  };

  const removeLaborEntry = (logId: string, entryId: string) => {
    const currentLogs = resolveDrafts();
    if (!currentLogs) return;
    commitResolvedLogs(currentLogs.map(log => log.id === logId
      ? { ...log, laborEntries: (log.laborEntries ?? []).filter(entry => entry.id !== entryId) }
      : log));
  };

  const changeDetails = (logId: string, edit: (rows: ProductionQuantityDetail[]) => ProductionQuantityDetail[]) => {
    if (readOnly) return false;
    const currentLogs = resolveDrafts();
    if (!currentLogs) return false;
    if (onDetailChange) {
      if (Object.keys(draftsRef.current).length > 0) { setProductionError('Confirme os campos do lançamento antes de alterar o detalhe.'); return false; }
      const log = currentLogs.find(item => item.id === logId);
      if (!log) return false;
      const outcome = onDetailChange(logId, edit(log.quantityDetails ?? []));
      setProductionError(outcome.success ? null : outcome.error ?? 'O detalhe não foi alterado.');
      return outcome.success;
    }
    const nextLogs = currentLogs.map(log => {
      if (log.id !== logId) return log;
      const previousRows = log.quantityDetails ?? [];
      const nextRows = edit(previousRows);
      const previousTotal = detailTotal(previousRows);
      const nextTotal = detailTotal(nextRows);
      const followDetail = previousTotal > 0 || nextTotal > 0 || log.quantityDetailsAppliedTotal !== undefined;
      return followDetail
        ? { ...log, quantityDetails: nextRows, actualQuantity: nextTotal, quantityDetailsAppliedTotal: nextTotal }
        : { ...log, quantityDetails: nextRows };
    });
    const validation = validateDailyProductionLogs(task, nextLogs);
    if (!validation.allowed) { setProductionError(validation.message ?? 'O detalhe excede o saldo contratado. A alteração não foi gravada.'); return false; }
    commitResolvedLogs(nextLogs);
    return true;
  };

  const createDetail = (logId: string, changes: Partial<ProductionQuantityDetail>): string | null => {
    const id = crypto.randomUUID();
    return changeDetails(logId, rows => [...rows, {
      location: '', comment: '', formula: 'STANDARD', multiplier: 0, measuredQuantity: 0, dimensionC: 0, dimensionD: 0,
      ...changes, id,
    }]) ? id : null;
  };

  const applyDetail = (logId: string) => {
    if (readOnly) return;
    const currentLogs = resolveDrafts();
    if (!currentLogs) return;
    const log = currentLogs.find(item => item.id === logId);
    if (!log?.quantityDetails?.length) return;
    const total = detailTotal(log.quantityDetails);
    const nextLogs = currentLogs.map(item => item.id === logId ? { ...item, actualQuantity: total, quantityDetailsAppliedTotal: total } : item);
    const validation = validateDailyProductionLogs(task, nextLogs);
    if (!validation.allowed) { setProductionError(validation.message ?? 'O detalhe ultrapassa o saldo da tarefa.'); return; }
    commitResolvedLogs(nextLogs);
  };

  const usePlanMeasure = (plan: TakeoffPlan, measure: TakeoffMeasure, result: number) => {
    if (!planTarget || readOnly) return false;
    if (chapterId && plan.chapterId !== chapterId) { setProductionError('Esta planta não pertence ao prédio da tarefa.'); return false; }
    const targetRow = logs.find(log => log.id === planTarget.logId)?.quantityDetails?.find(row => row.id === planTarget.rowId);
    if (!targetRow) { setProductionError('A linha do detalhe não está mais disponível. Abra o detalhe novamente.'); return false; }
    const sourceField = DETAIL_SOURCE_FIELDS[planTarget.field];
    const priorSource = targetRow[sourceField];
    const updatingSameMark = priorSource?.planId === plan.id && priorSource.measureId === measure.id;
    const alreadyUsed = logs.some(log => log.quantityDetails?.some(row =>
      Object.values(DETAIL_SOURCE_FIELDS).some(key => row[key]?.planId === plan.id && row[key]?.measureId === measure.id &&
      (log.id !== planTarget.logId || row.id !== planTarget.rowId || key !== sourceField))));
    if (alreadyUsed) { setProductionError('Esta marcação já está vinculada a outra célula da tarefa. Abra ou edite a célula original para evitar contagem duplicada.'); return false; }
    let nextRowId = '';
    const applied = changeDetails(planTarget.logId, rows => {
      const index = rows.findIndex(row => row.id === planTarget.rowId);
      const updated = rows.map(row => row.id === planTarget.rowId ? {
        ...withDetailValue(row, planTarget.field, result),
        comment: row.comment || measure.name,
        [sourceField]: { planId: plan.id, planName: plan.name, floor: plan.floor, page: measure.page, measureId: measure.id, measureName: measure.name, kind: measure.kind, resultUnit: measureUnit(measure.kind, plan.scales?.[measure.page] ?? null), heightMeters: measure.heightMeters, points: measure.points.map(point => ({ ...point })) },
      } : row);
      if (updatingSameMark) { nextRowId = planTarget.rowId; return updated; }
      const below = updated[index + 1];
      if (below && isBlankDetailRow(below)) {
        nextRowId = below.id;
        return updated;
      }
      nextRowId = crypto.randomUUID();
      updated.splice(index + 1, 0, { id: nextRowId, location: '', comment: '', formula: 'STANDARD', multiplier: 0, measuredQuantity: 0, dimensionC: 0, dimensionD: 0 });
      return updated;
    });
    if (!applied) return false;
    setProductionError(null);
    setPlanTarget({ ...planTarget, rowId: nextRowId });
    return true;
  };

  const findPlanSource = (planId: string, measureId: string) => {
    for (const log of logs) for (const row of log.quantityDetails ?? [])
      for (const field of Object.keys(DETAIL_SOURCE_FIELDS) as DetailField[]) {
        const source = row[DETAIL_SOURCE_FIELDS[field]];
        if (source?.planId === planId && source.measureId === measureId) return { logId: log.id, rowId: row.id, field };
      }
    return null;
  };
  const updatePlanMeasure = (plan: TakeoffPlan, measure: TakeoffMeasure, result: number) => {
    const location = findPlanSource(plan.id, measure.id);
    if (!location) { setProductionError('A célula vinculada a esta marcação não foi encontrada.'); return false; }
    if (!Number.isFinite(result) || result <= 0) { setProductionError('A medida editada precisa ser positiva.'); return false; }
    return changeDetails(location.logId, rows => rows.map(row => row.id === location.rowId ? {
      ...withDetailValue(row, location.field, result),
      [DETAIL_SOURCE_FIELDS[location.field]]: { ...row[DETAIL_SOURCE_FIELDS[location.field]], points: measure.points.map(point => ({ ...point })), measureName: measure.name, resultUnit: measureUnit(measure.kind, plan.scales?.[measure.page] ?? null), heightMeters: measure.heightMeters },
    } : row));
  };
  const deletePlanMeasure = (plan: TakeoffPlan, measure: TakeoffMeasure) => {
    const location = findPlanSource(plan.id, measure.id);
    if (!location) { setProductionError('A célula vinculada a esta marcação não foi encontrada.'); return false; }
    const before = logs.find(log => log.id === location.logId)?.quantityDetails?.find(row => row.id === location.rowId);
    const changed = changeDetails(location.logId, rows => rows.map(row => {
      if (row.id !== location.rowId) return row;
      const cleared = withDetailValue(row, location.field, 0);
      const neutralFields = row.neutralFactors ?? (row.neutralFactor ? [row.neutralFactor] : []);
      for (const field of neutralFields) if (field !== location.field) cleared[field] = 0;
      return { ...cleared, neutralFactor: undefined, neutralFactors: [], [DETAIL_SOURCE_FIELDS[location.field]]: undefined };
    }));
    if (changed && before) deletedPlanSources.current.set(measure.id, { logId: location.logId, rowId: location.rowId, row: before });
    return changed;
  };
  const restorePlanMeasure = (_plan: TakeoffPlan, measure: TakeoffMeasure) => {
    const saved = deletedPlanSources.current.get(measure.id);
    if (!saved) { setProductionError('Não foi possível restaurar o vínculo desta marcação.'); return false; }
    const restored = changeDetails(saved.logId, rows => rows.map(row => row.id === saved.rowId ? saved.row : row));
    if (restored) deletedPlanSources.current.delete(measure.id);
    return restored;
  };

  const localPreview = useMemo(() => applyDraftValues(logs, drafts), [drafts, logs]);
  const previewValidation = useMemo(() => (
    localPreview.hasInvalidNumber ? null : validateDailyProductionLogs(task, localPreview.logs)
  ), [localPreview, task]);
  const previewLogs = localPreview.hasInvalidNumber || !previewValidation?.allowed ? logs : localPreview.logs;
  const previewTask = useMemo(() => ({ ...task, dailyLogs: previewLogs }), [previewLogs, task]);

  // Linhas: saldo dia, saldo acumulado, executado acumulado, falta executar.
  // As prévias usam o rascunho local, sem regravar a tarefa enquanto se digita.
  let acc = 0;
  let execAcc = 0;
  const totalQty = task.quantity || 0;
  const sortedLogs = [...previewLogs].sort((a, b) => a.date.localeCompare(b.date));
  const rows = sortedLogs.map(l => {
    const planned = l.plannedQuantity || 0;
    const actual = l.actualQuantity || 0;
    const delta = planned - actual;
    acc += delta;
    execAcc += actual;
    const remainingAfter = totalQty > 0 ? Math.max(totalQty - execAcc, 0) : 0;
    return {
      ...l,
      delta,
      accumulated: acc,
      executedAcc: execAcc,
      remainingAfter,
      status: statusForDelta(delta, planned),
    };
  });

  // Preview em tempo real do "Previsto" — atualiza imediatamente ao digitar realizado.
  // Regra: previsto = EXATAMENTE a última data registrada no diário (sem somar saldo).
  const parseLocal = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  };
  const formatBR = (iso: string) => {
    const d = parseLocal(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };
  const previewStartDate = sortedLogs.length > 0
    ? sortedLogs[0].date
    : (task.current?.startDate ?? task.startDate);
  const lastLogDateISO = sortedLogs.length > 0 ? sortedLogs[sortedLogs.length - 1].date : previewStartDate;
  const previewEndDate = sortedLogs.length === 0
    ? (task.current?.forecastEndDate ?? task.current?.endDate ?? task.startDate)
    : lastLogDateISO;
  const previewDuration = Math.max(
    1,
    Math.ceil((parseLocal(previewEndDate).getTime() - parseLocal(previewStartDate).getTime()) / 86400000) + 1
  );

  const accStatus = statusForDelta(task.accumulatedDelayQuantity || 0, plannedDailyProduction);
  const unit = task.unit || 'un';
  const productionLimit = getProductionQuantityLimit(task, previewLogs);

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="overflow-hidden border-t border-border bg-muted/10"
    >
      <div className="px-8 py-3 space-y-3">
        {task.baseline && (
          <div className="flex items-center gap-2 flex-wrap text-[10px] bg-card border border-border rounded-md px-2 py-1">
            <span className="font-semibold text-muted-foreground uppercase tracking-wider">Cronograma:</span>
            <span className="text-muted-foreground">Base: <strong className="text-foreground">{task.baseline.duration}d</strong> ({formatBR(task.baseline.startDate)} → {formatBR(task.baseline.endDate)})</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">Previsto: <strong className="text-primary">{previewDuration}d</strong> ({formatBR(previewStartDate)} → {formatBR(previewEndDate)})</span>
            {(() => {
              const dev = previewDuration - task.baseline.duration;
              if (dev === 0) return null;
              const cls = dev <= 0 ? 'text-success' : dev <= 2 ? 'text-warning' : 'text-destructive';
              return <span className={`font-bold ${cls}`}>· Desvio: {dev > 0 ? '+' : ''}{dev}d</span>;
            })()}
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
              <ClipboardList className="w-3.5 h-3.5 text-info" />
              Apontamento Diário — meta: <strong>{plannedDailyProduction.toFixed(1)} {unit}/dia</strong>
            </h4>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-foreground font-medium">
              Quantidade total: <strong>{productionLimit.contractedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {unit}</strong>
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-success/10 text-success font-medium">
              A executar: <strong>{productionLimit.remainingQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {unit}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${STATUS_BG[accStatus]}`}>
              Saldo: {(task.accumulatedDelayQuantity || 0).toFixed(1)} {unit}
            </span>
            {sortedLogs.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                Previsão: {formatBR(previewEndDate)}
              </span>
            )}
            {task.physicalProgress !== undefined && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-info/10 text-info font-medium">
                Físico: {task.physicalProgress.toFixed(1)}%
              </span>
            )}
          </div>
        </div>

        {(() => {
          const logsComQty = sortedLogs.filter(l => (l.actualQuantity ?? 0) > 0);
          if (logsComQty.length === 0) return null;
          const realStart = logsComQty[0].date;
          const executedTotal = logsComQty.reduce((s, l) => s + (l.actualQuantity || 0), 0);
          const remaining = Math.max(0, (task.quantity || 0) - executedTotal);
          const progress = task.quantity ? Math.min(100, (executedTotal / task.quantity) * 100) : 0;
          const avgDaily = executedTotal / logsComQty.length;
          const daysRemaining = avgDaily > 0 ? Math.ceil(remaining / avgDaily) : 0;
          const lastDate = logsComQty[logsComQty.length - 1].date;
          const [ly, lm, ld] = lastDate.split('-').map(Number);
          const fd = new Date(ly, lm - 1, ld + daysRemaining);
          const forecastISO = `${fd.getFullYear()}-${String(fd.getMonth() + 1).padStart(2, '0')}-${String(fd.getDate()).padStart(2, '0')}`;
          const plannedEndISO = task.baseline?.endDate ?? task.current?.endDate ?? task.startDate;
          const isLate = forecastISO > plannedEndISO;
          return (
            <div className="grid grid-cols-3 gap-2 p-2 bg-muted/30 rounded-lg">
              <div className="text-center">
                <div className="text-[9px] text-muted-foreground uppercase">Início real</div>
                <div className="text-[11px] font-semibold text-info">{formatBR(realStart)}</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] text-muted-foreground uppercase">Executado</div>
                <div className="text-[11px] font-semibold text-foreground">
                  {executedTotal.toFixed(1)} / {task.quantity ?? 0} {unit}
                </div>
                <div className="text-[10px] font-bold text-primary">{progress.toFixed(1)}%</div>
              </div>
              <div className="text-center">
                <div className="text-[9px] text-muted-foreground uppercase">Prev. término</div>
                <div className={`text-[11px] font-semibold ${isLate ? 'text-destructive' : 'text-success'}`}>
                  {formatBR(forecastISO)}
                </div>
              </div>
            </div>
          );
        })()}

        {productionLimit.overContract && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Divergência histórica: o executado ({productionLimit.executedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {unit}) está acima do contratado ({productionLimit.contractedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} {unit}). Reduza ou exclua um lançamento para corrigir.
          </p>
        )}
        {productionError && <p role="alert" className="text-xs font-medium text-destructive">{productionError}</p>}
        {draftProtectionError && <p role="alert" className="text-xs font-medium text-destructive">Não foi possível proteger este campo neste aparelho. Confirme o lançamento antes de sair da tela.</p>}
        {focusDate && !logs.some(log => log.date === focusDate) && (
          <button
            type="button"
            data-daily-log-action
            disabled={productionLimit.completed}
            onClick={() => addLog(focusDate)}
            className="min-h-11 self-start rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            <Plus className="mr-1.5 inline h-3.5 w-3.5" /> Lançar em {focusDate.split('-').reverse().join('/')}
          </button>
        )}

        <div className="grid grid-cols-8 gap-2 text-[10px] font-semibold text-muted-foreground uppercase">
          <div>Data</div>
          <div className="text-center">Meta ({unit})</div>
          <div className="text-center">Realizado ({unit})</div>
          <div className="text-center">Saldo Dia</div>
          <div className="text-center">Saldo Acum.</div>
          <div className="text-center">Falta Executar</div>
          <div>Obs.</div>
          <div className="text-center">Ação</div>
        </div>

        {rows.length === 0 && !focusDate && (
          <div className="flex flex-col items-center gap-2 py-3">
            <p className="text-[11px] text-muted-foreground italic">
              Sem lançamentos. Adicione o primeiro registro de produção.
            </p>
            <button
              onClick={() => addLog()}
              data-daily-log-action
              disabled={productionLimit.completed}
              className="min-h-11 text-[11px] px-3 py-1.5 rounded-md bg-primary/10 text-primary font-medium hover:bg-primary/20 transition-colors flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" /> Adicionar lançamento
            </button>
          </div>
        )}

        {rows.map(row => (
          <Fragment key={row.id}>
            <div
              className={`grid grid-cols-8 gap-2 text-[11px] items-center py-1 px-2 rounded ${STATUS_BG[row.status]}`}
            >
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={inputValue(logDraftKey(row.id, 'date'), row.date)}
                onChange={event => updateDraft(logDraftKey(row.id, 'date'), event.target.value)}
                onBlur={handleDeferredBlur}
                onKeyDown={event => handleDeferredKeyDown(event, logDraftKey(row.id, 'date'))}
                className="bg-transparent border border-current/30 rounded px-1 py-0.5 text-[10px] focus:outline-none focus:border-current min-w-0 flex-1"
              />
            </div>
              <input
                type="number"
                min={0}
                step={0.1}
                value={inputValue(logDraftKey(row.id, 'plannedQuantity'), row.plannedQuantity)}
                onChange={event => updateDraft(logDraftKey(row.id, 'plannedQuantity'), event.target.value)}
                onBlur={handleDeferredBlur}
                onKeyDown={event => handleDeferredKeyDown(event, logDraftKey(row.id, 'plannedQuantity'))}
                className="bg-transparent border border-current/30 rounded px-1 py-0.5 text-[11px] text-center focus:outline-none focus:border-current"
              />
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={maximumActualForDailyLog(previewTask, row.id)}
              step={0.1}
              value={inputValue(logDraftKey(row.id, 'actualQuantity'), row.quantityDetailsAppliedTotal !== undefined ? Number(row.actualQuantity.toFixed(4)) : row.actualQuantity)}
              data-actual-input={row.id}
              data-log-date={row.date}
              onChange={event => updateDraft(logDraftKey(row.id, 'actualQuantity'), event.target.value)}
              onBlur={handleDeferredBlur}
              onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.preventDefault(); else handleDeferredKeyDown(event, logDraftKey(row.id, 'actualQuantity')); }}
              onWheel={event => event.currentTarget.blur()}
              className="no-spinner bg-transparent border border-current/30 rounded px-1 py-0.5 text-[11px] text-center font-bold focus:outline-none focus:border-current"
              title={`Máximo permitido: ${maximumActualForDailyLog(previewTask, row.id).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${unit}`}
            />
            <div className="text-center font-bold flex items-center justify-center gap-1">
              {row.delta > 0 ? <TrendingDown className="w-3 h-3" /> : row.delta < 0 ? <TrendingUp className="w-3 h-3" /> : null}
              {row.delta.toFixed(1)}
            </div>
            <div className="text-center font-bold">{row.accumulated.toFixed(1)}</div>
            <div className={`text-center font-bold ${row.remainingAfter <= 0 ? 'text-success' : ''}`} title={`Falta executar após este lançamento: ${row.remainingAfter.toFixed(1)} ${unit}`}>
              {row.remainingAfter.toFixed(1)} {unit}
            </div>
            <input
              type="text"
              value={inputValue(logDraftKey(row.id, 'notes'), row.notes)}
              placeholder="—"
              onChange={event => updateDraft(logDraftKey(row.id, 'notes'), event.target.value)}
              onBlur={handleDeferredBlur}
              onKeyDown={event => handleDeferredKeyDown(event, logDraftKey(row.id, 'notes'))}
              className="bg-transparent border border-current/30 rounded px-1 py-0.5 text-[10px] focus:outline-none focus:border-current"
            />
            <div className="text-center flex items-center justify-center gap-1">
              <button
                type="button"
                data-daily-log-action
                onClick={() => setExpandedDetail(current => current === row.id ? null : row.id)}
                className={`p-1 rounded transition-colors ${expandedDetail === row.id ? 'bg-sky-100 text-sky-800' : 'text-primary hover:bg-primary/20'}`}
                title="Detalhar quantitativo deste dia"
                aria-label={`Detalhar quantitativo de ${row.date}`}
                aria-expanded={expandedDetail === row.id}
              ><ListTree className="w-3.5 h-3.5" /></button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  addLaborEntry(row.id);
                }}
                data-daily-log-action
                className="p-1 rounded hover:bg-primary/20 text-primary transition-colors"
                title="Apontar mão de obra deste dia"
              >
                <Users className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const currentLogs = resolveDrafts();
                  if (!currentLogs) return;
                  confirm(
                    {
                      title: 'Deseja excluir este lançamento diário?',
                      description: (
                        <>
                          <p>
                            Lançamento de <strong>{row.date}</strong> — Realizado: <strong>{row.actualQuantity ?? 0}</strong>.
                          </p>
                          <p>
                            Isso pode alterar o progresso físico, saldo, previsão de término, cronograma e medição.
                          </p>
                        </>
                      ),
                      confirmLabel: 'Excluir lançamento',
                    },
                    () => commitResolvedLogs(currentLogs.filter(log => log.id !== row.id)),
                  );
                }}
                data-daily-log-action
                className="p-1 rounded hover:bg-destructive/20 text-destructive transition-colors"
                title="Excluir lançamento"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            </div>
            {expandedDetail === row.id && <ProductionQuantityDetails
              rows={row.quantityDetails ?? []}
              unit={unit}
              dailyQuantity={row.actualQuantity}
              applied={row.quantityDetailsAppliedTotal !== undefined && row.quantityDetailsAppliedTotal === row.actualQuantity && row.quantityDetailsAppliedTotal === detailTotal(row.quantityDetails ?? [])}
              readOnly={readOnly}
              onCreate={changes => createDetail(row.id, changes)}
              onEdit={(id, changes) => changeDetails(row.id, details => details.map(detail => detail.id === id ? { ...detail, ...changes } : detail))}
              onDelete={id => changeDetails(row.id, details => details.filter(detail => detail.id !== id))}
              canOpenPlan={!!takeoffStorageKey && !!chapterId}
              clipboard={quantityClipboard}
              onCopy={(mode, detail) => onQuantityCopy?.(mode, row.id, detail)}
              onPaste={afterRowId => {
                const outcome = onQuantityPaste?.(row.id, afterRowId) ?? { success: false, error: 'A área de transferência da Produção não está disponível.' };
                setProductionError(outcome.success ? null : outcome.error ?? 'Não foi possível colar o quantitativo.');
              }}
              sharedTaskNames={sharedTaskNames}
              onOpenHistory={onOpenDetailHistory}
              onOpenPlan={(id, field) => { if (!takeoffStorageKey || !chapterId) { setProductionError('Não foi possível identificar o prédio desta tarefa para abrir o levantamento.'); return; } setProductionError(null); setPlanTarget({ logId: row.id, rowId: id, field }); }}
              onApply={() => applyDetail(row.id)}
            />}
            {(row.laborEntries ?? []).length > 0 && (
              <div className="ml-8 mr-2 rounded-md border border-border/60 bg-card/70 p-2 space-y-1.5">
                <div className="grid grid-cols-[1.2fr_1fr_0.7fr_0.65fr_0.8fr_0.8fr_28px] gap-2 text-[9px] uppercase text-muted-foreground font-semibold">
                  <span>Trabalhador</span>
                  <span>Função</span>
                  <span>Equipe</span>
                  <span className="text-right">Horas</span>
                  <span className="text-right">Custo/h</span>
                  <span className="text-right">Custo</span>
                  <span />
                </div>
                {(row.laborEntries ?? []).map(entry => {
                  const laborTotal = (Number(entry.hours) || 0) * (Number(entry.hourlyCost) || 0);
                  return (
                    <div key={entry.id} className="grid grid-cols-[1.2fr_1fr_0.7fr_0.65fr_0.8fr_0.8fr_28px] gap-2 items-center">
                      <input
                        value={inputValue(laborDraftKey(row.id, entry.id, 'workerName'), entry.workerName)}
                        placeholder="Nome"
                        onChange={event => updateDraft(laborDraftKey(row.id, entry.id, 'workerName'), event.target.value)}
                        onBlur={handleDeferredBlur}
                        onKeyDown={event => handleDeferredKeyDown(event, laborDraftKey(row.id, entry.id, 'workerName'))}
                        className="h-7 rounded border border-border bg-background px-2 text-[10px]"
                      />
                      <input
                        value={inputValue(laborDraftKey(row.id, entry.id, 'role'), entry.role)}
                        placeholder="Pedreiro"
                        onChange={event => updateDraft(laborDraftKey(row.id, entry.id, 'role'), event.target.value)}
                        onBlur={handleDeferredBlur}
                        onKeyDown={event => handleDeferredKeyDown(event, laborDraftKey(row.id, entry.id, 'role'))}
                        className="h-7 rounded border border-border bg-background px-2 text-[10px]"
                      />
                      <input
                        value={inputValue(laborDraftKey(row.id, entry.id, 'teamCode'), entry.teamCode)}
                        placeholder="Equipe"
                        onChange={event => updateDraft(laborDraftKey(row.id, entry.id, 'teamCode'), event.target.value)}
                        onBlur={handleDeferredBlur}
                        onKeyDown={event => handleDeferredKeyDown(event, laborDraftKey(row.id, entry.id, 'teamCode'))}
                        className="h-7 rounded border border-border bg-background px-2 text-[10px]"
                      />
                      <input
                        type="number"
                        min={0}
                        step={0.25}
                        value={inputValue(laborDraftKey(row.id, entry.id, 'hours'), entry.hours)}
                        onChange={event => updateDraft(laborDraftKey(row.id, entry.id, 'hours'), event.target.value)}
                        onBlur={handleDeferredBlur}
                        onKeyDown={event => handleDeferredKeyDown(event, laborDraftKey(row.id, entry.id, 'hours'))}
                        className="h-7 rounded border border-border bg-background px-2 text-right text-[10px]"
                      />
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={inputValue(laborDraftKey(row.id, entry.id, 'hourlyCost'), entry.hourlyCost)}
                        onChange={event => updateDraft(laborDraftKey(row.id, entry.id, 'hourlyCost'), event.target.value)}
                        onBlur={handleDeferredBlur}
                        onKeyDown={event => handleDeferredKeyDown(event, laborDraftKey(row.id, entry.id, 'hourlyCost'))}
                        className="h-7 rounded border border-border bg-background px-2 text-right text-[10px]"
                      />
                      <span className="text-right text-[10px] font-semibold">
                        {laborTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeLaborEntry(row.id, entry.id)}
                        data-daily-log-action
                        className="p-1 text-destructive hover:bg-destructive/10 rounded"
                        title="Excluir apontamento de mão de obra"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </Fragment>
        ))}

        {rows.length > 0 && (
          <div className="flex justify-end pt-1">
            <button
              onClick={() => addLog()}
              data-daily-log-action
              disabled={productionLimit.completed}
              className="min-h-11 px-3 py-2 rounded-md bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/20 transition-colors flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
              title={productionLimit.completed ? 'Atividade concluída; corrija um lançamento existente para liberar saldo.' : 'Adicionar lançamento após o último apontamento'}
            >
              <Plus className="w-3.5 h-3.5" /> Novo lançamento
            </button>
          </div>
        )}
      </div>
      {confirmDialog}
      <Dialog open={!!planTarget} onOpenChange={open => { if (!open) setPlanTarget(null); }}>
        <DialogContent className="flex h-[94vh] w-[96vw] max-w-[2100px] flex-col gap-2 overflow-hidden p-2 sm:p-3">
          <DialogHeader className="shrink-0 pr-8 text-left">
            <DialogTitle className="text-sm">Planta para o detalhe de quantitativo</DialogTitle>
            <DialogDescription className="text-xs">Escolha ou adicione uma planta deste prédio. A captura vai para a linha {planTarget ? (logs.find(log => log.id === planTarget.logId)?.quantityDetails?.findIndex(row => row.id === planTarget.rowId) ?? -1) + 1 : 0}, coluna {planTarget ? DETAIL_COLUMNS[planTarget.field] : 'A'}. Ao concluir, o realizado é atualizado e a próxima linha fica pronta.</DialogDescription>
          </DialogHeader>
          {productionError && <p role="alert" className="shrink-0 border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800">{productionError}</p>}
          <div className="min-h-0 flex-1 overflow-auto">
            {planTarget && takeoffStorageKey && <Suspense fallback={<p className="p-4 text-sm">Abrindo visualizador…</p>}>
              <PlanTakeoff storageKey={takeoffStorageKey} readOnly={readOnly} embedded chapterId={chapterId} measureContext={{ taskId: task.id, logId: planTarget.logId }} destinationColumn={DETAIL_COLUMNS[planTarget.field]} onUseMeasure={usePlanMeasure} onUpdateMeasure={updatePlanMeasure} onDeleteMeasure={deletePlanMeasure} onRestoreMeasure={restorePlanMeasure} onRecalibrate={(plan, page, scale) => { const result = onPlanRecalibrate?.(plan.id, page, scale); if (!result?.success) { setProductionError(result?.error ?? 'Não foi possível recalcular os lançamentos vinculados à planta.'); return false; } setProductionError(null); return true; }} allowedKinds={MEASURE_KINDS} linkedMeasureIds={logs.filter(log => log.id === planTarget.logId).flatMap(log => log.quantityDetails?.flatMap(detail => Object.values(DETAIL_SOURCE_FIELDS).map(key => detail[key]?.measureId).filter((id): id is string => !!id)) ?? [])} executedMeasureIds={logs.filter(log => log.id === planTarget.logId).flatMap(log => log.quantityDetailsAppliedTotal === log.actualQuantity && log.actualQuantity > 0 && log.quantityDetailsAppliedTotal === detailTotal(log.quantityDetails ?? []) ? log.quantityDetails?.flatMap(row => Object.values(DETAIL_SOURCE_FIELDS).map(key => row[key]?.measureId).filter((id): id is string => !!id)) ?? [] : [])} focusMeasure={logs.find(log => log.id === planTarget.logId)?.quantityDetails?.find(row => row.id === planTarget.rowId)?.[DETAIL_SOURCE_FIELDS[planTarget.field]]} />
            </Suspense>}
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
