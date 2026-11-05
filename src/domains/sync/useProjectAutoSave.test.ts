import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { applyProjectOperation } from '@/lib/projectOperations';
import { projectAutoSaveDelay } from './useProjectAutoSave';

describe('tempo de espera do autosave', () => {
  it('antecipa apenas alterações originadas no Cronograma do Aditivo', () => {
    const base = { id: 'project-1', name: 'Obra', additives: [{ id: 'add-1', name: 'Aditivo' }] } as Project;
    const edited = applyProjectOperation('additiveSchedule', base, base, {
      ...base, additives: [{ ...base.additives![0], scheduleDraft: { plannedTasks: [] } }],
    } as Project);
    expect(projectAutoSaveDelay(edited)).toBe(1800);
    expect(projectAutoSaveDelay(base)).toBe(4000);
  });
});
