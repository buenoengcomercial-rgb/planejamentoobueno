import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, LockKeyhole } from 'lucide-react';
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
import {
  ADDITIVE_SCHEDULE_GUIDANCE,
  ADDITIVE_SCHEDULE_REFERENCE,
  ADDITIVE_SCHEDULE_WARNING,
  FULLY_SUPPRESSED_STATUS_LABEL,
  buildAdditiveSchedulePreviewProject,
  buildAdditiveScheduleRows,
  buildPreviewSuspensionMap,
  buildProjectFromScheduleSnapshot,
  confirmAdditiveScheduleDates,
  getBlockingCompositionRefs,
  getFullySuppressedTaskIds,
  isDirectlyChangedComposition,
  mergeAdditiveSchedulePreviewChanges,
  resolveAdditiveScheduleFinancialTreatment,
  resolveAdditiveScheduleState,
  setAdditiveScheduleDependencyBlock,
  setAdditiveScheduleDependentTask,
  syncAdditiveScheduleDraft,
  validateAdditiveSchedule,
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
      kind: row.quantityRestriction && fallbackState === 'scheduled'
        ? 'quantity_limited'
        : isManual ? 'manual' : row.classification === 'contracted_suspended' ? 'automatic' : 'proposed',
      label: fallbackState === 'fully_suppressed' ? FULLY_SUPPRESSED_STATUS_LABEL : row.statusLabel,
      reason: ADDITIVE_SCHEDULE_GUIDANCE,
      additiveId: 'snapshot',
      additiveName: 'Versão arquivada',
      checked: fallbackState !== 'scheduled',
      disabled: true,
      scheduleState: fallbackState,
      financialTreatment: resolveAdditiveScheduleFinancialTreatment(row),
      quantityRestriction: row.quantityRestriction,
      blockingCompositions: row.blockingCompositions,
      blockingNote: row.blockingNote,
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
    const next = syncAdditiveScheduleDraft(project, active.id);
    if (next !== project) onProjectChange(next);
  }, [active, onProjectChange, project]);

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
  const suspensions = useMemo(() => {
    if (!active) return {};
    return isArchived && latestSnapshot ? snapshotSuspensionMap(latestSnapshot.rows, active) : buildPreviewSuspensionMap(project, active);
  }, [active, isArchived, latestSnapshot, project]);
  const issues = active ? validateAdditiveSchedule(project, active) : [];
  const directSuspended = Object.values(suspensions).filter(meta => meta.kind === 'automatic').length;
  const manualSuspended = Object.values(suspensions).filter(meta => meta.kind === 'manual').length;
  const quantityLimited = Object.values(suspensions).filter(meta => meta.kind === 'quantity_limited').length;
  const proposed = rows.filter(row => row.classification === 'proposed_addition' || row.classification === 'proposed_suppression').length;
  const eligibleBlockingCompositions = useMemo(() => (
    active ? active.compositions.filter(composition => isDirectlyChangedComposition(project, composition)) : []
  ), [active, project]);
  const blockerRefs = useMemo(() => (
    active ? getBlockingCompositionRefs(active, eligibleBlockingCompositions.map(composition => composition.id)) : []
  ), [active, eligibleBlockingCompositions]);
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
      await exportAdditiveSchedulePdf(project, active, rows, obraConfig.trabalhaSabado);
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
      <section className="rounded-xl border-2 border-red-300 bg-red-50 p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-4xl">
            <div className="flex items-center gap-2 text-red-900">
              <AlertTriangle className="h-5 w-5" />
              <h1 className="text-lg font-extrabold tracking-wide">{ADDITIVE_SCHEDULE_WARNING}</h1>
            </div>
            <p className="mt-2 text-sm text-red-950">{ADDITIVE_SCHEDULE_GUIDANCE}</p>
            <p className="mt-1 text-xs font-medium text-red-800">Referência administrativa: {ADDITIVE_SCHEDULE_REFERENCE}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {undoButton}
            <Button variant="outline" size="sm" onClick={exportExcel} disabled={!rows.length}>
              <FileSpreadsheet className="mr-2 h-4 w-4" /> Excel
            </Button>
            <Button variant="outline" size="sm" onClick={exportPdf} disabled={!rows.length}>
              <Download className="mr-2 h-4 w-4" /> PDF
            </Button>
          </div>
        </div>
      </section>

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
      </div>

      <div className="grid gap-2 md:grid-cols-5">
        <Card className="p-3"><div className="text-[10px] font-semibold uppercase text-muted-foreground">Atividades exibidas</div><div className="text-2xl font-bold">{preview?.phases.reduce((sum, phase) => sum + phase.tasks.length, 0) ?? 0}</div></Card>
        <Card className="border-sky-200 bg-sky-50 p-3"><div className="text-[10px] font-semibold uppercase text-sky-800">Execução parcial</div><div className="text-2xl font-bold text-sky-900">{quantityLimited}</div></Card>
        <Card className="border-amber-200 bg-amber-50 p-3"><div className="text-[10px] font-semibold uppercase text-amber-800">Suspensão automática</div><div className="text-2xl font-bold text-amber-900">{directSuspended}</div></Card>
        <Card className="border-orange-200 bg-orange-50 p-3"><div className="text-[10px] font-semibold uppercase text-orange-800">Dependências marcadas</div><div className="text-2xl font-bold text-orange-900">{manualSuspended}</div></Card>
        <Card className="border-rose-200 bg-rose-50 p-3"><div className="text-[10px] font-semibold uppercase text-rose-800">Linhas da proposta</div><div className="text-2xl font-bold text-rose-900">{proposed}</div></Card>
      </div>

      {!isArchived && issues.length > 0 && active && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold text-amber-900"><AlertTriangle className="h-4 w-4" /> Pendências que bloqueiam a contratação</h3>
              <ul className="mt-1 list-disc pl-5 text-xs text-amber-900">{issues.slice(0, 8).map(issue => <li key={issue}>{issue}</li>)}</ul>
            </div>
            <Button size="sm" variant="outline" onClick={() => onProjectChange(confirmAdditiveScheduleDates(project, active.id))}>
              <CheckCircle2 className="mr-2 h-4 w-4" /> Confirmar datas exibidas
            </Button>
          </div>
        </section>
      )}

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
          onToggleSuspension={isArchived ? undefined : (taskId, checked) => {
            if (checked) openBlockDialog(taskId);
            else onProjectChange(setAdditiveScheduleDependentTask(project, active.id, taskId, false));
          }}
          onEditSuspension={isArchived ? undefined : openBlockDialog}
          readOnly={isArchived}
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
          <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
            {blockerRefs.map(ref => {
              const checked = blockerIds.includes(ref.compositionId);
              const quantity = Math.abs(ref.quantity);
              const quantityText = quantity > 0
                ? `${quantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}${ref.unit ? ` ${ref.unit}` : ''}`
                : 'alteração de preço/escopo';
              return (
                <label key={ref.compositionId} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${checked ? 'border-amber-400 bg-amber-50' : 'border-border bg-card'}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={event => setBlockerIds(current => event.target.checked
                      ? [...current, ref.compositionId]
                      : current.filter(id => id !== ref.compositionId))}
                    className="mt-1 h-4 w-4 accent-amber-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-bold text-foreground">{[ref.item, ref.code].filter(Boolean).join(' - ') || 'Composição do aditivo'}</span>
                    <span className="block text-sm text-foreground">{ref.description}</span>
                    <span className="block text-xs font-semibold text-amber-800">Impacto: {quantityText}</span>
                  </span>
                </label>
              );
            })}
            {!blockerRefs.length && <div className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">Não há composições alteradas disponíveis neste aditivo.</div>}
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
