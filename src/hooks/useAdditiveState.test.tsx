import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { useAdditiveState } from './useAdditiveState';

const project = {
  id: 'visual-only-project',
  additives: [{ id: 'add-1', name: 'Aditivo', uiState: { collapsedGroupIds: [] } }],
} as Project;

describe('useAdditiveState: preferências visuais', () => {
  beforeEach(() => localStorage.clear());

  it('recolher capítulo não altera a obra nem pede salvamento na nuvem', () => {
    const view = renderHook(() => useAdditiveState(project));

    act(() => {
      view.result.current.toggleCollapsed('chapter-1');
      view.result.current.toggleExpand('composition-1');
      view.result.current.setShowAnalytic(false);
    });

    expect(view.result.current.collapsed.has('chapter-1')).toBe(true);
    expect(view.result.current.expanded.has('composition-1')).toBe(true);
    expect(view.result.current.showAnalytic).toBe(false);
    expect(project.additives?.[0].uiState?.collapsedGroupIds).toEqual([]);
    view.unmount();

    const reopened = renderHook(() => useAdditiveState(project));
    expect(reopened.result.current.collapsed.has('chapter-1')).toBe(true);
    expect(reopened.result.current.expanded.has('composition-1')).toBe(true);
    expect(reopened.result.current.showAnalytic).toBe(false);
  });
});
