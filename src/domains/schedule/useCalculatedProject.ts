import { useMemo } from 'react';
import type { Project } from '@/types/project';
import {
  applyDailyLogsToProject,
  applyRupToProject,
  calculateCPM,
  captureBaseline,
  settleAllDependencies,
  syncBaselineWithRup,
} from '@/lib/calculations';
import { resolveObraConfig } from '@/lib/obraConfig';

/** Calculations own the schedule. Changes to another domain keep its latest data
 * in the returned project without rebuilding every task and its dependency graph. */
export function useCalculatedProject(rawProject: Project | null, settleDependencies: boolean): Project | null {
  const phases = rawProject?.phases;
  const scheduleCalendar = rawProject?.scheduleCalendar;
  const calculatedPhases = useMemo(() => {
    if (!rawProject) return null;
    const scheduleInput = { ...rawProject, phases: phases ?? [] };
    const enriched = applyDailyLogsToProject(
      syncBaselineWithRup(applyRupToProject(captureBaseline(scheduleInput))),
    );
    if (settleDependencies) {
      const cfg = resolveObraConfig({ scheduleCalendar });
      const cal = {
        uf: cfg.uf,
        municipio: cfg.municipio,
        trabalhaSabado: cfg.trabalhaSabado,
        jornadaDiaria: cfg.jornadaDiaria,
        exceptions: cfg.exceptions,
      };
      return calculateCPM(settleAllDependencies(enriched, cal)).phases;
    }
    return calculateCPM(enriched).phases;
    // Only the schedule's inputs may invalidate this calculation. All other
    // project fields are passed through below without entering the task graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phases, scheduleCalendar, settleDependencies]);

  return useMemo(() => rawProject && calculatedPhases
    ? { ...rawProject, phases: calculatedPhases }
    : rawProject, [rawProject, calculatedPhases]);
}
