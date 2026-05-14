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


export default function DailyReport({ project, onProjectChange, undoButton, initialDate, initialMeasurementFilter, navKey }: DailyReportProps) {
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
    <div className="p-4 lg:p-6 space-y-4 max-w-[1400px] mx-auto">
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

      {/* Vínculo com Medição */}
      <DailyReportMeasurementBanner dateMembership={dateMembership} />

      {/* Diários por Medição (quando há período selecionado) */}
      {activePeriod && periodSummary && (
        <PeriodReportsSection
          period={activePeriod}
          summary={periodSummary}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
        />
      )}

      {/* Resumo */}
      <DailyReportSummaryCards summary={summary} />

      {/* Informações gerais */}
      <DailyReportGeneralInfo currentReport={currentReport} updateField={updateField} onClearDay={clearDailyReport} />

      {/* Equipes / Equipamentos lado a lado */}
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

      {/* Textos longos */}
      <DailyReportTextAreas currentReport={currentReport} updateField={updateField} />

      {/* Fotos da Obra */}
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

      {/* Produção do dia */}
      <DailyReportProductionSection
        selectedDate={selectedDate}
        grouped={grouped}
        photosByTask={photosByTask}
        setPhotoFilter={setPhotoFilter}
      />

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
