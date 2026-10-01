import type { Phase, Project, Task } from '@/types/project';

export type ProductionStatusFilter = 'all' | 'in_progress' | 'delayed' | 'no_team' | 'complete';

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function filterProductionTasks(
  project: Project,
  query: string,
  status: ProductionStatusFilter,
  team: string,
  today: string,
): { active: boolean; phaseIds: Set<string>; taskIds: Set<string>; count: number } {
  const normalizedQuery = normalize(query);
  const active = !!normalizedQuery || status !== 'all' || !!team;
  const phaseIds = new Set<string>();
  const taskIds = new Set<string>();
  if (!active) return { active, phaseIds, taskIds, count: 0 };

  const byId = new Map(project.phases.map(phase => [phase.id, phase]));
  const pathFor = (phase: Phase): Phase[] => {
    const path: Phase[] = [];
    const visited = new Set<string>();
    let current: Phase | undefined = phase;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return path;
  };
  const matchesStatus = (task: Task) => {
    if (status === 'in_progress') return task.percentComplete > 0 && task.percentComplete < 100;
    if (status === 'complete') return task.percentComplete >= 100;
    if (status === 'no_team') return !task.team;
    if (status === 'delayed') {
      const end = new Date(`${task.startDate}T12:00:00`);
      end.setDate(end.getDate() + Math.max(0, task.duration - 1));
      return task.percentComplete < 100 && !Number.isNaN(end.getTime()) && end.toISOString().slice(0, 10) < today;
    }
    return true;
  };

  project.phases.forEach(phase => {
    const path = pathFor(phase);
    const phaseText = normalize(path.map(item => `${item.customNumber ?? ''} ${item.name}`).join(' '));
    if (normalizedQuery && phase.tasks.length === 0 && phaseText.includes(normalizedQuery) && status === 'all' && !team) {
      path.forEach(item => phaseIds.add(item.id));
    }
    phase.tasks.forEach(task => {
      if (team && task.team !== team) return;
      if (!matchesStatus(task)) return;
      const taskText = normalize(`${task.name} ${task.responsible ?? ''} ${task.id}`);
      if (normalizedQuery && !taskText.includes(normalizedQuery) && !phaseText.includes(normalizedQuery)) return;
      taskIds.add(task.id);
      path.forEach(item => phaseIds.add(item.id));
    });
  });
  return { active, phaseIds, taskIds, count: taskIds.size };
}
