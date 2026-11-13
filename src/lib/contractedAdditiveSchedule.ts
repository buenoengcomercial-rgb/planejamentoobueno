import type { Additive, AdditiveComposition, Project, Task } from '@/types/project';
import { computeAdditiveRow, resolveAdditivePricingRule } from '@/lib/additiveImport';
import { executionMonth } from '@/lib/monthlyExecution';
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

export function isNewAdditiveTaskLinked(tasks: ReadonlySet<string>, additive: Additive, composition: AdditiveComposition) {
  const linkedTask = additive.compositions.find(item => item.id === composition.id)?.linkedTaskId;
  return tasks.has(additiveTaskId(additive.id, composition.id)) || !!linkedTask && tasks.has(linkedTask);
}

/** The archived schedule supplies the rows that are intentionally absent from the base EAP. */
export function includeContractedAdditiveTasks(project: Project, additives: readonly Additive[]) {
  const taskIds = new Set(flattenTaskTree(project.phases.flatMap(phase => phase.tasks)).map(task => task.id));
  const projectedTaskIds = new Set<string>();
  const projectedPhases: Project['phases'] = [];

  for (const additive of additives) {
    const archive = contractedScheduleArchive(additive);
    if (!archive) continue;
    const compositions = (approvedAdditiveSnapshot(additive)?.compositions ?? additive.compositions)
      .filter(composition => composition.isNewService);
    const byComposition = new Map(compositions.map(composition => [composition.id, composition]));
    const byTask = new Map(compositions.map(composition => [additiveTaskId(additive.id, composition.id), composition]));
    const tasks: Task[] = [];
    const phaseId = `gantt-additive-${additive.id}`;
    for (const row of archive.rows) {
      const composition = row.compositionId ? byComposition.get(row.compositionId) : byTask.get(row.taskId);
      if (!composition || row.classification !== 'proposed_addition' || row.quantity <= 0
        || !executionMonth(row.startDate) || !Number.isFinite(row.duration) || row.duration < 1
        || isNewAdditiveTaskLinked(taskIds, additive, composition)) continue;
      const id = additiveTaskId(additive.id, composition.id);
      taskIds.add(id);
      projectedTaskIds.add(id);
      tasks.push({
        id, phase: phaseId, name: row.description, startDate: row.startDate, duration: row.duration,
        dependencies: row.dependencies, dependencyDetails: row.dependencyDetails,
        responsible: row.responsible, team: row.team, scheduleOrder: row.scheduleOrder,
        durationMode: row.durationMode, isManual: row.isManual, manualDuration: row.manualDuration,
        percentComplete: 0, materials: [], level: 0, quantity: row.quantity, unit: row.unit,
        unitPrice: row.unitPriceWithBDI, itemCode: row.code, contractItem: row.item,
        originAdditiveId: additive.id, originAdditiveName: additive.name, originAdditiveVersion: archive.version,
      });
    }
    if (tasks.length) projectedPhases.push({ id: phaseId, name: additive.name, color: '#0369a1', tasks });
  }
  return { project: projectedPhases.length ? { ...project, phases: [...project.phases, ...projectedPhases] } : project,
    projectedTaskIds, taskIds };
}
