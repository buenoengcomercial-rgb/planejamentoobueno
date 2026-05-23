import type { AdditiveComposition, AdditiveInput, LaborComposition, MaterialCostClass, Project, Task } from '@/types/project';
import { calculateRupDuration } from '@/lib/calculations';
import { guessMaterialCostClass, linkKeyOf } from '@/lib/materialComparisons';

function normKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function inputKey(input: AdditiveInput): string {
  return `${normKey(input.code)}|${normKey(input.description)}|${normKey(input.unit)}`;
}

function resolveInputCostClass(project: Project, input: AdditiveInput): MaterialCostClass {
  const manualById = project.materialCostClasses?.[linkKeyOf({
    sourceId: input.id,
    code: input.code,
    description: input.description,
    unit: input.unit,
  })];
  if (manualById) return manualById;

  const manualByKey = project.materialCostClasses?.[linkKeyOf({
    code: input.code,
    description: input.description,
    unit: input.unit,
  })];
  if (manualByKey) return manualByKey;

  return guessMaterialCostClass({
    description: input.description,
    unit: input.unit,
    sourceType: 'additive_input',
    legacyInputType: input.type,
  });
}

export function buildLaborCompositionsFromAdditive(
  project: Project,
  composition: AdditiveComposition,
): LaborComposition[] {
  const grouped = new Map<string, LaborComposition>();

  for (const input of composition.inputs ?? []) {
    const coefficient = Number(input.coefficient ?? 0);
    if (!Number.isFinite(coefficient) || coefficient <= 0) continue;
    if (resolveInputCostClass(project, input) !== 'labor') continue;

    const key = inputKey(input);
    const existing = grouped.get(key);
    if (existing) {
      grouped.set(key, {
        ...existing,
        rup: Number((existing.rup + coefficient).toFixed(6)),
      });
      continue;
    }

    grouped.set(key, {
      id: `lc-add-${composition.id}-${input.id}`,
      role: input.description || input.code || 'Mao de obra',
      rup: coefficient,
      workerCount: 1,
      hourlyRate: input.unitPrice || undefined,
    });
  }

  return Array.from(grouped.values());
}

export interface SyncAdditiveProductivityResult {
  project: Project;
  updated: number;
  withoutLabor: number;
  preserved: number;
}

function taskAlreadyHasManualProductivity(task: Task): boolean {
  return (task.laborCompositions?.length ?? 0) > 0;
}

function applyLaborToTask(task: Task, laborCompositions: LaborComposition[]): Task {
  const nextBase: Task = {
    ...task,
    laborCompositions,
    durationMode: 'rup',
    isManual: false,
    manualDuration: undefined,
  };
  const calc = calculateRupDuration(nextBase);
  return {
    ...nextBase,
    duration: Math.max(1, calc.duration),
    totalHours: calc.totalHours,
    bottleneckRole: calc.bottleneckRole,
    calculatedDuration: Math.max(1, calc.duration),
  };
}

export function applyAdditiveProductivityToTask(
  project: Project,
  task: Task,
  composition: AdditiveComposition,
  options: { overwriteExisting?: boolean } = {},
): { task: Task; status: 'updated' | 'without_labor' | 'preserved' } {
  if (!options.overwriteExisting && taskAlreadyHasManualProductivity(task)) {
    return { task, status: 'preserved' };
  }

  const laborCompositions = buildLaborCompositionsFromAdditive(project, composition);
  if (!laborCompositions.length) {
    return { task, status: 'without_labor' };
  }

  return { task: applyLaborToTask(task, laborCompositions), status: 'updated' };
}

export function syncAdditiveProductivity(project: Project): SyncAdditiveProductivityResult {
  const compositionsByTaskId = new Map<string, AdditiveComposition>();

  for (const additive of project.additives ?? []) {
    for (const composition of additive.compositions ?? []) {
      const taskId = composition.linkedTaskId ?? composition.taskId;
      if (!taskId) continue;
      if (!composition.inputs?.length) continue;
      compositionsByTaskId.set(taskId, composition);
    }
  }

  let updated = 0;
  let withoutLabor = 0;
  let preserved = 0;

  const phases = project.phases.map(phase => ({
    ...phase,
    tasks: phase.tasks.map(task => {
      const composition = compositionsByTaskId.get(task.id);
      if (!composition) return task;

      const result = applyAdditiveProductivityToTask(project, task, composition);
      if (result.status === 'updated') updated += 1;
      if (result.status === 'without_labor') withoutLabor += 1;
      if (result.status === 'preserved') preserved += 1;
      return result.task;
    }),
  }));

  return {
    project: { ...project, phases },
    updated,
    withoutLabor,
    preserved,
  };
}
