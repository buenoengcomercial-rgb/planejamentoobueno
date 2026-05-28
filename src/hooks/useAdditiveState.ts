import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Additive as AdditiveModel, AdditiveStatus, AdditiveUiState } from '@/types/project';

interface Options {
  /** Quando fornecido, persiste o estado visual (collapsed/expanded/showAnalytic) dentro do aditivo ativo. */
  onProjectChange?: (next: Project | ((prev: Project) => Project)) => void;
}

export function useAdditiveState(project: Project, opts: Options = {}) {
  const { onProjectChange } = opts;
  const additives = project.additives ?? [];
  const [activeId, setActiveId] = useState<string | null>(additives[0]?.id ?? null);
  const active = useMemo<AdditiveModel | null>(
    () => additives.find(a => a.id === activeId) ?? additives[0] ?? null,
    [additives, activeId],
  );

  const [search, setSearch] = useState('');
  const [bankFilter, setBankFilter] = useState<string>('all');

  // ----- Estado visual persistido (por aditivo) -----
  const initialUi = active?.uiState;
  const [showAnalytic, setShowAnalyticState] = useState<boolean>(initialUi?.showAnalytic ?? true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(initialUi?.expandedCompositionIds ?? []));
  const [expandedMemory, setExpandedMemory] = useState<Set<string>>(new Set(initialUi?.expandedMemoryIds ?? []));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(initialUi?.collapsedGroupIds ?? []));

  // Recarrega o estado visual quando muda o aditivo ativo (cada aditivo tem seu próprio estado).
  const lastLoadedIdRef = useRef<string | null>(active?.id ?? null);
  useEffect(() => {
    const id = active?.id ?? null;
    if (id === lastLoadedIdRef.current) return;
    lastLoadedIdRef.current = id;
    const ui = active?.uiState;
    setShowAnalyticState(ui?.showAnalytic ?? true);
    setExpanded(new Set(ui?.expandedCompositionIds ?? []));
    setExpandedMemory(new Set(ui?.expandedMemoryIds ?? []));
    setCollapsed(new Set(ui?.collapsedGroupIds ?? []));
  }, [active?.id, active?.uiState]);

  const persistUi = useCallback((patch: Partial<AdditiveUiState>) => {
    if (!onProjectChange) return;
    const id = active?.id;
    if (!id) return;
    onProjectChange(prev => ({
      ...prev,
      additives: (prev.additives ?? []).map(a =>
        a.id === id
          ? { ...a, uiState: { ...(a.uiState ?? {}), ...patch } }
          : a,
      ),
    }));
  }, [onProjectChange, active?.id]);

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

  const toggleExpandMemory = useCallback((id: string) =>
    setExpandedMemory(prev => {
      // Single-open: abrir uma memória fecha qualquer outra.
      const n = new Set<string>();
      if (!prev.has(id)) n.add(id);
      persistUi({ expandedMemoryIds: Array.from(n) });
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
    expandedMemory, toggleExpandMemory,
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
