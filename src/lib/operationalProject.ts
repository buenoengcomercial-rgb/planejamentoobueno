import type { Project, Task } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { getPendingAdditiveScheduleControls } from '@/lib/additiveSchedule';
import { replaceProjectTasksById } from '@/lib/taskTree';

function executionStateFromOperationalTask(rawTask: Task, operationalTask?: Task): Task {
  if (!operationalTask) return rawTask;
  // Datas e vínculos de uma tarefa controlada por aditivo pendente pertencem
  // ao rascunho do aditivo. Já a produção é fato operacional e deve voltar ao
  // contrato-base, para atualizar percentual, Gantt e Diário de Obra.
  return {
    ...rawTask,
    dailyLogs: operationalTask.dailyLogs,
    executedQuantityTotal: operationalTask.executedQuantityTotal,
    remainingQuantity: operationalTask.remainingQuantity,
    physicalProgress: operationalTask.physicalProgress,
    percentComplete: operationalTask.percentComplete,
    current: operationalTask.current,
  };
}

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
    controls.has(task.id)
      ? executionStateFromOperationalTask(task, nextTasks.get(task.id))
      : (nextTasks.get(task.id) ?? task),
  ]));
  return { ...nextOperational, phases: replaceProjectTasksById(previous, mergedTasks).phases };
}
