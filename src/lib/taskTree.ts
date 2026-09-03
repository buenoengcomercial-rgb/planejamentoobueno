import type { Project, Task } from '@/types/project';

export function flattenTaskTree(tasks: Task[]): Task[] {
  return tasks.flatMap(task => [task, ...(task.children ? flattenTaskTree(task.children) : [])]);
}

export function mapTaskTree(tasks: Task[], update: (task: Task) => Task): Task[] {
  return tasks.map(task => {
    const next = update(task);
    if (!task.children?.length) return next;
    return { ...next, children: mapTaskTree(task.children, update) };
  });
}

export function replaceProjectTasksById(project: Project, tasksById: ReadonlyMap<string, Task>): Project {
  return {
    ...project,
    phases: project.phases.map(phase => ({
      ...phase,
      tasks: mapTaskTree(phase.tasks, task => tasksById.get(task.id) ?? task),
    })),
  };
}

export function updateProjectTask(project: Project, taskId: string, update: (task: Task) => Task): Project {
  const task = flattenTaskTree(project.phases.flatMap(phase => phase.tasks)).find(item => item.id === taskId);
  return task ? replaceProjectTasksById(project, new Map([[taskId, update(task)]])) : project;
}
