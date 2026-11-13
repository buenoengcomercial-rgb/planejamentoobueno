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
type Props = Omit<ComponentProps<typeof GanttChart>, 'project' | 'onProjectChange' | 'lockedTaskLabels' | 'displayOnlyTaskIds'> & {
  project: Project;
  confirmedAdditives?: readonly Additive[];
  onProjectChange: (next: ProjectUpdate) => void;
};

const NO_ADDITIVES: readonly Additive[] = [];

export default function OperationalGanttChart({ project, confirmedAdditives = NO_ADDITIVES, onProjectChange, ...props }: Props) {
  const [importPlan, setImportPlan] = useState<SchedulePlanImport | null>(null);
  const [importError, setImportError] = useState('');
  const operationalProject = useMemo(() => buildOperationalProjectFromPendingAdditives(project), [project]);
  const display = useMemo(() => includeContractedAdditiveTasks(operationalProject, confirmedAdditives), [operationalProject, confirmedAdditives]);
  const suspensionMap = useMemo(() => buildOfficialAdditiveSuspensionMap(display.project), [display.project]);
  const lockedTaskLabels = useMemo(() => Object.fromEntries([
    ...Array.from(getPendingAdditiveScheduleControls(project), ([taskId, control]) => [taskId, control.additiveName]),
  ]), [project]);
  const updateOperationalProject = useCallback((next: ProjectUpdate) => {
    onProjectChange(previous => {
      const previousOperational = buildOperationalProjectFromPendingAdditives(calculateProjectSchedule(previous, true));
      const currentDisplay = includeContractedAdditiveTasks(previousOperational, confirmedAdditives).project;
      const nextOperational = typeof next === 'function' ? next(currentDisplay) : next;
      const planned = captureContractedTaskSchedules(display.project, display.project, nextOperational,
        confirmedAdditives, display.projectedTaskIds);
      return applyProjectedProjectOperation('gantt', previous, currentDisplay,
        mergeOperationalProjectIntoRaw(previous, display.project),
        mergeOperationalProjectIntoRaw(previous, planned));
    });
  }, [confirmedAdditives, display, onProjectChange]);

  return (
    <>
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
            applySchedulePlanImport(display.project, plan, props.auditActor ?? {}, new Set(Object.keys(lockedTaskLabels)), confirmedAdditives);
            setImportPlan(plan);
          } catch (error) { setImportError(error instanceof Error ? error.message : 'Arquivo inválido.'); }
        }} />
      </label>
      {importPlan && <div>
        <p>{importPlan.name} · {importPlan.tasks.length} atividades · {importPlan.teams.length} novas equipes propostas.</p>
        <p>Calendário: {importPlan.calendar.municipio}/{importPlan.calendar.uf}, {importPlan.calendar.jornadaDiaria} h/dia, {importPlan.calendar.trabalhaSabado ? 'com sábado' : 'segunda a sexta'}.</p>
        <button className="rounded bg-primary text-primary-foreground px-3 py-2 mt-2" onClick={() => {
          try {
            const next = applySchedulePlanImport(display.project, importPlan, props.auditActor ?? {}, new Set(Object.keys(lockedTaskLabels)), confirmedAdditives);
            updateOperationalProject(next); setImportPlan(null); setImportError('');
          } catch (error) { setImportError(error instanceof Error ? error.message : 'Não foi possível aplicar a programação.'); }
        }}>Aplicar programação ({importPlan.tasks.length} atividades)</button>
      </div>}
      {importError && <p role="alert" className="mt-2 text-destructive">{importError}</p>}
    </details>}
    <GanttChart
      {...props}
      project={display.project}
      onProjectChange={updateOperationalProject}
      lockedTaskLabels={lockedTaskLabels}
      suspensionMap={props.suspensionMap ?? suspensionMap}
      financialForecastNode={props.financialForecastNode === undefined && display.projectedTaskIds.size > 0
        ? <GanttFinancialForecast project={operationalProject} trabalhaSabado={props.calendarConfig?.trabalhaSabado} />
        : props.financialForecastNode}
    />
    </>
  );
}
