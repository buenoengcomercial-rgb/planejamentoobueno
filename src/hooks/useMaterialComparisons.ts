import { useCallback, useMemo, useState, useEffect } from 'react';
import type { Project, MaterialComparison } from '@/types/project';
import * as MC from '@/lib/materialComparisons';

const LS_ACTIVE_KEY = (projectId: string) => `materials:activeComparison:${projectId}`;

export function useMaterialComparisons(project: Project, onProjectChange: (next: Project) => void) {
  const comparisons = project.materialComparisons ?? [];

  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem(LS_ACTIVE_KEY(project.id));
      if (stored && comparisons.some(c => c.id === stored)) return stored;
    } catch { /* ignore */ }
    return comparisons[0]?.id ?? null;
  });

  useEffect(() => {
    // Garante que activeId sempre aponte para algo válido (se existir)
    if (activeId && !comparisons.some(c => c.id === activeId)) {
      setActiveId(comparisons[0]?.id ?? null);
    } else if (!activeId && comparisons.length > 0) {
      setActiveId(comparisons[0].id);
    }
  }, [activeId, comparisons]);

  useEffect(() => {
    try {
      if (activeId) localStorage.setItem(LS_ACTIVE_KEY(project.id), activeId);
    } catch { /* ignore */ }
  }, [activeId, project.id]);

  const active = useMemo(
    () => comparisons.find(c => c.id === activeId) ?? null,
    [comparisons, activeId],
  );

  const apply = useCallback((next: MaterialComparison) => {
    onProjectChange(MC.upsertComparison(project, next));
  }, [project, onProjectChange]);

  const createNew = useCallback((name: string) => {
    const c = MC.createComparison(name);
    onProjectChange(MC.upsertComparison(project, c));
    setActiveId(c.id);
    return c;
  }, [project, onProjectChange]);

  const remove = useCallback((id: string) => {
    onProjectChange(MC.deleteComparison(project, id));
    if (activeId === id) setActiveId(comparisons.find(c => c.id !== id)?.id ?? null);
  }, [project, onProjectChange, activeId, comparisons]);

  const close = useCallback((id: string) => {
    const c = comparisons.find(x => x.id === id);
    if (!c) return;
    let next = MC.setComparisonStatus(c, 'fechado');
    const updated = MC.upsertComparison(project, next);
    const withHistory = MC.appendPriceHistoryFromComparison(updated, next);
    onProjectChange(withHistory);
  }, [project, onProjectChange, comparisons]);

  return {
    comparisons,
    active,
    activeId,
    setActiveId,
    apply,
    createNew,
    remove,
    close,
  };
}
