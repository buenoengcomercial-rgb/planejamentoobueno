import type { Project } from '@/types/project';
import type { JornadaConfig } from '@/lib/calculations';
import { flattenTaskTree, replaceProjectTasksById } from '@/lib/taskTree';
import { contractAdditive } from '@/lib/additiveImport';

/** Formaliza o aditivo mantendo a EAP e os quantitativos do contrato-base.
 * Persiste as datas aprovadas nas tarefas-base e mantém os novos serviços no arquivo do aditivo. */
export function contractAdditiveKeepingBase(project: Project, additiveId: string, user?: string, jornadaConfig?: JornadaConfig): Project {
  const contracted = contractAdditive(project, additiveId, user, jornadaConfig);
  const originalBudget = (project.budgetItems ?? []).filter(item => item.source !== 'aditivo');
  const additiveBudget = (contracted.budgetItems ?? []).filter(item => item.source === 'aditivo');
  const plannedIds = new Set(project.additives?.find(additive => additive.id === additiveId)
    ?.scheduleDraft?.contractedTaskPlans?.map(plan => plan.taskId));
  const approvedTasks = new Map(flattenTaskTree(contracted.phases.flatMap(phase => phase.tasks))
    .filter(task => plannedIds.has(task.id)).map(task => [task.id, task]));
  const scheduleChanges = new Map(flattenTaskTree(project.phases.flatMap(phase => phase.tasks)).flatMap(task => {
    const approved = approvedTasks.get(task.id);
    if (!approved) return [];
    const { startDate, duration, dependencies, dependencyDetails, responsible, team, scheduleOrder,
      durationMode, isManual, manualDuration, calculatedDuration } = approved;
    return [[task.id, { ...task, startDate, duration, dependencies, dependencyDetails, responsible,
      team, scheduleOrder, durationMode, isManual, manualDuration, calculatedDuration }] as const];
  }));
  return {
    ...contracted,
    phases: scheduleChanges.size ? replaceProjectTasksById(project, scheduleChanges).phases : project.phases,
    budgetItems: [...originalBudget, ...additiveBudget],
  };
}
