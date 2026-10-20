import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Additive as AdditiveModel, AdditiveStatus, AdditiveUiState } from '@/types/project';
import { readAdditiveViewPreferences, writeAdditiveViewPreferences } from '@/lib/projectViewPreferences';

export function useAdditiveState(project: Project) {
  const additives = useMemo(() => project.additives ?? [], [project.additives]);
  const [activeId, setActiveId] = useState<string | null>(additives[0]?.id ?? null);
  const active = useMemo<AdditiveModel | null>(
    () => additives.find(a => a.id === activeId) ?? additives[0] ?? null,
    [additives, activeId],
  );

  const [search, setSearch] = useState('');
  const [bankFilter, setBankFilter] = useState<string>('all');

  // Preferências visuais são locais ao navegador e nunca geram autosave da obra.
  const initialUi = active?.id
    ? readAdditiveViewPreferences(project.id, active.id, active.uiState)
    : undefined;
  const [showAnalytic, setShowAnalyticState] = useState<boolean>(initialUi?.showAnalytic ?? true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(initialUi?.expandedCompositionIds ?? []));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(initialUi?.collapsedGroupIds ?? []));

  // Recarrega o estado visual quando muda o aditivo ativo (cada aditivo tem seu próprio estado).
  const lastLoadedIdRef = useRef(`${project.id}:${active?.id ?? ''}`);
  useEffect(() => {
    const key = `${project.id}:${active?.id ?? ''}`;
    if (key === lastLoadedIdRef.current) return;
    lastLoadedIdRef.current = key;
    const ui = active?.id
      ? readAdditiveViewPreferences(project.id, active.id, active.uiState)
      : undefined;
    setShowAnalyticState(ui?.showAnalytic ?? true);
    setExpanded(new Set(ui?.expandedCompositionIds ?? []));
    setCollapsed(new Set(ui?.collapsedGroupIds ?? []));
  }, [project.id, active?.id, active?.uiState]);

  const persistUi = useCallback((patch: Partial<AdditiveUiState>) => {
    if (active?.id) writeAdditiveViewPreferences(project.id, active.id, patch, active.uiState);
  }, [project.id, active?.id, active?.uiState]);

  const setShowAnalytic: typeof setShowAnalyticState = useCallback((value) => {
    setShowAnalyticState(prev => {
      const next = typeof value === 'function' ? (value as (p: boolean) => boolean)(prev) : value;
      if (next !== prev) persistUi({ showAnalytic: next });
      return next;
    });
  }, [persistUi]);

  const toggleExpand = useCallback((id: string) =>
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      persistUi({ expandedCompositionIds: Array.from(n) });
      return n;
    }), [persistUi]);

  const toggleCollapsed = useCallback((id: string) =>
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      persistUi({ collapsedGroupIds: Array.from(n) });
      return n;
    }), [persistUi]);

  const collapseAllGroups = useCallback((allPhaseIds: string[]) => {
    const n = new Set(allPhaseIds);
    setCollapsed(n);
    persistUi({ collapsedGroupIds: Array.from(n) });
  }, [persistUi]);

  const expandAllGroups = useCallback(() => {
    setCollapsed(new Set());
    persistUi({ collapsedGroupIds: [] });
  }, [persistUi]);

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importName, setImportName] = useState('SINTÉTICA CORREÇÃO 02');
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const [issuesOpen, setIssuesOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewNotes, setReviewNotes] = useState('');
  const [approvedBy, setApprovedBy] = useState('');

  const fileRef = useRef<HTMLInputElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const status: AdditiveStatus = active?.status ?? 'rascunho';
  const isIntegratedRevisionOpen = !!active?.isContracted && !!active?.editUnlocked;
  const isLocked =
    status === 'em_analise' ||
    status === 'aprovado' ||
    ((status === 'aditivo_contratado' || !!active?.isContracted) && !isIntegratedRevisionOpen);
  const globalDiscount = active?.globalDiscountPercent ?? 0;
  const bdi = active?.bdiPercent ?? 0;

  return {
    additives,
    activeId, setActiveId,
    active,
    search, setSearch,
    bankFilter, setBankFilter,
    showAnalytic, setShowAnalytic,
    expanded, toggleExpand,
    collapsed, toggleCollapsed, collapseAllGroups, expandAllGroups,
    importDialogOpen, setImportDialogOpen,
    importName, setImportName,
    pendingFile, setPendingFile,
    issuesOpen, setIssuesOpen,
    confirmDeleteId, setConfirmDeleteId,
    reviewDialogOpen, setReviewDialogOpen,
    reviewNotes, setReviewNotes,
    approvedBy, setApprovedBy,
    fileRef,
    historyOpen, setHistoryOpen,
    status,
    isLocked,
    globalDiscount,
    bdi,
  };
}

export type AdditiveStateApi = ReturnType<typeof useAdditiveState>;
