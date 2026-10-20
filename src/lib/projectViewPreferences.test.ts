import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import {
  readAdditiveViewPreferences,
  readGanttCollapsedPhases,
  writeAdditiveViewPreferences,
  writeGanttCollapsedPhases,
} from './projectViewPreferences';

describe('preferências visuais locais', () => {
  beforeEach(() => localStorage.clear());

  it('isola cada aditivo e preserva preferências legadas sem alterar o projeto', () => {
    const legacy = { collapsedGroupIds: ['antigo'], showAnalytic: true };
    writeAdditiveViewPreferences('obra-a', 'aditivo-1', { collapsedGroupIds: ['novo'] }, legacy);
    writeAdditiveViewPreferences('obra-a', 'aditivo-1', { scheduleCollapsedPhaseIds: ['fase-1'] }, legacy);

    expect(readAdditiveViewPreferences('obra-a', 'aditivo-1', legacy)).toMatchObject({
      collapsedGroupIds: ['novo'], scheduleCollapsedPhaseIds: ['fase-1'], showAnalytic: true,
    });
    expect(readAdditiveViewPreferences('obra-a', 'aditivo-2', legacy).collapsedGroupIds).toEqual(['antigo']);
    expect(legacy.collapsedGroupIds).toEqual(['antigo']);
  });

  it('guarda o recolhimento do cronograma por obra sem escrever no projeto', () => {
    const project = { id: 'obra-a', uiState: { ganttCollapsedPhaseIds: ['legado'] } } as Project;
    expect(readGanttCollapsedPhases(project)).toEqual(['legado']);

    writeGanttCollapsedPhases(project.id, ['atual']);

    expect(readGanttCollapsedPhases(project)).toEqual(['atual']);
    expect(readGanttCollapsedPhases({ ...project, id: 'obra-b' })).toEqual(['legado']);
    expect(project.uiState?.ganttCollapsedPhaseIds).toEqual(['legado']);
  });
});
