import type { Additive, AdditiveComposition, ContractedTaskSchedule, Project, Task } from '@/types/project';
import { computeAdditiveRow, resolveAdditivePricingRule } from '@/lib/additiveImport';
import { executionMonth } from '@/lib/monthlyExecution';
import { sortTasksForSchedule } from '@/lib/taskOrdering';
import { flattenTaskTree } from '@/lib/taskTree';

export function isContractedAdditive(additive: Additive) {
  return !!additive.isContracted || additive.status === 'aditivo_contratado' || additive.status === 'contratado';
}

export function approvedAdditiveSnapshot(additive: Additive) {
  const version = additive.version ?? 0;
  const archive = contractedScheduleArchive(additive);
  return additive.approvalSnapshots?.find(snapshot => snapshot.version === (archive?.version ?? version));
}

function contractedScheduleArchive(additive: Additive) {
  if (!isContractedAdditive(additive)) return;
  return additive.scheduleSnapshots?.find(snapshot => additive.contractRevisionId
    ? snapshot.contractRevisionId === additive.contractRevisionId
    : snapshot.version === additive.version);
}

export function approvedAdditiveRows(additive: Additive) {
  const snapshot = approvedAdditiveSnapshot(additive);
  const source = snapshot ?? additive;
  return source.compositions.map(composition => ({
    composition,
    quantity: computeAdditiveRow(composition, source.bdiPercent ?? 0, source.globalDiscountPercent ?? 0,
      snapshot?.pricingRuleVersion ?? resolveAdditivePricingRule(additive)).qtdFinal,
  }));
}

export const additiveTaskId = (additiveId: string, compositionId: string) => `add-${additiveId}-${compositionId}`;
export const additiveServiceId = (additiveId: string, compositionId: string) => `additive:${additiveId}:${compositionId}`;

export function contractedTaskSchedule(task: Omit<ContractedTaskSchedule, 'archiveId'>, archiveId: string): ContractedTaskSchedule {
  return { archiveId, startDate: task.startDate, duration: task.duration,
    dependencies: task.dependencies, dependencyDetails: task.dependencyDetails,
    team: task.team, scheduleOrder: task.scheduleOrder, durationMode: task.durationMode,
    isManual: task.isManual, manualDuration: task.manualDuration,
    operationalReschedule: task.operationalReschedule };
}

/** Capture only changed planning fields; projected tasks never become base-contract rows. */
export function captureContractedTaskSchedules(previous: Project, before: Project, after: Project,
  additives: readonly Additive[], projectedTaskIds: ReadonlySet<string>): Project {
  const beforeTasks = new Map(flattenTaskTree(before.phases.flatMap(p => p.tasks)).map(t => [t.id, t]));
  const archiveIds = new Map(additives.map(a => [a.id, contractedScheduleArchive(a)?.id]));
  const schedules = { ...previous.contractedTaskSchedules };
  for (const task of flattenTaskTree(after.phases.flatMap(p => p.tasks))) {
    if (!projectedTaskIds.has(task.id)) continue;
    const original = beforeTasks.get(task.id);
    const archiveId = original?.originAdditiveId && archiveIds.get(original.originAdditiveId);
    if (!original || !archiveId) continue;
    const next = contractedTaskSchedule(task, archiveId);
    if (JSON.stringify(next) !== JSON.stringify(contractedTaskSchedule(original, archiveId))) schedules[task.id] = next;
  }
  return Object.keys(schedules).length ? { ...after, contractedTaskSchedules: schedules } : after;
}

export function isNewAdditiveTaskLinked(tasks: ReadonlySet<string>, additive: Additive, composition: AdditiveComposition) {
  const linkedTask = additive.compositions.find(item => item.id === composition.id)?.linkedTaskId;
  return tasks.has(additiveTaskId(additive.id, composition.id)) || !!linkedTask && tasks.has(linkedTask);
}

/** The archived schedule supplies the rows that are intentionally absent from the base EAP. */
export function includeContractedAdditiveTasks(project: Project, additives: readonly Additive[]) {
  const taskIds = new Set(flattenTaskTree(project.phases.flatMap(phase => phase.tasks)).map(task => task.id));
  const projectedTaskIds = new Set<string>();
  const existingPhases = new Set(project.phases.map(phase => phase.id));
  const tasksByPhase = new Map<string, Task[]>();
  const projectedPhases: Project['phases'] = [];

  for (const additive of additives) {
    const archive = contractedScheduleArchive(additive);
    if (!archive) continue;
    const compositions = (approvedAdditiveSnapshot(additive)?.compositions ?? additive.compositions)
      .filter(composition => composition.isNewService);
    const byComposition = new Map(compositions.map(composition => [composition.id, composition]));
    const byTask = new Map(compositions.map(composition => [additiveTaskId(additive.id, composition.id), composition]));
    const orphans: Task[] = [];
    const fallbackId = `gantt-additive-${additive.id}`;
    for (const row of archive.rows) {
      const composition = row.compositionId ? byComposition.get(row.compositionId) : byTask.get(row.taskId);
      if (!composition || row.classification !== 'proposed_addition' || row.quantity <= 0
        || !executionMonth(row.startDate) || !Number.isFinite(row.duration) || row.duration < 1
        || isNewAdditiveTaskLinked(taskIds, additive, composition)) continue;
      const id = additiveTaskId(additive.id, composition.id);
      const savedSchedule = project.contractedTaskSchedules?.[id];
      const schedule = savedSchedule?.archiveId === archive.id ? contractedTaskSchedule(savedSchedule, archive.id) : {};
      taskIds.add(id);
      projectedTaskIds.add(id);
      const phaseId = composition.phaseId && existingPhases.has(composition.phaseId)
        ? composition.phaseId : fallbackId;
      const tasks = phaseId === fallbackId ? orphans : tasksByPhase.get(phaseId) ?? [];
      if (phaseId !== fallbackId) tasksByPhase.set(phaseId, tasks);
      tasks.push({
        id, phase: phaseId, name: row.description, startDate: row.startDate, duration: row.duration,
        dependencies: row.dependencies, dependencyDetails: row.dependencyDetails,
        responsible: row.responsible, team: row.team, scheduleOrder: row.scheduleOrder, contractOrder: row.contractOrder,
        durationMode: row.durationMode, isManual: row.isManual, manualDuration: row.manualDuration,
        percentComplete: 0, materials: [], level: 0, quantity: row.quantity, unit: row.unit,
        unitPrice: row.unitPriceWithBDI, itemCode: row.code ?? composition.code, contractItem: row.item ?? composition.itemNumber ?? composition.item,
        originAdditiveId: additive.id, originAdditiveName: additive.name, originAdditiveVersion: archive.version,
        ...schedule,
      });
    }
    if (orphans.length) projectedPhases.push({ id: fallbackId, name: additive.name, color: '#0369a1', tasks: sortTasksForSchedule(orphans) });
  }
  const phases = project.phases.map(phase => {
    const additions = tasksByPhase.get(phase.id);
    return additions ? { ...phase, tasks: sortTasksForSchedule([...phase.tasks, ...additions]) } : phase;
  });
  return {
    project: projectedTaskIds.size ? { ...project, phases: [...phases, ...projectedPhases] } : project,
    projectedTaskIds, taskIds,
  };
}
