import type { TaskDependency } from '@/types/project';

export const dependencyLag = (dependency: Pick<TaskDependency, 'lag'>): number =>
  Number.isFinite(dependency.lag) ? Math.trunc(dependency.lag!) : 0;

/** Gantt row numbers with optional working-day lag: 12, 15+3, 20-2. */
export function parseDependencyNumbers(value: string): Array<{ number: number; lag?: number }> {
  return value.split(',').flatMap(token => {
    const match = token.trim().match(/^(\d+)(?:\s*([+-])\s*(\d+))?$/);
    if (!match) return [];
    return [{ number: Number(match[1]), ...(match[2] ? { lag: Number(match[3]) * (match[2] === '-' ? -1 : 1) } : {}) }];
  });
}

export function formatDependencyNumber(number: number, dependency: Pick<TaskDependency, 'lag'>): string {
  const lag = dependencyLag(dependency);
  return `${number}${lag ? `${lag > 0 ? '+' : ''}${lag}` : ''}`;
}
