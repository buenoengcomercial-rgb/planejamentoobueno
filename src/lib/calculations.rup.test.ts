import { describe, expect, it } from 'vitest';
import type { Task } from '@/types/project';
import { calculateRupDuration } from './calculations';

function taskWithLabor(): Task {
  return {
    id: 'task-1',
    name: 'Alvenaria',
    phase: '1.1',
    startDate: '2026-07-30',
    duration: 1,
    dependencies: [],
    responsible: '',
    percentComplete: 0,
    materials: [],
    level: 0,
    quantity: 100,
    laborCompositions: [
      { id: 'pedreiro', role: 'Pedreiro', rup: 0.5, workerCount: 2, executionStage: 1 },
      { id: 'servente', role: 'Servente', rup: 0.8, workerCount: 2, executionStage: 1 },
    ],
  };
}

describe('calculateRupDuration', () => {
  it('separa homem-hora total do prazo definido pelo gargalo paralelo', () => {
    const result = calculateRupDuration(taskWithLabor(), { jornadaDiaria: 8, trabalhaSabado: false });

    expect(result.totalHours).toBe(130);
    expect(result.calendarHours).toBe(40);
    expect(result.duration).toBe(5);
    expect(result.bottleneckRole).toBe('Servente');
  });

  it('soma gargalos de etapas sequenciais', () => {
    const task = taskWithLabor();
    task.laborCompositions!.push({
      id: 'pintor',
      role: 'Pintor',
      rup: 0.16,
      workerCount: 2,
      executionStage: 2,
    });

    const result = calculateRupDuration(task, { jornadaDiaria: 8, trabalhaSabado: false });

    expect(result.totalHours).toBe(146);
    expect(result.calendarHours).toBe(48);
    expect(result.duration).toBe(6);
  });
});
