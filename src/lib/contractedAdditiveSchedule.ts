import type { Additive, AdditiveComposition, ContractedTaskSchedule, Phase, Project, Task } from '@/types/project';
import { computeAdditiveRow, resolveAdditivePricingRule } from '@/lib/additiveImport';
import { executionMonth } from '@/lib/monthlyExecution';
import { sortTasksForSchedule } from '@/lib/taskOrdering';
import { flattenTaskTree, replaceProjectTasksById } from '@/lib/taskTree';
import { getChapterNumbering, isNewServicesChapter, NEW_SERVICES_CHAPTER } from '@/lib/chapters';
import { calculateRupDuration } from '@/lib/calculations';
import { money2, trunc2 } from '@/lib/financialEngine';

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

export interface ContractedQuantityAdjustment {
  base: number;
  added: number;
  suppressed: number;
  total: number;
}

function projectContractedQuantities(project: Project, tasks: Map<string, Task>, additives: readonly Additive[]) {
  const changes = new Map<string, Array<{ additiveId: string; composition: AdditiveComposition }>>();
  for (const additive of additives.filter(isContractedAdditive)) {
    const snapshot = approvedAdditiveSnapshot(additive);
    if (!snapshot && additive.editUnlocked) continue;
    for (const composition of snapshot?.compositions ?? additive.compositions) {
      if (composition.isNewService || !composition.addedQuantity && !composition.suppressedQuantity) continue;
      const taskId = [composition.baseTaskId, composition.linkedTaskId, composition.taskId].find(id => id && tasks.has(id));
      if (!taskId) continue;
      const rows = changes.get(taskId) ?? [];
      rows.push({ additiveId: additive.id, composition });
      changes.set(taskId, rows);
    }
  }

  const replacements = new Map<string, Task>();
  const quantityAdjustments = new Map<string, ContractedQuantityAdjustment>();
  for (const [taskId, rows] of changes) {
    const task = tasks.get(taskId)!;
    const history = task.additiveHistory ?? [];
    const composition = rows[0].composition;
    const base = history[0]?.previousQuantity ?? task.quantityContracted ?? composition.originalQuantity
      ?? task.baseline?.quantity ?? task.quantity ?? composition.quantity;
    const byAdditive = new Map(rows.map(({ additiveId, composition }) => [additiveId, {
      addedQuantity: trunc2(composition.addedQuantity), suppressedQuantity: trunc2(composition.suppressedQuantity),
    }]));
    // Integrated revisions are already represented by the approved rows.
    // Retain legacy changes for additives no longer present in the source.
    const legacy = history.filter(entry => !byAdditive.has(entry.additiveId));
    const adjustments = [...byAdditive.values(), ...legacy];
    const added = money2(adjustments.reduce((sum, item) => sum + item.addedQuantity, 0));
    const suppressed = money2(adjustments.reduce((sum, item) => sum + item.suppressedQuantity, 0));
    const total = Math.max(0, money2(base + added - suppressed));
    quantityAdjustments.set(taskId, { base, added, suppressed, total });
    const next = { ...task, quantity: total, quantityContracted: base, suppressedByAdditive: total === 0 };
    const rup = total > 0 && task.durationMode === 'rup' && !task.isManual
      && task.laborCompositions?.length && !task.operationalReschedule
      ? calculateRupDuration(next, project.scheduleCalendar) : undefined;
    if (task.quantity === total && (!rup || task.duration === rup.duration)) continue;
    replacements.set(taskId, rup ? { ...next, ...rup, calculatedDuration: rup.duration } : next);
  }
  return { project: replacements.size ? replaceProjectTasksById(project, replacements) : project, quantityAdjustments };
}

/** The archived schedule supplies the rows that are intentionally absent from the base EAP. */
export function includeContractedAdditiveTasks(project: Project, additives: readonly Additive[]) {
  const baseTasks = new Map(flattenTaskTree(project.phases.flatMap(phase => phase.tasks)).map(task => [task.id, task]));
  const taskIds = new Set(baseTasks.keys());
  const quantities = projectContractedQuantities(project, baseTasks, additives);
  const projectedTaskIds = new Set<string>();
  const existingPhases = new Map(project.phases.map(phase => [phase.id, phase]));
  const roots = project.phases.filter(phase => !phase.parentId);
  const numbering = getChapterNumbering(project);
  const rootsByNumber = new Map(roots.map(phase => [numbering.get(phase.id), phase]));
  const newServicesByParent = new Map<string, Phase[]>();
  for (const phase of project.phases.filter(isNewServicesChapter)) {
    const siblings = newServicesByParent.get(phase.parentId!) ?? [];
    siblings.push(phase);
    newServicesByParent.set(phase.parentId!, siblings);
  }
  const tasksByPhase = new Map<string, Task[]>();
  const projectedPhases = new Map<string, Phase>();

  function resolvePhase(composition: AdditiveComposition, items: Array<string | undefined>, fallback: Phase): Phase {
    const explicit = composition.phaseId && existingPhases.get(composition.phaseId);
    if (explicit) return explicit;
    const match = items.flatMap(item => {
      const [, rootNumber, childNumber] = /^(\d+)\.(\d+)(?:\.|$)/.exec(item?.trim() ?? '') ?? [];
      const root = rootsByNumber.get(rootNumber);
      return root ? [{ root, subchapter: `${rootNumber}.${childNumber}` }] : [];
    })[0];
    const root = match?.root ?? roots.find(phase => phase.name === composition.phaseChain?.split('›')[0].trim());
    if (!root) return fallback;
    const children = newServicesByParent.get(root.id) ?? [];
    const existing = children.find(phase => numbering.get(phase.id) === match?.subchapter) ?? children[0];
    if (existing) return existing;
    const id = `gantt-additive-new-services:${root.id}`;
    const created = projectedPhases.get(id) ?? {
      id, parentId: root.id, name: NEW_SERVICES_CHAPTER, color: root.color,
      customNumber: match?.subchapter, tasks: [],
    };
    projectedPhases.set(id, created);
    return created;
  }

  for (const additive of additives) {
    const archive = contractedScheduleArchive(additive);
    if (!archive) continue;
    const compositions = (approvedAdditiveSnapshot(additive)?.compositions ?? additive.compositions)
      .filter(composition => composition.isNewService);
    const byComposition = new Map(compositions.map(composition => [composition.id, composition]));
    const byTask = new Map(compositions.map(composition => [additiveTaskId(additive.id, composition.id), composition]));
    const fallback: Phase = { id: `gantt-additive-${additive.id}`, name: additive.name, color: '#0369a1', tasks: [] };
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
      const destination = resolvePhase(composition, [composition.itemNumber, composition.item, row.item], fallback);
      const phaseId = destination.id;
      const tasks = tasksByPhase.get(phaseId) ?? [];
      tasksByPhase.set(phaseId, tasks);
      tasks.push({
        id, phase: phaseId, name: row.description, startDate: row.startDate, duration: row.duration,
        dependencies: row.dependencies, dependencyDetails: row.dependencyDetails,
        responsible: row.responsible, team: row.team, scheduleOrder: row.scheduleOrder, contractOrder: row.contractOrder,
        durationMode: row.durationMode, isManual: row.isManual, manualDuration: row.manualDuration,
        percentComplete: 0, materials: [], level: 0, quantity: row.quantity, unit: row.unit,
        unitPrice: row.unitPriceWithBDI, itemCode: row.code ?? composition.code, contractItem: row.item || composition.itemNumber || composition.item,
        originAdditiveId: additive.id, originAdditiveName: additive.name, originAdditiveVersion: archive.version,
        ...schedule,
      });
    }
    if (tasksByPhase.has(fallback.id)) projectedPhases.set(fallback.id, fallback);
  }
  const phases = [...quantities.project.phases, ...projectedPhases.values()].map(phase => {
    const additions = tasksByPhase.get(phase.id);
    return additions ? { ...phase, tasks: sortTasksForSchedule([...phase.tasks, ...additions]) } : phase;
  });
  return {
    project: projectedTaskIds.size ? { ...quantities.project, phases } : quantities.project,
    projectedTaskIds, taskIds, quantityAdjustments: quantities.quantityAdjustments,
  };
}
