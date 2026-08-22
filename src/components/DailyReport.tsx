import { useDailyReportState } from '@/hooks/useDailyReportState';
import { useDailyReportPeriods } from '@/hooks/useDailyReportPeriods';
import { useDailyReportProduction } from '@/hooks/useDailyReportProduction';
import { useDailyReportTeams } from '@/hooks/useDailyReportTeams';
import { useDailyReportEquipment } from '@/hooks/useDailyReportEquipment';
import { useDailyReportPhotos } from '@/hooks/useDailyReportPhotos';
import { useDailyReportPdf } from '@/hooks/useDailyReportPdf';

import type { DailyReportProps } from '@/components/dailyReport/types';
import { DailyReportHeader } from '@/components/dailyReport/DailyReportHeader';
import { DailyReportMeasurementBanner } from '@/components/dailyReport/DailyReportMeasurementBanner';
import { DailyReportSummaryCards } from '@/components/dailyReport/DailyReportSummaryCards';
import { DailyReportGeneralInfo } from '@/components/dailyReport/DailyReportGeneralInfo';
import { DailyReportTextAreas } from '@/components/dailyReport/DailyReportTextAreas';
import { DailyReportTeamsCard } from '@/components/dailyReport/DailyReportTeamsCard';
import { DailyReportEquipmentCard } from '@/components/dailyReport/DailyReportEquipmentCard';
import { DailyReportPhotosCard } from '@/components/dailyReport/DailyReportPhotosCard';
import { DailyReportPhotoLightbox } from '@/components/dailyReport/DailyReportPhotoLightbox';
import { DailyReportPhotoDeleteDialog } from '@/components/dailyReport/DailyReportPhotoDeleteDialog';
import { DailyReportProductionSection } from '@/components/dailyReport/DailyReportProductionSection';
import { PeriodReportsSection } from '@/components/dailyReport/PeriodReportsSection';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { CalendarDays, CheckCircle2, History, LockKeyhole, LockKeyholeOpen } from 'lucide-react';
import { useState } from 'react';


export default function DailyReport({ project, onProjectChange, undoButton, readOnly = false, canManageConclusion = false, initialDate, initialMeasurementFilter, navKey }: DailyReportProps) {
  const [activeView, setActiveView] = useState<'day' | 'history'>('day');
  const [completionDialog, setCompletionDialog] = useState<'conclude' | 'reopen' | null>(null);
  const {
    selectedDate,
    setSelectedDate,
    measurementFilter,
    setMeasurementFilter,
    currentReport,
    persist,
    updateField,
    clearDailyReport,
    concludeDailyReport,
    reopenDailyReport,
  } = useDailyReportState({ project, onProjectChange, initialDate, initialMeasurementFilter, navKey });

  const concluded = !!currentReport.concludedAt;
  const effectiveReadOnly = readOnly || concluded;

  const { measurementPeriods, activePeriod, periodDates, dateMembership, periodSummary } =
    useDailyReportPeriods({ project, selectedDate, measurementFilter });

  const { production, grouped, summary } = useDailyReportProduction({
    project,
    selectedDate,
    currentReport,
  });

  const {
    projectTeams,
    teamByCode,
    teamDisplay,
    suggestedTeamCodes,
    addTeamRow,
    updateTeamRow,
    removeTeamRow,
    addSuggestedTeams,
  } = useDailyReportTeams({ project, production, persist });

  const { addEqRow, updateEqRow, removeEqRow } = useDailyReportEquipment({ persist });

  // ───── Fotos / Anexos ─────
  const {
    pendingTaskId,
    setPendingTaskId,
    photoFilter,
    setPhotoFilter,
    uploadingCount,
    lightbox,
    setLightbox,
    confirmDelete,
    setConfirmDelete,
    fileInputRef,
    photos,
    photosByTask,
    visiblePhotos,
    photoTaskOptions,
    handleFiles,
    updatePhoto,
    removePhoto,
  } = useDailyReportPhotos({ project, currentReport, persist, production, selectedDate });

  const { handlePrintDay, handlePrintPeriod } = useDailyReportPdf({
    project,
    selectedDate,
    currentReport,
    activePeriod,
    periodDates,
    periodSummary,
    production,
    grouped,
    summary,
    photos,
    photosByTask,
    teamByCode,
    teamDisplay,
    dateMembership,
    measurementFilter,
  });

  return (
    <div className="p-0 space-y-4 max-w-[1680px] mx-auto">
      {/* Header */}
      <DailyReportHeader
        undoButton={undoButton}
        measurementFilter={measurementFilter}
        setMeasurementFilter={setMeasurementFilter}
        measurementPeriods={measurementPeriods}
        activePeriod={activePeriod}
        periodDates={periodDates}
        selectedDate={selectedDate}
        setSelectedDate={setSelectedDate}
        handlePrintDay={handlePrintDay}
        handlePrintPeriod={handlePrintPeriod}
      />

      {concluded ? (
        <div role="status" className="flex flex-col gap-3 rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2 text-foreground">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <div>
              <p className="font-semibold">Diário concluído</p>
              <p className="text-xs text-muted-foreground">Concluído em {new Date(currentReport.concludedAt!).toLocaleString('pt-BR')}. O conteúdo está protegido contra edições.</p>
            </div>
          </div>
          {canManageConclusion && (
            <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => setCompletionDialog('reopen')}>
              <LockKeyholeOpen className="mr-2 h-4 w-4" /> Reabrir para edição
            </Button>
          )}
        </div>
      ) : !readOnly ? (
        <div className="flex justify-end">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => setCompletionDialog('conclude')}>
            <LockKeyhole className="mr-2 h-4 w-4" /> Concluir diário
          </Button>
        </div>
      ) : null}

      <Tabs value={activeView} onValueChange={value => setActiveView(value as 'day' | 'history')}>
        <TabsList className="h-11 w-full justify-start sm:w-auto">
          <TabsTrigger value="day" className="min-h-10 gap-2 px-4 text-sm"><CalendarDays className="h-4 w-4" /> Registro do dia</TabsTrigger>
          <TabsTrigger value="history" className="min-h-10 gap-2 px-4 text-sm"><History className="h-4 w-4" /> Histórico da medição</TabsTrigger>
        </TabsList>

        <TabsContent value="history" className="mt-4">
          {activePeriod && periodSummary ? (
            <PeriodReportsSection
              period={activePeriod}
              summary={periodSummary}
              selectedDate={selectedDate}
              onSelectDate={date => {
                setSelectedDate(date);
                setActiveView('day');
              }}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              Selecione uma medição para consultar o histórico de Diários.
            </div>
          )}
        </TabsContent>

        <TabsContent value="day" className="mt-4 space-y-4">
          <DailyReportMeasurementBanner dateMembership={dateMembership} />

          <DailyReportSummaryCards summary={summary} />

          {readOnly && !concluded && (
            <div role="status" className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              Este perfil pode consultar e imprimir o Diário, mas não pode alterar os registros.
            </div>
          )}

          <fieldset disabled={effectiveReadOnly} className="space-y-4 disabled:opacity-80">

          <DailyReportGeneralInfo
            currentReport={currentReport}
            updateField={updateField}
            onClearDay={clearDailyReport}
            hasProduction={production.some(item => item.actualQuantity > 0)}
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DailyReportTeamsCard
          currentReport={currentReport}
          projectTeams={projectTeams}
          teamByCode={teamByCode}
          teamDisplay={teamDisplay}
          suggestedTeamCodes={suggestedTeamCodes}
          addTeamRow={addTeamRow}
          updateTeamRow={updateTeamRow}
          removeTeamRow={removeTeamRow}
          addSuggestedTeams={addSuggestedTeams}
        />
        <DailyReportEquipmentCard
          currentReport={currentReport}
          addEqRow={addEqRow}
          updateEqRow={updateEqRow}
          removeEqRow={removeEqRow}
        />
          </div>

          <DailyReportTextAreas currentReport={currentReport} updateField={updateField} />

          <DailyReportPhotosCard
        photos={photos}
        visiblePhotos={visiblePhotos}
        photosByTask={photosByTask}
        photoTaskOptions={photoTaskOptions}
        pendingTaskId={pendingTaskId}
        setPendingTaskId={setPendingTaskId}
        photoFilter={photoFilter}
        setPhotoFilter={setPhotoFilter}
        uploadingCount={uploadingCount}
        fileInputRef={fileInputRef}
        handleFiles={handleFiles}
        updatePhoto={updatePhoto}
        setLightbox={setLightbox}
        setConfirmDelete={setConfirmDelete}
          />

          <DailyReportProductionSection
        selectedDate={selectedDate}
        grouped={grouped}
        photosByTask={photosByTask}
        setPhotoFilter={setPhotoFilter}
          />
          </fieldset>
        </TabsContent>
      </Tabs>

      {/* Lightbox */}
      <DailyReportPhotoLightbox lightbox={lightbox} setLightbox={setLightbox} />

      {/* Confirmação de remoção */}
      <DailyReportPhotoDeleteDialog
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        removePhoto={removePhoto}
      />

      <AlertDialog open={!!completionDialog} onOpenChange={open => !open && setCompletionDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{completionDialog === 'conclude' ? 'Concluir Diário de Obra?' : 'Reabrir Diário para edição?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {completionDialog === 'conclude'
                ? 'Após a conclusão, o Diário ficará somente para consulta. Apenas o Proprietário poderá reabri-lo, e a ação ficará registrada no histórico.'
                : 'O Diário voltará a aceitar alterações. Esta reabertura será registrada no histórico do documento.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className={completionDialog === 'conclude' ? 'bg-primary text-primary-foreground hover:bg-primary/90' : undefined}
              onClick={() => {
                if (completionDialog === 'conclude') concludeDailyReport();
                if (completionDialog === 'reopen') reopenDailyReport();
                setCompletionDialog(null);
              }}
            >
              {completionDialog === 'conclude' ? 'Concluir Diário' : 'Reabrir para edição'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
