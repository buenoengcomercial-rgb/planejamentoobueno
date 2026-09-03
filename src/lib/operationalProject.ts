import type { Project } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { getPendingAdditiveScheduleControls } from '@/lib/additiveSchedule';
import { replaceProjectTasksById } from '@/lib/taskTree';

/**
 * Converte uma edição feita sobre a projeção operacional em dados persistíveis.
 * Tarefas controladas por aditivo pendente continuam contratuais no projeto-base;
 * a alteração correspondente fica no rascunho do aditivo já presente na projeção.
 */
export function mergeOperationalProjectIntoRaw(previous: Project, nextOperational: Project): Project {
  const controls = getPendingAdditiveScheduleControls(previous);
  const nextTasks = new Map(getAllTasks(nextOperational).map(task => [task.id, task]));
  const mergedTasks = new Map(getAllTasks(previous).map(task => [
    task.id,
    controls.has(task.id) ? task : (nextTasks.get(task.id) ?? task),
  ]));
  return { ...nextOperational, phases: replaceProjectTasksById(previous, mergedTasks).phases };
}
