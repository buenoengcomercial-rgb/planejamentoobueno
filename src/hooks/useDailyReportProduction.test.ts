import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { collectProductionForDate } from './useDailyReportProduction';

describe('collectProductionForDate', () => {
  it('inclui somente tarefas com quantidade efetivamente executada', () => {
    const project = {
      phases: [
        {
          id: 'chapter-1', name: 'Serviços preliminares', order: 0,
          tasks: [
            { id: 'task-executed', contractItem: '1.1.1', name: 'Administração', unit: 'mês', dailyLogs: [{ date: '2026-08-24', actualQuantity: 0.03 }] },
            { id: 'task-zero', name: 'Placa da obra', unit: 'm²', dailyLogs: [{ date: '2026-08-24', actualQuantity: 0, plannedQuantity: 3, notes: 'Aguardando material' }] },
          ],
        },
        {
          id: 'chapter-2', name: 'Incêndio', order: 1,
          tasks: [{ id: 'task-zero-only', name: 'Botoeira', unit: 'un', dailyLogs: [{ date: '2026-08-24', actualQuantity: 0 }] }],
        },
      ],
    } as unknown as Project;

    const production = collectProductionForDate(project, '2026-08-24');

    expect(production).toHaveLength(1);
    expect(production[0]).toMatchObject({ taskId: 'task-executed', taskCode: '1.1.1', actualQuantity: 0.03 });
  });
});
