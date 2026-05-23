import type { Project, Task } from '@/types/project';

type IndexedTask = { task: Task; index: number };

function byStableNumber(
  a: IndexedTask,
  b: IndexedTask,
  getValue: (task: Task, index: number) => number,
) {
  const av = getValue(a.task, a.index);
  const bv = getValue(b.task, b.index);
  if (av !== bv) return av - bv;
  return a.index - b.index;
}

export function getTaskContractOrder(task: Task, fallbackIndex: number): number {
  return task.contractOrder ?? task.originalOrder ?? task.publicSheetOrder ?? fallbackIndex;
}

export function getTaskScheduleOrder(task: Task, fallbackIndex: number): number {
  return task.scheduleOrder ?? task.ganttOrder ?? task.ordemExecucao ?? getTaskContractOrder(task, fallbackIndex);
}

export function sortTasksForContract(tasks: Task[]): Task[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => byStableNumber(a, b, getTaskContractOrder))
    .map(({ task }) => task);
}

export function sortTasksForSchedule(tasks: Task[]): Task[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => byStableNumber(a, b, getTaskScheduleOrder))
    .map(({ task }) => task);
}

function renumberSchedule(tasks: Task[]): Task[] {
  return tasks.map((task, index) => ({ ...task, scheduleOrder: index }));
}

export function withScheduleOrderForMove(
  project: Project,
  dragPhaseId: string,
  dragTaskId: string,
  targetPhaseId: string,
  targetTaskId: string,
  position: 'before' | 'after' = 'before',
): Project {
  // The contract hierarchy is shared by Medicao, Aditivo and Custo Real.
  // Reordering in Cronograma changes only scheduleOrder, never phase.tasks order.
  if (dragPhaseId !== targetPhaseId || dragTaskId === targetTaskId) return project;

  const phase = project.phases.find(p => p.id === dragPhaseId);
  if (!phase) return project;

  const orderedTasks = sortTasksForSchedule(phase.tasks);
  const draggedTask = orderedTasks.find(task => task.id === dragTaskId);
  if (!draggedTask) return project;

  const withoutDragged = orderedTasks.filter(task => task.id !== dragTaskId);
  const targetIndex = withoutDragged.findIndex(task => task.id === targetTaskId);
  if (targetIndex === -1) return project;

  const insertAt = position === 'after' ? targetIndex + 1 : targetIndex;
  withoutDragged.splice(insertAt, 0, draggedTask);

  const orderedById = new Map(renumberSchedule(withoutDragged).map(task => [task.id, task]));

  return {
    ...project,
    phases: project.phases.map(p => (
      p.id === phase.id
        ? { ...p, tasks: p.tasks.map(task => orderedById.get(task.id) ?? task) }
        : p
    )),
  };
}
