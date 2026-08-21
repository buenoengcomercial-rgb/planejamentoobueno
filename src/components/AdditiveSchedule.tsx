import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, FileSpreadsheet, LockKeyhole } from 'lucide-react';
import { toast } from 'sonner';
import type { Additive, AdditiveScheduleSnapshotRow, Project } from '@/types/project';
import GanttChart from '@/components/GanttChart';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { loadObraConfig } from '@/components/ConfiguracaoObra';
import AdditiveScheduleFinancialForecast from '@/components/additiveSchedule/AdditiveScheduleFinancialForecast';
import { buildAdditiveScheduleForecast } from '@/lib/additiveScheduleForecast';
import {
  ADDITIVE_SCHEDULE_GUIDANCE,
  FULLY_SUPPRESSED_STATUS_LABEL,
  buildAdditiveSchedulePreviewProject,
  buildAdditiveScheduleRows,
  buildPreviewSuspensionMap,
  buildProjectFromScheduleSnapshot,
  confirmAdditiveScheduleDates,
  getBlockingCompositionRefs,
  getEligibleBlockingCompositions,
  getFullySuppressedTaskIds,
  mergeAdditiveSchedulePreviewChanges,
  resolveAdditiveScheduleFinancialTreatment,
  resolveAdditiveScheduleState,
  setAdditiveScheduleDependencyBlock,
  setAdditiveScheduleCollapsedPhaseIds,
  setAdditiveScheduleDependentTask,
  settleAdditiveScheduleDraft,
  syncAdditiveScheduleDraft,
  type AdditiveScheduleSuspensionMeta,
} from '@/lib/additiveSchedule';
import { exportAdditiveScheduleExcel, exportAdditiveSchedulePdf } from '@/lib/additiveScheduleReports';

interface Props {
  project: Project;
  onProjectChange: (next: Project | ((previous: Project) => Project)) => void;
  undoButton?: React.ReactNode;
}

function snapshotSuspensionMap(rows: AdditiveScheduleSnapshotRow[], additive: Additive): Record<string, AdditiveScheduleSuspensionMeta> {
  const result: Record<string, AdditiveScheduleSuspensionMeta> = {};
  const legacyFullySuppressed = getFullySuppressedTaskIds(additive);
  rows.forEach(row => {
    if (row.description.startsWith('Impacto do aditivo - ')) return;
    const fallbackState = legacyFullySuppressed.has(row.taskId) ? 'fully_suppressed' : resolveAdditiveScheduleState(row);
    if (fallbackState === 'scheduled' && row.classification === 'contracted_released' && !row.quantityRestriction) return;
    const isManual = row.classification === 'contracted_suspended' && !!row.blockingCompositions?.length;
    result[row.taskId] = {
      kind: row.dependencyBlockingTaskIds?.length
        ? 'dependency'
        : row.quantityRestriction && fallbackState === 'scheduled'
          ? 'quantity_limited'
          : isManual ? 'manual' : row.classification === 'contracted_suspended' ? 'automatic' : 'proposed',
      label: fallbackState === 'fully_suppressed' ? FULLY_SUPPRESSED_STATUS_LABEL : row.statusLabel,
      reason: row.suspensionReason ?? ADDITIVE_SCHEDULE_GUIDANCE,
      additiveId: 'snapshot',
      additiveName: 'Versão arquivada',
      checked: fallbackState !== 'scheduled',
      disabled: true,
      scheduleState: fallbackState,
      financialTreatment: resolveAdditiveScheduleFinancialTreatment(row),
      quantityRestriction: row.quantityRestriction,
      blockingCompositions: row.blockingCompositions,
      blockingNote: row.blockingNote,
      dependencyBlockingTaskIds: row.dependencyBlockingTaskIds,
    };
  });
  return result;
}

export default function AdditiveSchedule({ project, onProjectChange, undoButton }: Props) {
  const additives = project.additives ?? [];
  const preferred = additives.find(additive => !additive.isContracted || additive.editUnlocked) ?? additives[0];
  const [activeId, setActiveId] = useState(preferred?.id ?? '');
  const [blockTaskId, setBlockTaskId] = useState<string | null>(null);
  const [blockerIds, setBlockerIds] = useState<string[]>([]);
  const [blockerNote, setBlockerNote] = useState('');
  const active = additives.find(additive => additive.id === activeId) ?? preferred;
  const obraConfig = useMemo(loadObraConfig, []);

  useEffect(() => {
    if (!active && preferred) setActiveId(preferred.id);
  }, [active, preferred]);

  useEffect(() => {
    if (!active || (active.isContracted && !active.editUnlocked)) return;
    const synced = syncAdditiveScheduleDraft(project, active.id);
    const next = settleAdditiveScheduleDraft(synced, active.id, obraConfig);
    if (next !== project) {
      const before = active.scheduleDraft; const after = (next.additives ?? []).find(a => a.id === active.id)?.scheduleDraft;
      const bp = before?.contractedTaskPlans ?? []; const ap = after?.contractedTaskPlans ?? [];
      const bkeys = new Set(bp.map(x => x.taskId));
      console.log('[DBGAS]', { syncChanged: synced !== project, settleChanged: next !== synced, blen: bp.length, alen: ap.length, added: ap.filter(x => !bkeys.has(x.taskId)).map(x => x.taskId).slice(0,3) });
      onProjectChange(next);
    }
  }, [active, obraConfig, onProjectChange, project]);

  const isArchived = !!active?.isContracted && !active.editUnlocked;
  const latestSnapshot = useMemo(() => active?.scheduleSnapshots?.slice().sort((a, b) => b.version - a.version)[0], [active?.scheduleSnapshots]);
  const preview = useMemo(() => {
    if (!active) return null;
    if (isArchived) return latestSnapshot ? buildProjectFromScheduleSnapshot(project, latestSnapshot) : null;
    return active.scheduleDraft ? buildAdditiveSchedulePreviewProject(project, active, active.scheduleDraft, obraConfig) : null;
  }, [active, isArchived, latestSnapshot, obraConfig, project]);
  const rows = useMemo(() => {
    if (!active || !preview) return [];
    return isArchived && latestSnapshot ? latestSnapshot.rows : buildAdditiveScheduleRows(project, active, preview);
  }, [active, isArchived, latestSnapshot, preview, project]);
  const financialForecast = useMemo(
    () => buildAdditiveScheduleForecast(rows, obraConfig.trabalhaSabado),
    [obraConfig.trabalhaSabado, rows],
  );
  const suspensions = useMemo(() => {
    if (!active) return {};
    return isArchived && latestSnapshot ? snapshotSuspensionMap(latestSnapshot.rows, active) : buildPreviewSuspensionMap(project, active, preview ?? undefined);
  }, [active, isArchived, latestSnapshot, preview, project]);
  const blockerGroups = useMemo(() => {
    if (!active) return [];
    const plannedCompositionIds = new Set(
      (active.scheduleDraft?.plannedTasks ?? []).map(task => task.compositionId),
    );
    const refs = getBlockingCompositionRefs(
      active,
      getEligibleBlockingCompositions(project, active).map(composition => composition.id),
    );
    return [{
      id: 'new',
      label: 'SERVIÇOS - ITENS NOVOS',
      refs: refs.filter(ref => plannedCompositionIds.has(ref.compositionId)),
    }, {
      id: 'contracted',
      label: 'ITENS CONTRATADOS ALTERADOS',
      refs: refs.filter(ref => !plannedCompositionIds.has(ref.compositionId)),
    }].filter(group => group.refs.length > 0);
  }, [active, project]);
  const blockerCount = blockerGroups.reduce((sum, group) => sum + group.refs.length, 0);
  const blockingTaskName = preview?.phases.flatMap(phase => phase.tasks).find(task => task.id === blockTaskId)?.name;

  const openBlockDialog = (taskId: string) => {
    if (!active) return;
    const current = active.scheduleDraft?.dependencyBlocks?.find(block => block.taskId === taskId);
    setBlockTaskId(taskId);
    setBlockerIds(current?.compositionIds ?? []);
    setBlockerNote(current?.note ?? '');
  };

  const closeBlockDialog = () => {
    setBlockTaskId(null);
    setBlockerIds([]);
    setBlockerNote('');
  };

  const saveBlock = () => {
    if (!active || !blockTaskId) return;
    if (!blockerIds.length) {
      toast.error('Selecione ao menos uma composição que impede a execução.');
      return;
    }
    onProjectChange(setAdditiveScheduleDependencyBlock(project, active.id, blockTaskId, blockerIds, blockerNote));
    closeBlockDialog();
  };

  const exportPdf = async () => {
    if (!active) return;
    try {
      toast.loading('Gerando PDF do Cronograma do Aditivo...', { id: 'additive-schedule-pdf' });
      await exportAdditiveSchedulePdf(project, active, rows, obraConfig.trabalhaSabado, preview ?? project);
      toast.success('PDF gerado.', { id: 'additive-schedule-pdf' });
    } catch (error) {
      console.error(error);
      toast.error('Não foi possível gerar o PDF.', { id: 'additive-schedule-pdf' });
    }
  };

  const exportExcel = async () => {
    if (!active) return;
    try {
      toast.loading('Gerando Excel do Cronograma do Aditivo...', { id: 'additive-schedule-xlsx' });
      await exportAdditiveScheduleExcel(project, active, rows, obraConfig.trabalhaSabado);
      toast.success('Excel gerado.', { id: 'additive-schedule-xlsx' });
    } catch (error) {
      console.error(error);
      toast.error('Não foi possível gerar o Excel.', { id: 'additive-schedule-xlsx' });
    }
  };

  if (!additives.length) {
    return <div className="p-4"><Card className="p-10 text-center text-muted-foreground">Crie ou importe um aditivo antes de montar o cronograma preliminar.</Card></div>;
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
        <label className="min-w-[300px] space-y-1 text-xs font-semibold text-muted-foreground">
          Aditivo
          <Select value={active?.id} onValueChange={setActiveId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{additives.map(additive => <SelectItem key={additive.id} value={additive.id}>{additive.name}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        {isArchived && latestSnapshot && (
          <div className="flex items-center gap-2 rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700">
            <LockKeyhole className="h-4 w-4" /> Versão {latestSnapshot.version} arquivada em {new Date(latestSnapshot.archivedAt).toLocaleString('pt-BR')}
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {undoButton}
          {!isArchived && active && (
            <Button size="sm" variant="outline" onClick={() => onProjectChange(confirmAdditiveScheduleDates(project, active.id))}>
              <CheckCircle2 className="mr-2 h-4 w-4" /> Confirmar datas
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={exportExcel} disabled={!rows.length}>
            <FileSpreadsheet className="mr-2 h-4 w-4" /> Excel
          </Button>
          <Button variant="outline" size="sm" onClick={exportPdf} disabled={!rows.length}>
            <Download className="mr-2 h-4 w-4" /> PDF
          </Button>
        </div>
      </div>

      {isArchived && !latestSnapshot && (
        <Card className="border-dashed p-8 text-center text-muted-foreground">Este aditivo foi contratado antes da criação do Cronograma do Aditivo. Não existe histórico retroativo para exibir.</Card>
      )}

      {active && preview && (
        <GanttChart
          project={preview}
          onProjectChange={isArchived ? undefined : nextPreview => onProjectChange(mergeAdditiveSchedulePreviewChanges(project, active.id, preview, nextPreview))}
          context="additive-preview"
          title="Cronograma do Aditivo"
          subtitle={isArchived ? 'Versão histórica somente para leitura' : 'Planejamento preliminar físico-financeiro'}
          suspensionMap={suspensions}
          collapsedPhaseIds={active.uiState?.scheduleCollapsedPhaseIds ?? []}
          onCollapsedPhaseIdsChange={phaseIds => onProjectChange(previous => (
            setAdditiveScheduleCollapsedPhaseIds(previous, active.id, phaseIds)
          ))}
          onToggleSuspension={isArchived ? undefined : (taskId, checked) => {
            if (checked) openBlockDialog(taskId);
            else onProjectChange(setAdditiveScheduleDependentTask(project, active.id, taskId, false));
          }}
          onEditSuspension={isArchived ? undefined : openBlockDialog}
          readOnly={isArchived}
          monthlyFinancialForecast={financialForecast.months}
          financialForecastNode={<AdditiveScheduleFinancialForecast rows={rows} trabalhaSabado={obraConfig.trabalhaSabado} />}
        />
      )}

      <Dialog open={!!blockTaskId} onOpenChange={open => { if (!open) closeBlockDialog(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Composições que bloqueiam a execução</DialogTitle>
            <DialogDescription>
              Selecione os itens do aditivo necessários antes de executar “{blockingTaskName || 'tarefa selecionada'}”. A seleção será registrada no histórico, PDF e Excel.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[46vh] space-y-4 overflow-y-auto pr-1">
            {blockerGroups.map(group => (
              <section key={group.id} data-testid={`blocking-group-${group.id}`} className="space-y-2">
                <div className="sticky top-0 z-10 flex items-center justify-between rounded-md bg-muted px-3 py-2 text-xs font-bold text-foreground shadow-sm">
                  <span>{group.label}</span>
                  <span className="rounded-full bg-background px-2 py-0.5 text-[10px] text-muted-foreground">{group.refs.length}</span>
                </div>
                {group.refs.map(ref => {
                  const checked = blockerIds.includes(ref.compositionId);
                  const quantity = Math.abs(ref.quantity);
                  const quantityText = quantity > 0
                    ? `${quantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}${ref.unit ? ` ${ref.unit}` : ''}`
                    : 'alteração de preço/escopo';
                  const referenceLabel = [ref.item, ref.code].filter(Boolean).join(' - ') || 'Composição do aditivo';
                  return (
                    <label key={ref.compositionId} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${checked ? 'border-amber-400 bg-amber-50' : 'border-border bg-card'}`}>
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${referenceLabel} ${ref.description}`}
                        checked={checked}
                        onChange={event => setBlockerIds(current => event.target.checked
                          ? [...current, ref.compositionId]
                          : current.filter(id => id !== ref.compositionId))}
                        className="mt-1 h-4 w-4 accent-amber-600"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-bold text-foreground">{referenceLabel}</span>
                        <span className="block text-sm text-foreground">{ref.description}</span>
                        <span className="block text-xs font-semibold text-amber-800">Impacto: {quantityText}</span>
                      </span>
                    </label>
                  );
                })}
              </section>
            ))}
            {!blockerCount && <div className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">Não há composições alteradas ou novas disponíveis neste aditivo.</div>}
          </div>
          <Textarea
            value={blockerNote}
            onChange={event => setBlockerNote(event.target.value)}
            placeholder="Justificativa opcional da dependência técnica, física ou operacional"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={closeBlockDialog}>Cancelar</Button>
            <Button onClick={saveBlock} disabled={!blockerIds.length}>Suspender tarefa</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
