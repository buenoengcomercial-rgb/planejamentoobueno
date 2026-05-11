import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Upload } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Project } from '@/types/project';
import { additiveTotals } from '@/lib/additiveImport';
import AuditHistoryPanel from '@/components/AuditHistoryPanel';

import { useAdditiveState } from '@/hooks/useAdditiveState';
import { useAdditiveActions } from '@/hooks/useAdditiveActions';
import { useAdditiveGroups } from '@/hooks/useAdditiveGroups';

import AdditiveHeader from '@/components/additive/AdditiveHeader';
import AdditiveTabs from '@/components/additive/AdditiveTabs';
import AdditiveApprovalBanner from '@/components/additive/AdditiveApprovalBanner';
import AdditiveSummaryCards from '@/components/additive/AdditiveSummaryCards';
import AdditiveFilters from '@/components/additive/AdditiveFilters';
import AdditiveTable from '@/components/additive/AdditiveTable';
import AdditiveTotalsBlock from '@/components/additive/AdditiveTotalsBlock';
import AdditiveImportDialog from '@/components/additive/AdditiveImportDialog';
import AdditiveIssuesDialog from '@/components/additive/AdditiveIssuesDialog';
import AdditiveReviewDialog from '@/components/additive/AdditiveReviewDialog';
import AdditiveSyntheticConflictDialog from '@/components/additive/AdditiveSyntheticConflictDialog';
import AdditiveHeaderInfo from '@/components/additive/AdditiveHeaderInfo';

interface Props {
  project: Project;
  onProjectChange: (next: Project | ((prev: Project) => Project)) => void;
  undoButton?: React.ReactNode;
}

export default function Additive({ project, onProjectChange, undoButton }: Props) {
  const state = useAdditiveState(project, { onProjectChange });
  const actions = useAdditiveActions({ project, onProjectChange, state });
  const { banks, filteredComps, groupTree, orphanRows, hasEapLink } = useAdditiveGroups(
    project, state.active, state.search, state.bankFilter,
  );

  const {
    additives, active, status, isLocked, bdi, globalDiscount,
    showAnalytic, setShowAnalytic, expanded, expandedMemory, collapsed,
    importDialogOpen, setImportDialogOpen, importName, setImportName,
    setPendingFile, fileRef,
    issuesOpen, setIssuesOpen,
    confirmDeleteId, setConfirmDeleteId,
    reviewDialogOpen, setReviewDialogOpen,
    reviewNotes, setReviewNotes, approvedBy, setApprovedBy,
    historyOpen, setHistoryOpen,
    setActiveId, search, setSearch, bankFilter, setBankFilter,
    toggleExpand, toggleExpandMemory, toggleCollapsed, collapseAllGroups, expandAllGroups,
  } = state;

  const totals = useMemo(() => (active ? additiveTotals(active, project) : null), [active, project]);

  const openReview = (preset: 'approve' | 'reject') => {
    if (preset === 'approve') {
      setApprovedBy('');
    }
    setReviewNotes('');
    setReviewDialogOpen(true);
  };

  return (
    <div className="p-4 lg:p-6 space-y-4 max-w-[1700px] mx-auto">
      <AdditiveHeader
        project={project}
        active={active}
        status={status}
        bdi={bdi}
        globalDiscount={globalDiscount}
        isLocked={isLocked}
        fileRef={fileRef}
        undoButton={undoButton}
        onChangeBdi={actions.handleChangeBdi}
        onChangeGlobalDiscount={actions.handleChangeGlobalDiscount}
        onFileSelected={actions.handleFileSelected}
        onUseSynthetic={actions.handleUseSyntheticFromMeasurement}
        onContract={actions.handleContractAdditive}
        onExportExcel={actions.handleExportExcel}
        onExportSyntheticComplete={actions.handleExportSyntheticCompleteExcel}
        onExportNewServices={actions.handleExportNewServicesExcel}
        onExportCalculationMemory={actions.handleExportCalculationMemoryExcel}
        onExportPdf={() => actions.handleExportPdf(showAnalytic)}
        onExportSyntheticCompletePdf={actions.handleExportSyntheticCompletePdf}
        onExportNewServicesPdf={actions.handleExportNewServicesPdf}
        onExportCalculationMemoryPdf={actions.handleExportCalculationMemoryPdf}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      <AdditiveTabs
        additives={additives}
        active={active}
        onSelect={setActiveId}
        onRequestDelete={setConfirmDeleteId}
        onOpenIssues={() => setIssuesOpen(true)}
      />

      {!active && (
        <Card className="p-10 text-center border-dashed">
          <p className="text-muted-foreground mb-4">
            Nenhum aditivo importado ainda. Importe uma planilha Excel contendo a aba
            <strong> Sintética</strong>, a aba <strong>Analítica</strong>, ou ambas.
            <br />
            <span className="text-xs">Você pode importar a Sintética primeiro e a Analítica depois — o sistema vincula os insumos automaticamente.</span>
          </p>
          <Button onClick={() => fileRef.current?.click()}>
            <Upload className="w-4 h-4 mr-2" /> Importar planilha
          </Button>
        </Card>
      )}

      {active && totals && (
        <>
          <AdditiveApprovalBanner
            status={status}
            onSend={actions.handleSendForReview}
            onOpenReview={openReview}
            onBackToDraft={actions.handleBackToDraft}
          />

          <AdditiveHeaderInfo
            project={project}
            active={active}
            bdi={bdi}
            globalDiscount={globalDiscount}
            isLocked={isLocked}
            onProjectChange={onProjectChange}
            onChangeBdi={actions.handleChangeBdi}
            onChangeGlobalDiscount={actions.handleChangeGlobalDiscount}
            onUpdateAdditive={actions.updateAdditive}
          />

          <AdditiveSummaryCards totals={totals} />

          <AdditiveFilters
            search={search}
            setSearch={setSearch}
            bankFilter={bankFilter}
            setBankFilter={setBankFilter}
            banks={banks}
            showAnalytic={showAnalytic}
            toggleAnalytic={() => setShowAnalytic(s => !s)}
            onCollapseAll={() => collapseAllGroups((groupTree ?? []).flatMap(function gather(g): string[] { return [g.phaseId, ...g.children.flatMap(gather)]; }))}
            onExpandAll={expandAllGroups}
          />

          <AdditiveTable
            bdi={bdi}
            globalDiscount={globalDiscount}
            isLocked={isLocked}
            showAnalytic={showAnalytic}
            expanded={expanded}
            expandedMemory={expandedMemory}
            collapsed={collapsed}
            filteredComps={filteredComps}
            groupTree={groupTree}
            orphanRows={orphanRows}
            hasEapLink={hasEapLink}
            onToggleExpand={toggleExpand}
            onToggleMemory={toggleExpandMemory}
            onToggleCollapsed={toggleCollapsed}
            onUpdateComposition={actions.updateComposition}
            onUpdateQuantity={actions.updateCompositionQuantity}
            onRemoveComposition={actions.handleRemoveComposition}
            onAddNewService={actions.handleAddNewService}
            onChangeMemory={actions.setCalculationMemory}
          />

          <AdditiveTotalsBlock
            active={active}
            totals={totals}
            isLocked={isLocked}
            onChangeLimit={v => actions.updateAdditive(a => ({ ...a, aditivoLimitPercent: v }))}
          />
        </>
      )}

      <AdditiveImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        importName={importName}
        setImportName={setImportName}
        onConfirm={actions.handleConfirmImport}
        onCancel={() => { setImportDialogOpen(false); setPendingFile(null); }}
      />

      <AdditiveReviewDialog
        open={reviewDialogOpen}
        onOpenChange={setReviewDialogOpen}
        approvedBy={approvedBy}
        setApprovedBy={setApprovedBy}
        reviewNotes={reviewNotes}
        setReviewNotes={setReviewNotes}
        onApprove={actions.handleApprove}
        onReject={actions.handleReject}
      />

      <AdditiveIssuesDialog
        open={issuesOpen}
        onOpenChange={setIssuesOpen}
        active={active}
      />

      <AdditiveSyntheticConflictDialog
        open={actions.syntheticConflict.open}
        onOpenChange={actions.syntheticConflict.setOpen}
        blocked={actions.syntheticConflict.blocked}
        onCancel={actions.syntheticConflict.onCancel}
        onCreateNew={actions.syntheticConflict.onCreateNew}
        onMergePreserving={actions.syntheticConflict.onMergePreserving}
      />

      <AlertDialog open={!!confirmDeleteId} onOpenChange={o => !o && setConfirmDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir aditivo?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. As composições e insumos deste aditivo serão removidos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmDeleteId && actions.handleDeleteAdditive(confirmDeleteId)}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {active && (
        <AuditHistoryPanel
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          project={project}
          entityType="additive"
          entityId={active.id}
          title={active.name}
        />
      )}
    </div>
  );
}
