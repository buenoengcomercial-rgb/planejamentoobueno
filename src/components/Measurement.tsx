import { lazy, Suspense, useMemo, useState, useEffect, type MouseEvent } from 'react';
import { cloudMeasurementRepository } from '@/lib/measurementCloudRepository';
import { supabase } from '@/integrations/supabase/client';
import { useOrganization } from '@/hooks/useOrganization';
import type { MeasurementWorkspaceProps } from './measurement/MeasurementWorkspace';
const IndependentMeasurement = lazy(() => import('./measurement/MeasurementWorkspace'));

import { Project } from '@/types/project';
import {
  fmtDateBR,
} from '@/components/measurement/measurementFormat';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import MeasurementHeader from '@/components/measurement/MeasurementHeader';
import MeasurementStatusBar from '@/components/measurement/MeasurementStatusBar';
import MeasurementContractInfo from '@/components/measurement/MeasurementContractInfo';
import MeasurementFilters from '@/components/measurement/MeasurementFilters';
import MeasurementSummaryCards from '@/components/measurement/MeasurementSummaryCards';
import MeasurementTotals from '@/components/measurement/MeasurementTotals';
import MeasurementTable from '@/components/measurement/MeasurementTable';
import type { MeasurementDetailSelection } from '@/components/measurement/MeasurementDetailFooter';
import { useAuth } from '@/hooks/useAuth';
import { userInfoFromSupabaseUser } from '@/lib/audit';
import AuditHistoryPanel from '@/components/AuditHistoryPanel';
import { useMeasurementExports } from '@/hooks/useMeasurementExports';
import { useMeasurementState } from '@/hooks/useMeasurementState';
import { useMeasurementActions } from '@/hooks/useMeasurementActions';
import { useMeasurementRows } from '@/hooks/useMeasurementRows';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { validateMeasurement, summarizeIssues, type ValidationIssue } from '@/lib/measurementValidation';
import MeasurementValidationPanel from '@/components/MeasurementValidationPanel';
import { summarizeDailyReportsForPeriod } from '@/lib/dailyReportSummary';
import { toast } from '@/hooks/use-toast';

interface MeasurementProps {
  /** Explicit activation only after independent incorporation; never inferred from Project. */
  independentWorkspace?: MeasurementWorkspaceProps;
  onIndependentReady?: (projectId: string) => void;
  project: Project;
  onProjectChange: (project: Project) => void;
  undoButton?: React.ReactNode;
  /** Navega até a aba Diário de Obra abrindo a data informada e, opcionalmente, aplicando o filtro de medição. */
  onOpenDailyReport?: (dateISO: string, measurementFilter?: string) => void;
}

// ───────────────────────── Componente principal ─────────────────────────
export default function Measurement(props: MeasurementProps) {
  if (props.independentWorkspace) return <Suspense fallback={<p>Carregando Medição…</p>}><IndependentMeasurement {...props.independentWorkspace} analyticProject={props.project}/></Suspense>;
  return <CloudMeasurement key={props.project.id} {...props}/>;
}

/** Activation is recorded in the cloud, never inferred from a browser draft. */
function CloudMeasurement(props: MeasurementProps) {
  const { user } = useAuth();
  const { membership } = useOrganization();
  const [enabled, setEnabled] = useState<boolean | null>(null), [failure, setFailure] = useState(''), [retry, setRetry] = useState(0);
  const userId = user?.id;
  const repository = useMemo(() => userId ? cloudMeasurementRepository({ projectId: props.project.id, userId }) : null, [props.project.id, userId]);
  const onIndependentReady = props.onIndependentReady;
  useEffect(() => { if (enabled) onIndependentReady?.(props.project.id); }, [enabled, props.project.id, onIndependentReady]);
  const editor = ['owner', 'admin', 'engineer'].includes(membership?.role ?? '');
  const actor = useMemo(() => ({ id: user?.id ?? '', name: user?.user_metadata?.name ?? user?.email ?? '', canEdit: editor, canReview: editor }), [user, editor]);
  useEffect(() => {
    let alive = true;
    setFailure('');
    void supabase.from('measurement_workspaces' as never).select('project_id').eq('project_id', props.project.id).maybeSingle().then(({ data, error }) => {
      if (!alive) return;
      if (error) setFailure('Não foi possível confirmar a base da Medição na nuvem. Tente novamente; nenhum lançamento foi alterado.');
      else setEnabled(!!data);
    });
    return () => { alive = false; };
  }, [props.project.id, retry]);
  if (failure) return <div role="alert" className="rounded border p-4 text-sm">{failure} <button onClick={() => setRetry(n => n + 1)} className="underline">Tentar novamente</button></div>;
  if (enabled === null || !repository) return <p className="p-6">Conferindo a Medição na nuvem…</p>;
  return enabled ? <Suspense fallback={<p>Carregando Medição…</p>}><IndependentMeasurement repository={repository} actor={actor} analyticProject={props.project} approvedAdditives={props.project.additives}/></Suspense> : <LegacyMeasurement {...props}/>;
}

function LegacyMeasurement({ project, onProjectChange, undoButton, onOpenDailyReport }: MeasurementProps) {
  const { user } = useAuth();
  const auditUser = useMemo(() => userInfoFromSupabaseUser(user), [user]);
  const [detailSelection, setDetailSelection] = useState<MeasurementDetailSelection | null>(null);

  const measurementState = useMeasurementState({ project, onProjectChange });
  const {
    projectRef,
    measurements,
    today,
    monthAgo,
    issueDate,
    activeId, setActiveId,
    historyOpen, setHistoryOpen,
    startDate, setStartDate,
    endDate, setEndDate,
    chapterFilter, setChapterFilter,
    search, setSearch,
    collapsed, setCollapsed,
    contractor, setContractor,
    contracted, setContracted,
    contractNumber, setContractNumber,
    contractObject, setContractObject,
    location, setLocation,
    budgetSource, setBudgetSource,
    artNumber, setArtNumber,
    bdiInput, setBdiInput,
    measurementNumber, setMeasurementNumber,
    confirmGenerate, setConfirmGenerate,
    confirmEdit, setConfirmEdit,
    confirmDelete, setConfirmDelete,
    editReason, setEditReason,
    editingPriceTaskId, setEditingPriceTaskId,
    editingPriceValue, setEditingPriceValue,
  } = measurementState;

  const parsedBdi = Number.isFinite(parseFloat(bdiInput)) ? Math.max(0, parseFloat(bdiInput)) : 0;
  // Sintética importada tem prioridade sobre o BDI do contrato.
  const bdiPercent = (project.syntheticBdiPercent !== undefined && Number.isFinite(project.syntheticBdiPercent))
    ? Math.max(0, project.syntheticBdiPercent)
    : parsedBdi;
  const bdiFactor = 1 + bdiPercent / 100;

  // ───────── Linhas, filtros, agrupamento e totais (extraído para useMeasurementRows) ─────────
  const {
    numbering,
    activeMeasurement,
    isLocked,
    isSnapshotMode,
    effStart,
    effEnd,
    effBdi,
    effBdiFactor,
    effIssue,
    effNumber,
    rows,
    filteredRows,
    groupTree,
    totals,
  } = useMeasurementRows({
    project,
    measurements,
    activeId,
    startDate,
    endDate,
    chapterFilter,
    search,
    issueDate,
    bdiPercent,
    measurementNumber,
  });

  // ───────── Diários de Obra do período ─────────
  const dailyReportsSummary = useMemo(
    () => summarizeDailyReportsForPeriod(project, effStart, effEnd),
    [project, effStart, effEnd],
  );
  // ───────── Validação da medição (somente no modo "live") ─────────
  const validationIssues: ValidationIssue[] = useMemo(() => {
    if (activeMeasurement) return [];
    return validateMeasurement({
      startDate,
      endDate,
      measurementNumber,
      rows: rows.map(r => ({
        taskId: r.taskId,
        itemNumber: r.item,
        description: r.description,
        unit: r.unit,
        itemCode: r.itemCode,
        priceBank: r.priceBank,
        unitPriceNoBDI: r.unitPriceNoBDI,
        qtyContracted: r.qtyContracted,
        qtyPeriod: r.qtyPeriod,
        qtyPriorAccum: r.qtyPriorAccum,
        qtyCurrentAccum: r.qtyCurrentAccum,
        qtyBalance: r.qtyBalance,
      })),
      measurements,
      contract: {
        contractor, contracted, contractNumber, contractObject, location,
        budgetSource, bdiPercent,
      },
      dailyReports: {
        missingReports: dailyReportsSummary.missingReports,
        productionWithoutReportDays: dailyReportsSummary.productionWithoutReportDates.length,
        impedimentDays: dailyReportsSummary.impedimentDays,
      },
    });
  }, [activeMeasurement, startDate, endDate, measurementNumber, rows, measurements, contractor, contracted, contractNumber, contractObject, location, budgetSource, bdiPercent, dailyReportsSummary]);
  const validationSummary = useMemo(() => summarizeIssues(validationIssues), [validationIssues]);

  // ───────── Validação para envio à fiscalização (modo mais rigoroso) ─────────
  const [confirmSendToReview, setConfirmSendToReview] = useState(false);
  const fiscalReviewIssues: ValidationIssue[] = useMemo(() => {
    if (!activeMeasurement) return [];
    return validateMeasurement(
      {
        startDate: activeMeasurement.startDate,
        endDate: activeMeasurement.endDate,
        measurementNumber: activeMeasurement.number,
        rows: rows.map(r => ({
          taskId: r.taskId,
          itemNumber: r.item,
          description: r.description,
          unit: r.unit,
          itemCode: r.itemCode,
          priceBank: r.priceBank,
          unitPriceNoBDI: r.unitPriceNoBDI,
          qtyContracted: r.qtyContracted,
          qtyPeriod: r.qtyPeriod,
          qtyPriorAccum: r.qtyPriorAccum,
          qtyCurrentAccum: r.qtyCurrentAccum,
          qtyBalance: r.qtyBalance,
        })),
        measurements: measurements.filter(m => m.id !== activeMeasurement.id),
        contract: {
          contractor, contracted, contractNumber, contractObject, location,
          budgetSource, bdiPercent,
        },
        dailyReports: {
          missingReports: dailyReportsSummary.missingReports,
          productionWithoutReportDays: dailyReportsSummary.productionWithoutReportDates.length,
          impedimentDays: dailyReportsSummary.impedimentDays,
        },
      },
      { mode: 'fiscal-review' },
    );
  }, [activeMeasurement, rows, measurements, contractor, contracted, contractNumber, contractObject, location, budgetSource, bdiPercent, dailyReportsSummary]);
  const fiscalReviewSummary = useMemo(() => summarizeIssues(fiscalReviewIssues), [fiscalReviewIssues]);

  /** Tem avisos não-bloqueantes específicos de diário/impedimento que requerem confirmação extra. */
  const hasDailyWarnings =
    !activeMeasurement && (
      dailyReportsSummary.missingReports > 0 ||
      dailyReportsSummary.productionWithoutReportDates.length > 0 ||
      dailyReportsSummary.impedimentDays > 0
    );

  // ───────── Ações (extraídas para useMeasurementActions) ─────────
  const {
    persistContractInfo,
    updateTaskField,
    updateUnitPriceNoBDI,
    setManualPeriodQuantity,
    patchSnapshotItem,
    generateMeasurement,
    unlockForEdit,
    resendForReview,
    setStatus,
    deleteMeasurement,
    newMeasurementDraft,
  } = useMeasurementActions({
    project,
    projectRef,
    onProjectChange,
    auditUser,
    activeMeasurement,
    isLocked,
    isSnapshotMode,
    setActiveId,
    rows,
    measurements,
    dailyReportsSummary,
    validationSummary,
    effStart,
    effEnd,
    effBdi,
    effBdiFactor,
    startDate,
    endDate,
    today,
    monthAgo,
    bdiPercent,
    bdiFactor,
    contractor,
    contracted,
    contractNumber,
    contractObject,
    location,
    budgetSource,
    measurementNumber,
    editReason,
    setStartDate,
    setEndDate,
    setChapterFilter,
    setSearch,
    setMeasurementNumber,
    setConfirmGenerate,
    setConfirmEdit,
    setConfirmDelete,
    setEditReason,
  });

  // ───────── EXPORT XLSX / PDF (extraído para useMeasurementExports) ─────────
  const { exportXLSX, handlePrint } = useMeasurementExports({
    project,
    projectRef,
    onProjectChange,
    activeMeasurement,
    groupTree,
    totals,
    headerForm: {
      contractor, contracted, contractNumber, contractObject, location, budgetSource, artNumber, bdiPercent,
    },
    effStart,
    effEnd,
    effIssue,
    effBdi,
    effNumber,
    dailyReportsSummary,
    auditUser,
  });

  const handleDetailClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('[data-detail-cell="true"]')) return;
    if (target.closest('[data-measurement-row="true"]')) return;
    if (target.closest('[data-detail-panel="true"]')) return;
    if (target.closest('[data-detail-footer="true"]')) return;
    setDetailSelection(null);
  };

  const toggleAnalyticDetail = (taskId: string) => {
    setDetailSelection(prev =>
      prev?.taskId === taskId && prev.mode === 'analytic'
        ? null
        : { taskId, mode: 'analytic' },
    );
  };

  return (
    <div className="measurement-print-root p-4 lg:p-5 pb-56 space-y-4 print:p-0 print:space-y-3" onClickCapture={handleDetailClickCapture}>
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 8mm; }
          html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: white !important; }
          .print-hide { display: none !important; }
          /* Hide app chrome (sidebar, toolbars, etc.) */
          [data-sidebar],
          aside,
          [data-sidebar="sidebar"],
          [data-sidebar="trigger"],
          [data-sidebar="rail"] { display: none !important; }
          /* Make the main content take full width */
          main, [role="main"] { width: 100% !important; max-width: 100% !important; margin: 0 !important; padding: 0 !important; }

          .measurement-table {
            font-size: 6.5px !important;
            min-width: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
            table-layout: fixed !important;
          }
          .measurement-table th, .measurement-table td {
            padding: 2px 3px !important;
            line-height: 1.15 !important;
            overflow-wrap: anywhere !important;
            word-break: break-word !important;
            white-space: normal !important;
            vertical-align: top !important;
          }
          .measurement-table tr,
          .measurement-table tbody tr.chapter-row,
          .measurement-table tbody tr.subtotal-row { page-break-inside: avoid; break-inside: avoid; }
          .measurement-table .cell-desc {
            white-space: normal !important;
            word-break: break-word !important;
            overflow-wrap: anywhere !important;
            text-align: left !important;
          }
          .measurement-table .cell-und { white-space: nowrap !important; text-align: center !important; }
          /* Right-align monetary cells (those whose <th> were text-right map by column index via colgroup) */
          .measurement-table th, .measurement-table td { position: static !important; }

          /* Column widths in % to fit a single landscape page (15 cols) */
          .measurement-table col.col-item { width: 4% !important; }
          .measurement-table col.col-code { width: 6% !important; }
          .measurement-table col.col-bank { width: 5% !important; }
          .measurement-table col.col-desc { width: 25% !important; min-width: 0 !important; max-width: none !important; }
          .measurement-table col.col-und  { width: 4% !important; }
          /* qty/val columns: there are 5 qty + 5 val after desc/und.
             Use nth-of-type to set widths in print precisely. */
          .measurement-table colgroup col:nth-child(6)  { width: 6% !important; } /* Quant Contrat */
          .measurement-table colgroup col:nth-child(7)  { width: 7% !important; } /* V Unit s/BDI */
          .measurement-table colgroup col:nth-child(8)  { width: 7% !important; } /* V Unit c/BDI */
          .measurement-table colgroup col:nth-child(9)  { width: 8% !important; } /* Total Contratado */
          .measurement-table colgroup col:nth-child(10) { width: 6% !important; } /* Quant Medição */
          .measurement-table colgroup col:nth-child(11) { width: 8% !important; } /* Subtotal Medição */
          .measurement-table colgroup col:nth-child(12) { width: 6% !important; } /* Quant Acum */
          .measurement-table colgroup col:nth-child(13) { width: 8% !important; } /* Subtotal Acum */
          .measurement-table colgroup col:nth-child(14) { width: 6% !important; } /* Quant a Executar */
          .measurement-table colgroup col:nth-child(15) { width: 8% !important; } /* Subtotal a Executar */

          /* Compact header/summary cards */
          .print\\:break-inside-avoid { break-inside: avoid; page-break-inside: avoid; }
          .measurement-print-root .summary-card { padding: 4px 6px !important; }
          .measurement-print-root h1, .measurement-print-root h2 { font-size: 12px !important; margin: 0 !important; }
          .measurement-print-root .text-2xl { font-size: 12px !important; }
          .measurement-print-root .text-xl { font-size: 11px !important; }
          .measurement-print-root .text-lg { font-size: 10px !important; }
        }
      `}</style>

      {/* Toolbar */}
      <MeasurementHeader
        undoButton={undoButton}
        onExportXLSX={exportXLSX}
        onPrint={handlePrint}
        showHistory={!!activeMeasurement}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      {/* Seletor de medições salvas + status */}
      <MeasurementStatusBar
        measurements={measurements}
        activeId={activeId}
        setActiveId={setActiveId}
        activeMeasurement={activeMeasurement}
        isLocked={isLocked}
        newMeasurementDraft={newMeasurementDraft}
        onConfirmGenerate={() => setConfirmGenerate(true)}
        onConfirmEdit={() => setConfirmEdit(true)}
        onConfirmDelete={() => setConfirmDelete(true)}
        setStatus={setStatus}
        validationHasBlocking={validationSummary.hasBlocking}
        onSendToReview={() => setConfirmSendToReview(true)}
        onResendForReview={resendForReview}
      />

      {/* Painel de validação (somente em modo "live") */}
      {!activeMeasurement && (
        <div className="print:hidden">
          <MeasurementValidationPanel
            issues={validationIssues}
            onOpenDailyReport={
              onOpenDailyReport
                ? () => onOpenDailyReport(effStart, 'draft')
                : undefined
            }
          />
        </div>
      )}

      {/* Cabeçalho técnico do boletim */}
      <MeasurementContractInfo
        project={project}
        isSnapshotMode={isSnapshotMode}
        effStart={effStart}
        effEnd={effEnd}
        effIssue={effIssue}
        effBdi={effBdi}
        effNumber={effNumber}
        contractor={contractor} setContractor={setContractor}
        contracted={contracted} setContracted={setContracted}
        contractNumber={contractNumber} setContractNumber={setContractNumber}
        contractObject={contractObject} setContractObject={setContractObject}
        location={location} setLocation={setLocation}
        budgetSource={budgetSource} setBudgetSource={setBudgetSource}
        artNumber={artNumber} setArtNumber={setArtNumber}
        bdiInput={bdiInput} setBdiInput={setBdiInput}
        bdiPercent={bdiPercent}
        measurementNumber={measurementNumber} setMeasurementNumber={setMeasurementNumber}
        persistContractInfo={persistContractInfo}
        onProjectNameChange={name => onProjectChange({ ...project, name })}
      />

      {/* Filtros (live e snapshot) */}
      <MeasurementFilters
        project={project}
        isSnapshotMode={isSnapshotMode}
        effStart={effStart}
        effEnd={effEnd}
        setStartDate={setStartDate}
        setEndDate={setEndDate}
        chapterFilter={chapterFilter}
        setChapterFilter={setChapterFilter}
        search={search}
        setSearch={setSearch}
        numbering={numbering}
      />

      {/* Resumo técnico */}
      {/* Tabela */}
      <MeasurementTable
        filteredRows={filteredRows}
        groupTree={groupTree}
        totals={totals}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        isLocked={isLocked}
        isSnapshotMode={isSnapshotMode}
        editingPriceTaskId={editingPriceTaskId}
        editingPriceValue={editingPriceValue}
        setEditingPriceTaskId={setEditingPriceTaskId}
        setEditingPriceValue={setEditingPriceValue}
        updateUnitPriceNoBDI={updateUnitPriceNoBDI}
        updateTaskField={updateTaskField}
        patchSnapshotItem={patchSnapshotItem}
        setManualPeriodQuantity={setManualPeriodQuantity}
        selectedDetail={detailSelection}
        onSelectDetail={setDetailSelection}
        onToggleAnalyticDetail={toggleAnalyticDetail}
        project={project}
        bdi={effBdi}
      />

      {/* Rodapé técnico */}
      <div className="space-y-3">
        <MeasurementTotals totals={totals} effBdi={effBdi} />
        <MeasurementSummaryCards totals={totals} />
      </div>

      {/* Histórico de alterações */}
      {activeMeasurement?.history && activeMeasurement.history.length > 0 && (
        <Card className="print:hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Histórico de alterações</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-64 overflow-auto text-xs">
              <table className="w-full">
                <thead className="bg-muted/40 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-1.5">Data/Hora</th>
                    <th className="text-left px-3 py-1.5">Campo</th>
                    <th className="text-left px-3 py-1.5">Anterior</th>
                    <th className="text-left px-3 py-1.5">Novo</th>
                    <th className="text-left px-3 py-1.5">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {activeMeasurement.history.slice().reverse().map((h, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="px-3 py-1 tabular-nums">{new Date(h.at).toLocaleString('pt-BR')}</td>
                      <td className="px-3 py-1">{h.field}</td>
                      <td className="px-3 py-1 text-muted-foreground">{h.previous}</td>
                      <td className="px-3 py-1">{h.next}</td>
                      <td className="px-3 py-1 text-muted-foreground">{h.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Assinaturas (impressão) */}
      <div className="hidden print:grid grid-cols-2 gap-8 mt-12 pt-8 text-[11px]">
        <SignatureBox label="Responsável Técnico" />
        <SignatureBox label="Fiscal da Obra" />
        <SignatureBox label="Contratante" />
        <SignatureBox label="Contratada" />
      </div>

      {/* Diálogo: Gerar Medição */}
      <AlertDialog open={confirmGenerate} onOpenChange={setConfirmGenerate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {validationSummary.warnings > 0
                ? 'Esta medição possui avisos. Deseja gerar mesmo assim?'
                : `Gerar medição nº ${measurementNumber}?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Será criado um snapshot com {rows.length} item(ns) referente ao período de{' '}
                  {fmtDateBR(startDate)} a {fmtDateBR(endDate)}.
                  Após gerar, esta medição ficará bloqueada para edição direta.
                  Alterações futuras na EAP ou nos apontamentos não afetarão o snapshot.
                </p>
                {validationSummary.warnings > 0 && (
                  <div className="rounded border border-warning/30 bg-warning/10 p-2">
                    <p className="font-medium text-warning mb-1">
                      Avisos encontrados ({validationSummary.warnings}):
                    </p>
                    <ul className="list-disc pl-5 space-y-0.5 text-xs">
                      {validationIssues
                        .filter(i => i.level === 'warning')
                        .map((i, idx) => (
                          <li key={idx}>{i.message}</li>
                        ))}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={generateMeasurement}>
              {validationSummary.warnings > 0 ? 'Gerar mesmo assim' : 'Gerar Medição'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Diálogo: Editar Medição */}
      <AlertDialog open={confirmEdit} onOpenChange={setConfirmEdit}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Liberar medição para ajustes?</AlertDialogTitle>
            <AlertDialogDescription>
              A medição nº {activeMeasurement?.number} terá o snapshot destravado para edição controlada.
              Após o ajuste, clique em "Reenviar p/ Fiscal" para que volte à análise.
              Cada alteração ficará registrada no histórico.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-1">
            <label className="text-xs font-medium text-muted-foreground">Motivo do ajuste</label>
            <Input
              placeholder="Ex.: Fiscal solicitou redução de quantidade no item 1.2.1"
              value={editReason}
              onChange={e => setEditReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={unlockForEdit}>Liberar edição</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Diálogo: Enviar para Fiscal */}
      <AlertDialog open={confirmSendToReview} onOpenChange={setConfirmSendToReview}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {fiscalReviewSummary.hasBlocking
                ? 'Não é possível enviar para fiscalização'
                : (fiscalReviewSummary.warnings + fiscalReviewSummary.infos > 0
                    ? 'Esta medição possui avisos antes do envio para fiscalização. Deseja continuar mesmo assim?'
                    : `Enviar medição nº ${activeMeasurement?.number} para fiscalização?`)}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {fiscalReviewSummary.hasBlocking && (
                  <div className="rounded border border-destructive/30 bg-destructive/10 p-2">
                    <p className="font-medium text-destructive mb-1">
                      Erros bloqueantes ({fiscalReviewSummary.errors}):
                    </p>
                    <ul className="list-disc pl-5 space-y-0.5 text-xs">
                      {fiscalReviewIssues
                        .filter(i => i.level === 'error')
                        .map((i, idx) => <li key={idx}>{i.message}</li>)}
                    </ul>
                  </div>
                )}
                {(fiscalReviewSummary.warnings + fiscalReviewSummary.infos) > 0 && (
                  <div className="rounded border border-warning/30 bg-warning/10 p-2">
                    <p className="font-medium text-warning mb-1">
                      Avisos ({fiscalReviewSummary.warnings + fiscalReviewSummary.infos}):
                    </p>
                    <ul className="list-disc pl-5 space-y-0.5 text-xs">
                      {fiscalReviewIssues
                        .filter(i => i.level !== 'error')
                        .map((i, idx) => <li key={idx}>{i.message}</li>)}
                    </ul>
                  </div>
                )}
                {!fiscalReviewSummary.hasBlocking && (
                  <p>O status passará para "Em análise fiscal".</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            {!fiscalReviewSummary.hasBlocking && (
              <AlertDialogAction
                onClick={() => {
                  resendForReview();
                  setConfirmSendToReview(false);
                }}
              >
                {(fiscalReviewSummary.warnings + fiscalReviewSummary.infos) > 0
                  ? 'Enviar mesmo assim'
                  : 'Enviar para Fiscal'}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir medição nº {activeMeasurement?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              O conteúdo anterior ficará preservado no histórico de exclusão. A EAP e os apontamentos diários não são afetados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={deleteMeasurement} className="bg-destructive text-destructive-foreground">
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {activeMeasurement && (
        <AuditHistoryPanel
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          project={project}
          entityType="measurement"
          entityId={activeMeasurement.id}
          title={`Medição nº ${activeMeasurement.number}`}
        />
      )}
    </div>
  );
}

// ───────── Subcomponentes ─────────
function SignatureBox({ label }: { label: string }) {
  return (
    <div>
      <div className="border-t border-foreground pt-1 text-center">
        <p className="font-semibold uppercase tracking-wider text-[10px]">{label}</p>
        <p className="text-[9px] text-muted-foreground">Nome / CREA / Assinatura</p>
      </div>
    </div>
  );
}
