import { buildPhysicalFinancialSchedule, measurementValuesByMonth, type MonthlyAllocations } from '@/lib/physicalFinancialSchedule';
import MonthlyPortionEditor from './gantt/MonthlyPortionEditor';
import { getAllTasks } from '@/data/sampleProject';
import { replaceProjectTasksById } from '@/lib/taskTree';
import { settleReleaseProject } from '@/lib/scheduleReleaseMath';
import { applyExecutionRevision, includeReleaseMilestones } from '@/lib/scheduleExecutionRevision';
import { includeMeasuredSchedule, stripMeasuredSchedule } from '@/lib/measuredSchedule';
import type { MeasurementWorkspace } from '@/lib/measurementWorkspace';
import { includeClosingSchedule, calculateClosingCPM } from '@/lib/closingSchedule';
import { calculateProjectSchedule } from '@/domains/schedule/useCalculatedProject';
import { applyProjectedProjectOperation } from '@/lib/projectOperations';
import { useCallback, useMemo, useState, type ComponentProps } from 'react';
import { applySchedulePlanImport, parseSchedulePlanImport, type SchedulePlanImport } from '@/lib/schedulePlanImport';

import { buildOfficialAdditiveSuspensionMap, buildOperationalProjectFromPendingAdditives, getPendingAdditiveScheduleControls } from '@/lib/additiveSchedule';
import { mergeOperationalProjectIntoRaw } from '@/lib/operationalProject';
import type { Additive, Project } from '@/types/project';
import { captureContractedTaskSchedules, includeContractedAdditiveTasks } from '@/lib/contractedAdditiveSchedule';
import GanttChart from './GanttChart';
import GanttFinancialForecast from './gantt/GanttFinancialForecast';

type ProjectUpdate = Project | ((previous: Project) => Project);
type Props = Omit<ComponentProps<typeof GanttChart>, 'project' | 'onProjectChange' | 'lockedTaskLabels' | 'displayOnlyTaskIds' | 'contractedQuantityAdjustments'> & {
  project: Project;
  monthlyPresentation?: boolean;
  onSaveMonthly?: (id: string, allocations: MonthlyAllocations | null) => void;
  confirmedAdditives?: readonly Additive[];
  confirmedMeasurement?: MeasurementWorkspace | null;
  onProjectChange: (next: ProjectUpdate) => void;
};

const NO_ADDITIVES: readonly Additive[] = [];

export default function OperationalGanttChart({ project, confirmedAdditives = NO_ADDITIVES, confirmedMeasurement, onProjectChange, monthlyPresentation, onSaveMonthly, ...props }: Props) {
  const [editMonthlyId, setEditMonthlyId] = useState<string>();
  const [importPlan, setImportPlan] = useState<SchedulePlanImport | null>(null);
  const [importError, setImportError] = useState('');
  const operationalProject = useMemo(() => buildOperationalProjectFromPendingAdditives(project), [project]);
  const display = useMemo(() => includeContractedAdditiveTasks(operationalProject, confirmedAdditives), [operationalProject, confirmedAdditives]);
  const closing = useMemo(() => includeClosingSchedule(display.project), [display.project]);
  const measured = useMemo(() => includeMeasuredSchedule(closing.project, confirmedMeasurement, confirmedAdditives, display.quantityAdjustments), [closing.project, confirmedMeasurement, confirmedAdditives, display.quantityAdjustments]);
  const monthly = useMemo(() => monthlyPresentation ? buildPhysicalFinancialSchedule(operationalProject, confirmedMeasurement ?? null, confirmedAdditives) : undefined,
    [monthlyPresentation, operationalProject, confirmedMeasurement, confirmedAdditives]);
  const fiscalTotals = useMemo(() => monthlyPresentation ? measurementValuesByMonth(confirmedMeasurement ?? null) : undefined,
    [monthlyPresentation, confirmedMeasurement]);
  const monthlyRows = useMemo(() => monthly ? new Map(monthly.rows.map(row => [row.id, row])) : undefined, [monthly]);
  const selectedMonthly = editMonthlyId ? monthlyRows?.get(editMonthlyId) : undefined;
  const ganttProject = useMemo(() => {
    const projected = includeReleaseMilestones(measured.project);
    const revised = projected.phases.some(p => p.tasks.some(t => t.operationalReschedule?.executionRevision));
    const settled = calculateClosingCPM(revised ? settleReleaseProject(projected) : projected);
    if (!monthlyRows) return settled;
    const replacements = new Map(getAllTasks(settled).flatMap(task => {
      const row = monthlyRows.get(task.id);
      if (!row) return [];
      const totalMeasured = Object.values(row.measured).reduce((sum, cell) => sum + cell.quantity, 0);
      const completion = row.quantity > 0 && totalMeasured > 0
        ? Math.min(100, Math.max(totalMeasured / row.quantity * 100, task.physicalProgress ?? task.percentComplete))
        : task.physicalProgress ?? task.percentComplete;
      return [[task.id, { ...task, name: row.name,
        scheduleDisplayKind: task.scheduleDisplayKind === 'completed-summary' ? undefined : task.scheduleDisplayKind,
        percentComplete: completion,
        physicalProgress: completion,
      }] as const];
    }));
    return replaceProjectTasksById({ ...settled, phases: settled.phases.map(phase => ({
      ...phase, tasks: phase.tasks.filter(task => task.scheduleDisplayKind !== 'history'),
    })) }, replacements);
  }, [measured.project, monthlyRows]);
  const suspensionMap = useMemo(() => buildOfficialAdditiveSuspensionMap(display.project), [display.project]);
  const lockedTaskLabels = useMemo(() => Object.fromEntries([
    ...Array.from(getPendingAdditiveScheduleControls(project), ([taskId, control]) => [taskId, control.additiveName]),
  ]), [project]);
  const updateOperationalProject = useCallback((next: ProjectUpdate) => {
    onProjectChange(previous => {
      const previousOperational = buildOperationalProjectFromPendingAdditives(calculateProjectSchedule(previous, true));
      const currentDisplay = includeContractedAdditiveTasks(previousOperational, confirmedAdditives).project;
      const nextOperational = stripMeasuredSchedule(display.project, typeof next === 'function' ? next(currentDisplay) : next, measured.lockedIds);
      const planned = captureContractedTaskSchedules(display.project, display.project, nextOperational,
        confirmedAdditives, display.projectedTaskIds);
      return applyProjectedProjectOperation('gantt', previous, currentDisplay,
        mergeOperationalProjectIntoRaw(previous, display.project),
        mergeOperationalProjectIntoRaw(previous, planned));
    });
  }, [confirmedAdditives, display, measured.lockedIds, onProjectChange]);

  const reviseExecution = () => {
    if (!confirmedMeasurement) return;
    try {
      if (Object.keys(lockedTaskLabels).length) throw Error('Concilie os controles pendentes do aditivo antes da revisão.');
      onProjectChange(previous => {
        const operational = buildOperationalProjectFromPendingAdditives(calculateProjectSchedule(previous, true));
        const current = includeContractedAdditiveTasks(operational, confirmedAdditives);
        const revised = applyExecutionRevision(current.project, confirmedMeasurement, confirmedAdditives, props.auditActor ?? {}, current.quantityAdjustments);
        const captured = captureContractedTaskSchedules(current.project, current.project, revised, confirmedAdditives, current.projectedTaskIds);
        return applyProjectedProjectOperation('gantt', previous, current.project, mergeOperationalProjectIntoRaw(previous, current.project), mergeOperationalProjectIntoRaw(previous, captured));
      });
    } catch (error) { setImportError(error instanceof Error ? error.message : 'Não foi possível revisar o cronograma.'); }
  };

  return (
    <>
    {!props.readOnly && props.canManageCalendar && confirmedMeasurement && <button className="rounded border px-3 py-2 mb-2 text-sm" disabled={display.project.phases.some(p => p.tasks.some(t => t.operationalReschedule?.executionRevision))} onClick={reviseExecution}>Aplicar revisão do executado e limite de duas predecessoras</button>}
    {!props.readOnly && props.canManageCalendar && <details className="rounded border p-3 mb-3 text-sm">
      <summary className="cursor-pointer">Importar programação revisada</summary>
      <p className="my-2">Confira o arquivo antes de aplicar. Datas, equipes e vínculos serão atualizados; execução e valores contratuais serão preservados.</p>
      <label>Arquivo da programação
        <input type="file" accept=".json,application/json" className="block my-2" onChange={async event => {
          const file = event.target.files?.[0];
          setImportPlan(null); setImportError('');
          if (!file) return;
          try {
            if (file.size > 5_000_000) throw new Error('Arquivo maior que 5 MB.');
            const plan = parseSchedulePlanImport(JSON.parse(await file.text()));
            applySchedulePlanImport(display.project, plan, props.auditActor ?? {}, new Set([...Object.keys(lockedTaskLabels), ...measured.lockedIds]), confirmedAdditives);
            setImportPlan(plan);
          } catch (error) { setImportError(error instanceof Error ? error.message : 'Arquivo inválido.'); }
        }} />
      </label>
      {importPlan && <div>
        <p>{importPlan.name} · {importPlan.tasks.length} atividades · {importPlan.teams.length} novas equipes propostas.</p>
        <p>Calendário: {importPlan.calendar.municipio}/{importPlan.calendar.uf}, {importPlan.calendar.jornadaDiaria} h/dia, {importPlan.calendar.trabalhaSabado ? 'com sábado' : 'segunda a sexta'}.</p>
        <button className="rounded bg-primary text-primary-foreground px-3 py-2 mt-2" onClick={() => {
          try {
            const next = applySchedulePlanImport(display.project, importPlan, props.auditActor ?? {}, new Set([...Object.keys(lockedTaskLabels), ...measured.lockedIds]), confirmedAdditives);
            updateOperationalProject(next); setImportPlan(null); setImportError('');
          } catch (error) { setImportError(error instanceof Error ? error.message : 'Não foi possível aplicar a programação.'); }
        }}>Aplicar programação ({importPlan.tasks.length} atividades)</button>
      </div>}
      {importError && <p role="alert" className="mt-2 text-destructive">{importError}</p>}
    </details>}
    {!monthlyPresentation && measured.measuredCount > 0 && <p className="my-2 text-sm">{measured.measuredCount} serviços com execução nas medições 1–2. Executado identificado no próprio subcapítulo, com datas comprovadas ou referência convencionada em 15/09 e 15/10/2026. Somente o saldo permanece no planejamento futuro.</p>}
    {closing.taskIds.size > 0 && <p className="my-2 text-sm">Fechamento incluído no caminho crítico até {getDeadline(display.project)}. Folgas em dias úteis, considerando as datas liberadas e os vínculos. Etapas operacionais sem quantidade ou valor contratual.</p>}
    {selectedMonthly && monthly && onSaveMonthly && <MonthlyPortionEditor key={selectedMonthly.id} row={selectedMonthly} months={monthly.months}
      onSave={onSaveMonthly} onClose={() => setEditMonthlyId(undefined)} />}
    <GanttChart
      {...props}
      project={ganttProject}
      contractedQuantityAdjustments={display.quantityAdjustments}
      monthlyRows={monthlyRows}
      measurementValues={fiscalTotals}
      onEditMonthly={onSaveMonthly ? setEditMonthlyId : undefined}
      onProjectChange={updateOperationalProject}
      displayOnlyTaskIds={new Set([...measured.lockedIds].filter(id => id.startsWith('measured:')))}
      lockedTaskLabels={{ ...lockedTaskLabels, ...Object.fromEntries([...measured.lockedIds].map(id => [id, 'Execução registrada nas medições 1–2 — somente consulta'])), ...Object.fromEntries(ganttProject.phases.flatMap(p => p.tasks).filter(t => t.scheduleDisplayKind === 'release').map(t => [t.id, 'Marco de liberação — atualizar pela revisão do cronograma'])), ...Object.fromEntries(getAllTasks(ganttProject).filter(task => task.operationalReschedule?.monthlySegments?.length).map(task => [task.id, 'Edite as datas pela programação de parcelas mensais'])), ...Object.fromEntries([...closing.taskIds].map(id => [id, 'Etapa operacional de fechamento — atualizar pela programação revisada'])) }}
      suspensionMap={props.suspensionMap ?? suspensionMap}
      financialForecastNode={props.financialForecastNode === undefined && display.projectedTaskIds.size > 0
        ? <GanttFinancialForecast project={operationalProject} trabalhaSabado={props.calendarConfig?.trabalhaSabado} />
        : props.financialForecastNode}
    />
    </>
  );
}

function getDeadline(project: Project) {
  return project.phases.flatMap(p => p.tasks).find(t => t.operationalReschedule?.closingDeadline)?.operationalReschedule?.closingDeadline?.split('-').reverse().join('/');
}
