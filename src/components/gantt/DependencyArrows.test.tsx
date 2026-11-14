import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Task } from '@/types/project';
import DependencyArrows from './DependencyArrows';

it('hides connectors to collapsed release groups while retaining visible connections', () => {
  const base = { startDate: '2026-11-13', duration: 1, dependencies: [] } as unknown as Task;
  const tasks = [{ ...base, id: 'a' }, { ...base, id: 'release:a', duration: 0, dependencies: ['a'] }, { ...base, id: 'b', dependencies: ['release:a', 'a'] }];
  const { container, rerender } = render(<DependencyArrows tasks={tasks} taskYPositions={new Map([['a', 20], ['b', 40]])} projectStart={new Date(2026, 10, 13)} dayWidth={10} violations={new Map()} />);
  expect(container.querySelectorAll('svg > g')).toHaveLength(1);
  rerender(<DependencyArrows tasks={tasks} taskYPositions={new Map([['a', 20], ['release:a', 40], ['b', 60]])} projectStart={new Date(2026, 10, 13)} dayWidth={10} violations={new Map()} />);
  expect(container.querySelectorAll('svg > g')).toHaveLength(3);
});
