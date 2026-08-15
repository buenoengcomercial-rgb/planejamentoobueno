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
import { CalendarDays, History } from 'lucide-react';
import { useState } from 'react';


export default function DailyReport({ project, onProjectChange, undoButton, readOnly = false, initialDate, initialMeasurementFilter, navKey }: DailyReportProps) {
  const [activeView, setActiveView] = useState<'day' | 'history'>('day');
  const {
    selectedDate,
    setSelectedDate,
    measurementFilter,
    setMeasurementFilter,
    currentReport,
    persist,
    updateField,
    clearDailyReport,
  } = useDailyReportState({ project, onProjectChange, initialDate, initialMeasurementFilter, navKey });

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

          {readOnly && (
            <div role="status" className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              Este perfil pode consultar e imprimir o Diário, mas não pode alterar os registros.
            </div>
          )}

          <fieldset disabled={readOnly} className="space-y-4 disabled:opacity-80">

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
    </div>
  );
}
